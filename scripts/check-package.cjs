'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { createRequire } = require('node:module');
const { APP_ID, installApp } = require('./install-app.cjs');

const root = path.resolve(__dirname, '..');

function archiveEntries(archive) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    assert(Number.isSafeInteger(size) && size >= 0, 'The package contains an invalid archive entry');
    assert(offset + 512 + size <= archive.length, 'The package contains a truncated archive entry');
    entries.set((prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ''), archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function verifyArchive(entries, manifest) {
  const files = [...entries.keys()];
  for (const required of ['app.json', 'app.js', 'api.js', 'assets/icon.svg', 'LICENSE',
    'lib/tplink-auth.js', 'lib/tplink-credentials.js', 'lib/tplink-recovery.js',
    'settings/index.html', 'node_modules/tplink-smarthome-api/package.json']) {
    assert(entries.has(required), `Missing runtime file: ${required}`);
  }
  const shippedManifest = JSON.parse(entries.get('app.json').toString());
  assert.equal(shippedManifest.id, APP_ID, 'The archive must preserve the community application identity');
  assert.equal(shippedManifest.version, manifest.version, 'The archive must match this checkout version');
  assert.deepEqual(shippedManifest.drivers.map(driver => driver.id), manifest.drivers.map(driver => driver.id), 'The archive must include all declared drivers');
  for (const id of ['kasa', 'kl135', 'ks200', 'kp400', 'ks225']) {
    assert(shippedManifest.drivers.some(driver => driver.id === id), `Required Kasa driver is missing: ${id}`);
  }
  for (const driver of manifest.drivers) {
    for (const kind of ['pair', 'repair']) {
      for (const view of (driver[kind] || []).filter(view => !view.template)) {
        const filename = `drivers/${driver.id}/${kind}/${view.id}.html`;
        assert(entries.has(filename), `The ${kind} view is missing: ${filename}`);
      }
    }
    for (const filename of ['driver.js', 'device.js']) {
      assert(entries.has(`drivers/${driver.id}/${filename}`), `Driver runtime is missing: ${driver.id}/${filename}`);
    }
  }
  assert(!files.some(file => /^(test|scripts|docs|vendor|graft|\.homeybuild|\.github|\.git|\.homey|\.vscode)\//.test(file)), 'Development files entered the runtime archive');
  assert(!files.some(file => /^node_modules\/(sharp|homey-api|inquirer|dockerode|typescript|tsx|eslint|@types)\//.test(file)), 'Installer or development dependencies entered the runtime archive');
  for (const excluded of ['Dockerfile', '.dockerignore', '.gitignore', '.homeyignore', '.ignore', '.npmrc', '.env', 'env.json', 'package-lock.json', 'eslint.config.js', 'tplink-smarthome-commands.txt']) {
    assert(!entries.has(excluded), `${excluded} must not enter the runtime archive`);
  }
  const shimFiles = ['index.js', 'package.json'];
  assert(files.filter(file => file.startsWith('node_modules/homey/')).every(file =>
    file === 'node_modules/homey/' || shimFiles.some(name => file === `node_modules/homey/${name}`)), 'Only the Homey runtime shim may enter the package');
  const shimTemplate = path.join(path.dirname(require.resolve('homey/package.json')), 'assets/homey');
  for (const filename of shimFiles) {
    const entry = `node_modules/homey/${filename}`;
    assert(entries.has(entry), `The Homey runtime shim is missing: ${filename}`);
    assert(entries.get(entry).equals(fs.readFileSync(path.join(shimTemplate, filename))), 'The Homey runtime shim differs from the pinned CLI template');
  }
  const runtimeRequire = createRequire(path.join(root, '.homeybuild', 'app.js'));
  const { Client } = runtimeRequire('tplink-smarthome-api');
  assert.equal(typeof Client, 'function', 'The packaged TP-Link API must load with its production dependencies');
  const runtimePackage = JSON.parse(entries.get('node_modules/tplink-smarthome-api/package.json'));
  assert.equal(runtimePackage.version, '5.0.4', 'The packaged TP-Link API must match the pinned vendored build');
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  let checked = false;
  await installApp({ root, homey: {
    name: 'Packaging verification',
    apps: { async getApp() { return { id: manifest.id, version: manifest.version, state: 'running', enabled: true }; } },
    devkit: { async runApp({ app: stream, clean, debug }) {
      assert.equal(clean, false);
      assert.equal(debug, false);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const archive = gunzipSync(Buffer.concat(chunks));
      const entries = archiveEntries(archive);
      verifyArchive(entries, manifest);
      assert(archive.length < 40 * 1024 * 1024, 'The runtime archive is unexpectedly large');
      console.log(`Verified installation archive: ${entries.size} entries, ${archive.length} bytes unpacked`);
      checked = true;
      return { appId: manifest.id };
    } },
  } });
  assert(checked, 'The actual upload archive was not verified');
  await assert.rejects(installApp({ root, homey: {
    name: 'Rejected upload verification',
    devkit: { async runApp({ app: stream }) { stream.destroy(); throw new Error('Intentional upload rejection'); } },
    apps: { getApp() { assert.fail('An existing app must not hide an upload rejection'); } },
  } }), /Intentional upload rejection/);
  console.log('Upload rejection propagates before runtime verification');
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { archiveEntries, verifyArchive };
