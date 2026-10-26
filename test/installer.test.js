'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Readable } = require('node:stream');
const { APP_ID, configureRoute, installApp, validateInstallUrl, verifyInstalled } = require('../scripts/install-app.cjs');

test('installation tunnel rejects remote hosts, credentials, paths and redirects before using a login', async () => {
  for (const value of ['http://example.com:4859', 'file:///tmp/homey', 'http://user:secret@localhost',
    'http://localhost/app', 'http://localhost/?token=secret', 'http://localhost/#secret']) {
    assert.throws(() => validateInstallUrl(value));
  }
  const homey = { id: 'selected-homey', sessions: { getSessionMe() { assert.fail('must not authenticate'); } } };
  for (const response of [
    { ok: false, id: 'selected-homey', text: 'true' },
    { ok: true, id: 'other-homey', text: 'true' },
    { ok: true, id: 'selected-homey', text: 'false' },
  ]) {
    await assert.rejects(configureRoute(homey, 'http://host.docker.internal:14859', async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Homey-ID'], 'selected-homey');
      return { ok: response.ok, headers: { get: () => response.id }, text: async () => response.text };
    }), /does not lead to the selected Homey/);
    assert.equal(homey.__baseUrlPromise, undefined);
  }
});

test('a verified tunnel authenticates only after the selected Homey responds', async () => {
  let authenticated = false;
  const homey = { id: 'selected-homey', sessions: { async getSessionMe(options) {
    assert.equal(await homey.__baseUrlPromise, 'http://host.docker.internal:14859');
    assert.equal(options.$cache, false);
    authenticated = true;
  } } };
  await configureRoute(homey, 'http://host.docker.internal:14859', async () => ({
    ok: true, headers: { get: () => homey.id }, text: async () => 'true',
  }));
  assert.equal(authenticated, true);
});

test('an old, disabled, crashed or wrong-identity app cannot satisfy installation verification', async () => {
  for (const change of [{ version: '0.2.47' }, { id: 'com.tplink.kasa' }, { enabled: false }, { crashed: true }, { state: 'crashed' }]) {
    await assert.rejects(verifyInstalled({ version: '0.4.0', getApp: async () => ({
      id: APP_ID, version: '0.4.0', enabled: true, state: 'running', ...change,
    }) }));
  }
});

test('startup verification waits for running and fails a bounded startup timeout', async () => {
  let time = 0;
  let reads = 0;
  const app = await verifyInstalled({ version: '0.4.0', now: () => time,
    sleep: async ms => { time += ms; }, getApp: async () => ({
      id: APP_ID, version: '0.4.0', enabled: true, state: ++reads < 3 ? 'starting' : 'running',
    }) });
  assert.equal(app.state, 'running');
  assert.equal(time, 2000);
  time = 0;
  await assert.rejects(verifyInstalled({ version: '0.4.0', now: () => time, timeoutMs: 2000,
    sleep: async ms => { time += ms; }, getApp: async () => ({ id: APP_ID, version: '0.4.0', state: 'starting' }),
  }), /did not report it running/);
});

test('installer preserves data and propagates a rejected upload before reading the old installed app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-installer-test-'));
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ id: APP_ID, version: '0.4.0' }));
  let packed = false;
  class App {
    async preprocess() {}
    async _validate() { return true; }
    async _getPackStream() { packed = true; return Readable.from(['verified package']); }
  }
  await assert.rejects(installApp({ root, AppClass: App, homey: {
    name: 'Test Homey',
    devkit: { async runApp(options) {
      assert.equal(packed, true);
      assert.equal(options.clean, false);
      assert.equal(options.debug, false);
      assert.deepEqual(options.env, {});
      options.app.destroy();
      throw new Error('Upload denied');
    } },
    apps: { getApp() { assert.fail('an existing app must not hide a failed upload'); } },
  } }), /Upload denied/);
});

test('a different application identity is rejected before preprocessing or upload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-installer-identity-'));
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ id: 'com.tplink.kasa', version: '0.4.0' }));
  class App { constructor() { assert.fail('must not package another app'); } }
  await assert.rejects(installApp({ root, AppClass: App, homey: {} }), /existing application identity/);
});
