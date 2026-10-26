'use strict';

const path = require('node:path');
const fs = require('node:fs');
const APP_ID = 'nu.baretta.tplink';

async function verifyInstalled({ getApp, version, appId = APP_ID, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 30000 }) {
  const until = now() + timeoutMs;
  do {
    const app = await getApp();
    if (!app || app.version !== version) throw new Error('Homey did not install the expected KASA LAN version.');
    if (app.id !== appId) throw new Error('Homey did not return the expected KASA LAN application identity.');
    if (app.crashed || app.state === 'crashed') throw new Error('KASA LAN failed to start. Check its Homey app log.');
    if (app.enabled === false) throw new Error('The installed KASA LAN app is disabled.');
    if (app.state === 'running') return app;
    await sleep(1000);
  } while (now() < until);
  throw new Error('KASA LAN was installed but Homey did not report it running in time.');
}

function validateInstallUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The installation override must be a localhost tunnel address without credentials or a path.');
  }
  return url.origin;
}

async function configureRoute(homey, value, fetchImpl = fetch) {
  if (!value) return;
  const origin = validateInstallUrl(value);
  const response = await fetchImpl(`${origin}/api/manager/system/ping?id=${encodeURIComponent(homey.id)}`, {
    headers: { 'X-Homey-ID': homey.id }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || response.headers.get('x-homey-id') !== homey.id || (await response.text()).trim() !== 'true') {
    throw new Error('The tunnel does not lead to the selected Homey.');
  }
  // The pinned CLI supports a per-instance route; keep tokens inside its store.
  homey.__baseUrlPromise = Promise.resolve(origin);
  await homey.sessions.getSessionMe({ $cache: false, $socket: false });
}

function readManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  if (manifest.id !== APP_ID || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('The installer requires a versioned KASA LAN manifest with its existing application identity.');
  }
  return manifest;
}

async function installApp({ homey, root = path.resolve(__dirname, '..'), AppClass }) {
  const expected = readManifest(root);
  const App = AppClass || require('homey/lib/App');
  const app = new App(root);
  await app.preprocess();
  if (await app._validate() !== true) throw new Error('The KASA LAN app did not pass Homey validation.');
  const manifest = readManifest(root);
  if (manifest.version !== expected.version) throw new Error('The app version changed during packaging.');
  const archive = await app._getPackStream();
  console.log(`Installing KASA LAN ${manifest.version} on ${homey.name}`);
  // Preserve community app data. Official-app migration and pairing are separate.
  const uploaded = await homey.devkit.runApp({ app: archive, env: {}, debug: false, clean: false });
  if (!uploaded || uploaded.appId !== manifest.id) throw new Error('Homey did not acknowledge the expected KASA LAN installation.');
  const installed = await verifyInstalled({ version: manifest.version, appId: manifest.id,
    getApp: () => homey.apps.getApp({ id: manifest.id, $cache: false, $socket: false }) });
  console.log(`Verified KASA LAN ${installed.version}: running on ${homey.name}`);
  return installed;
}

async function main() {
  const api = require('homey/services/AthomApi');
  const homey = await api.getActiveHomey();
  if (process.env.HOMEY_ID && homey.id !== process.env.HOMEY_ID) {
    throw new Error('The selected Homey does not match HOMEY_ID. Select the intended Homey and retry.');
  }
  await configureRoute(homey, process.env.HOMEY_INSTALL_URL);
  await installApp({ homey });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { APP_ID, verifyInstalled, validateInstallUrl, configureRoute, readManifest, installApp };
