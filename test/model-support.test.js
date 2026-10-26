'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(id = 'kl135', data = {}) {
  const root = path.resolve(__dirname, '..');
  const state = {
    clients: [], devices: [], commands: [], timers: new Set(), logs: [], writes: [],
    model: id.toUpperCase() + '(US)', deviceId: 'physical-1', relay: 1, ledOff: 0,
    light: { on_off: 1, brightness: 60, hue: 180, saturation: 50, color_temp: 4000, mode: 'normal' },
    realtime: { power: 8.3 }, data: { id: 'homey-identity', deviceId: 'physical-1', transport: 'tcp', protocol: 'iot', ...data },
  };
  const info = () => ({ deviceId: state.deviceId, model: state.model,
    relay_state: state.relay, led_off: state.ledOff, type: 'IOT.SMARTPLUGSWITCH' });
  const readInfo = async () => {
    state.reads = (state.reads || 0) + 1;
    if (state.infoGate) await state.infoGate.promise;
    if (state.infoError) throw state.infoError;
    return info();
  };
  const hardware = () => {
    const instance = {
      getSysInfo: readInfo,
      closeConnection() { this.closed = true; },
      async setPowerState(value) {
        state.commands.push({ method: 'power', value });
        if (state.commandGate) await state.commandGate.promise;
        if (state.commandError) throw state.commandError;
        if (!state.ignoreCommand) { state.relay = value ? 1 : 0; state.light.on_off = value ? 1 : 0; }
        return true;
      },
      async setLedState(value) {
        state.commands.push({ method: 'led', value });
        if (state.commandError) throw state.commandError;
        state.ledOff = value ? 0 : 1;
        return true;
      },
      lighting: {
        async getLightState() {
          if (state.lightError) throw state.lightError;
          return state.incompleteLight ? {} : { ...state.light };
        },
        async setLightState(value) {
          state.commands.push({ method: 'light', value });
          if (state.commandError) throw state.commandError;
          if (!state.ignoreCommand) Object.assign(state.light, value);
          return true;
        },
      },
      emeter: { async getRealtime() { if (state.energyError) throw state.energyError; return { ...state.realtime }; } },
    };
    state.devices.push(instance);
    return instance;
  };
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; state.clients.push(this); }
    getSysInfo() { return readInfo(); }
    getBulb(options) { state.deviceOptions = options; return hardware(); }
    getPlug(options) { state.deviceOptions = options; return hardware(); }
    startDiscovery(options) { this.discoveryOptions = options; }
    stopDiscovery() { this.stopped = true; }
  }
  const timers = callback => {
    const timer = { callback };
    state.timers.add(timer);
    return timer;
  };
  const cache = new Map();
  const load = filename => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, __dirname: path.dirname(filename),
      require: name => {
        if (name === 'homey') return { Device: class {} };
        if (name === 'tplink-smarthome-api') return { Client };
        const resolved = localRequire.resolve(name);
        return resolved.startsWith(root + '/lib/') ? load(resolved) : localRequire(name);
      },
      setTimeout: timers, clearTimeout: timer => state.timers.delete(timer),
    }, { filename });
    return module.exports;
  };
  const Device = load(path.join(root, 'drivers', id, 'device.js'));
  const device = new Device();
  device.settings = { settingIPAddress: '192.0.2.10', deviceId: 'physical-1', pollingInterval: 10, dynamicIp: false };
  device.values = id === 'kl135' ? { onoff: null, dim: null, light_hue: null, light_saturation: null,
    light_temperature: null, light_mode: null, measure_power: null } : { onoff: null, ledonoff: null };
  device.store = {};
  device.listeners = {};
  Object.assign(device, {
    available: false,
    homey: { app: { getGlobalCredentials: () => state.globalCredentials || null } },
    getSettings() { return { ...this.settings }; },
    getData: () => ({ ...state.data }),
    getStoreValue(key) { return this.store[key]; },
    async setStoreValue(key, value) { this.store[key] = value; },
    getAvailable() { return this.available; },
    async setAvailable() { this.available = true; },
    async setUnavailable(message) { this.available = false; this.reason = message; },
    hasCapability(key) { return Object.hasOwn(this.values, key); },
    getCapabilityValue(key) { return this.values[key]; },
    async setCapabilityValue(key, value) { state.writes.push({ key, value }); this.values[key] = value; },
    async setSettings(settings) { Object.assign(this.settings, settings); },
    registerCapabilityListener(key, listener) { this.listeners[key] = listener; },
    log: value => state.logs.push(String(value)),
  });
  state.device = device;
  return state;
}

test('KL135 reads lighting, colour mode, colour temperature, and real power through local modules', async () => {
  const f = fixture();
  await f.device.onInit();
  assert.equal(f.device.available, true);
  assert.deepEqual(f.device.values, { onoff: true, dim: 0.6, light_hue: 0.5,
    light_saturation: 0.5, light_temperature: 5000 / 6500, light_mode: 'temperature', measure_power: 8.3 });
  assert.equal(f.clients[0].options.defaultSendOptions.transport, 'tcp');
  assert.equal(f.clients[0].options.defaultSendOptions.timeout, 4000);
  assert.equal(f.clients[0].options.credentials, undefined);
  assert.equal(f.deviceOptions.host, '192.0.2.10');
  assert.equal(f.timers.size, 1);
  f.device.onDeleted();
  assert.equal(f.timers.size, 0);
  assert.equal(f.devices[0].closed, true);
});

test('KL135 preserves API units and temperature direction for all native lighting controls', async () => {
  const f = fixture();
  await f.device.onInit();
  await f.device.onCapabilityDim(0.42);
  await f.device.onCapabilityHue(0.25);
  await f.device.onCapabilitySaturation(0.75);
  await f.device.onCapabilityTemperature(1);
  await f.device.onCapabilityMode('color');
  await f.device.onCapabilityDim(0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands)), [
    { method: 'light', value: { brightness: 42, on_off: 1 } },
    { method: 'light', value: { hue: 90, color_temp: 0, mode: 'normal' } },
    { method: 'light', value: { saturation: 75, color_temp: 0, mode: 'normal' } },
    { method: 'light', value: { color_temp: 2500, mode: 'normal' } },
    { method: 'light', value: { color_temp: 0, mode: 'normal' } },
    { method: 'light', value: { on_off: 0 } },
  ]);
  assert.equal(f.device.values.onoff, false);
  assert.equal(f.device.values.light_mode, 'color');
  f.device.onDeleted();
});

test('failed commands reject and successful acknowledgements use reported state rather than optimistic updates', async () => {
  const f = fixture();
  await f.device.onInit();
  f.commandError = new Error('Authentication failed for secret-password');
  f.globalCredentials = { username: 'owner@example.com', password: 'secret-password' };
  await assert.rejects(f.device.onCapabilityOnoff(false), /\[redacted\]/);
  assert.equal(f.device.values.onoff, true);
  assert.equal(f.device.available, false);
  assert.equal(f.logs.some(line => line.includes('secret-password')), false);
  f.commandError = null;
  f.ignoreCommand = true;
  await f.device.onCapabilityOnoff(false);
  assert.equal(f.device.values.onoff, true, 'An acknowledgement cannot invent an observed off state');
  assert.equal(f.device.available, true);
  f.device.onDeleted();
});

test('KS200 supports the relay and shared LED without motion or emeter requests', async () => {
  const f = fixture('ks200');
  await f.device.onInit();
  assert.deepEqual(f.device.values, { onoff: true, ledonoff: true });
  await f.device.onCapabilityOnoff(false);
  await f.device.setLedState('192.0.2.10', undefined, false);
  assert.deepEqual(f.device.values, { onoff: false, ledonoff: false });
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands)), [
    { method: 'power', value: false }, { method: 'led', value: false },
  ]);
  assert.deepEqual(Object.keys(f.device.listeners).sort(), ['ledonoff', 'onoff']);
  f.device.onDeleted();
});

test('persisted KS200 KLAP transport uses the app account and does not silently fall back to TCP', async () => {
  const f = fixture('ks200', { transport: 'klap', protocol: 'iot', port: 8080 });
  f.globalCredentials = { username: 'owner@example.com', password: 'secret-password' };
  f.device.settings.credentialSource = 'global';
  await f.device.onInit();
  assert.equal(f.clients[0].options.defaultSendOptions.transport, 'klap');
  assert.equal(f.clients[0].options.credentials.password, 'secret-password');
  assert.equal(f.deviceOptions.port, 8080);
  f.infoError = new Error('KLAP authentication failed');
  await f.device.pollStatus();
  assert.equal(f.device.available, false);
  assert.equal(f.clients.some(client => client.options.defaultSendOptions.transport === 'tcp'), false);
  f.device.onDeleted();
});

test('authenticated transport requires complete credentials and unsupported bulb protocol stays unavailable', async () => {
  const missing = fixture('ks200', { transport: 'klap' });
  await missing.device.onInit();
  assert.equal(missing.clients.length, 0);
  assert.equal(missing.device.available, false);
  assert.match(missing.device.reason, /complete TP-Link account/);
  missing.device.onDeleted();
  const unsupported = fixture('kl135', { transport: 'klap', protocol: 'smart' });
  await unsupported.device.onInit();
  assert.equal(unsupported.clients.length, 0);
  assert.match(unsupported.device.reason, /unsupported local bulb protocol/);
  unsupported.device.onDeleted();
});

test('changed physical device or a KS200M is never accepted as the paired KS200', async () => {
  for (const mismatch of [{ model: 'KS200M(US)' }, { deviceId: 'other-device' }]) {
    const f = fixture('ks200');
    Object.assign(f, mismatch);
    await f.device.onInit();
    assert.equal(f.device.available, false);
    assert.equal(f.devices.length, 0);
    await assert.rejects(f.device.onCapabilityOnoff(false), /not a KS200|does not match/);
    assert.equal(f.commands.length, 0);
    f.device.onDeleted();
  }
});

test('poll requests are single-flight and deletion prevents late state writes and queued commands', async () => {
  const f = fixture('ks200');
  await f.device.onInit();
  const gate = deferred();
  f.infoGate = gate;
  const beforeReads = f.reads;
  const poll = f.device.pollStatus();
  const duplicate = f.device.pollStatus();
  assert.equal(poll, duplicate);
  await new Promise(setImmediate);
  assert.equal(f.reads, beforeReads + 1);
  const writesBefore = f.writes.length;
  const command = f.device.onCapabilityOnoff(false);
  f.device.onDeleted();
  gate.resolve();
  assert.equal(await poll, false);
  await assert.rejects(command, /connection changed/);
  assert.equal(f.writes.length, writesBefore);
  assert.equal(f.commands.length, 0);
  assert.equal(f.timers.size, 0);
});

test('unreachable polling retains reported values and restores availability on the next confirmed reply', async () => {
  const f = fixture('ks200');
  await f.device.onInit();
  f.infoError = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  await f.device.pollStatus();
  assert.equal(f.device.available, false);
  assert.equal(f.device.values.onoff, true);
  f.infoError = null;
  f.relay = 0;
  await f.device.pollStatus();
  assert.equal(f.device.available, true);
  assert.equal(f.device.values.onoff, false);
  assert.ok(f.clients.length >= 2);
  f.device.onDeleted();
});

test('invalid settings and failed replacement identity preserve the configured endpoint and polling', async () => {
  const f = fixture('ks200');
  await f.device.onInit();
  await assert.rejects(f.device.onSettings({ newSettings: { settingIPAddress: 'bad-address' }, changedKeys: ['settingIPAddress'] }), /valid device IPv4/);
  await assert.rejects(f.device.onSettings({ newSettings: { pollingInterval: 0 }, changedKeys: ['pollingInterval'] }), /between 2 and 60/);
  f.deviceId = 'other-device';
  await assert.rejects(f.device.onSettings({ newSettings: { settingIPAddress: '192.0.2.11' }, changedKeys: ['settingIPAddress'] }), /does not match/);
  assert.equal(f.device.settings.settingIPAddress, '192.0.2.10');
  assert.equal(f.timers.size, 1);
  f.deviceId = 'physical-1';
  await f.device.pollStatus();
  assert.equal(f.device.available, true);
  f.device.onDeleted();
});

test('KL135 power-read failure preserves the last measurement and working lighting', async () => {
  const f = fixture();
  await f.device.onInit();
  f.energyError = new Error('power module timeout');
  f.light.brightness = 27;
  await f.device.pollStatus();
  assert.equal(f.device.available, true);
  assert.equal(f.device.values.dim, 0.27);
  assert.equal(f.device.values.measure_power, 8.3);
  f.incompleteLight = true;
  await f.device.pollStatus();
  assert.equal(f.device.available, false);
  assert.equal(f.device.values.dim, 0.27);
  f.device.onDeleted();
});

test('credential edits reject partial accounts and validate complete overrides against the same device', async () => {
  const f = fixture('ks200', { transport: 'klap', protocol: 'iot' });
  f.globalCredentials = { username: 'owner@example.com', password: 'global-secret' };
  f.device.settings.credentialSource = 'global';
  await f.device.onInit();
  await assert.rejects(f.device.onSettings({ newSettings: { deviceUsername: 'second@example.com' }, changedKeys: ['deviceUsername'] }), /username and password/);
  await f.device.onSettings({ newSettings: { deviceUsername: 'second@example.com', devicePassword: 'override-secret' }, changedKeys: ['deviceUsername', 'devicePassword'] });
  assert.equal(f.device.settings.credentialSource, 'override');
  assert.equal(f.clients.at(-1).options.credentials.username, 'second@example.com');
  assert.equal(f.logs.some(line => line.includes('override-secret')), false);
  f.device.onDeleted();
});

test('polling and IP-recovery preferences remain editable when the device is offline', async () => {
  const f = fixture('ks200');
  await f.device.onInit();
  f.infoError = new Error('connect ETIMEDOUT');
  await f.device.pollStatus();
  const reads = f.reads;
  await f.device.onSettings({ newSettings: { pollingInterval: 30 }, changedKeys: ['pollingInterval'] });
  await f.device.onSettings({ newSettings: { dynamicIp: true }, changedKeys: ['dynamicIp'] });
  assert.equal(f.reads, reads, 'Non-connection settings do not authenticate or contact an offline device');
  assert.equal(f.timers.size, 1);
  f.device.onDeleted();
});

test('settings invalidate an in-flight poll before validating the replacement connection', async () => {
  const f = fixture('ks200');
  await f.device.onInit();
  f.infoGate = deferred();
  const polling = f.device.pollStatus();
  await new Promise(setImmediate);
  const writes = f.writes.length;
  const settings = f.device.onSettings({ newSettings: { settingIPAddress: '192.0.2.11' }, changedKeys: ['settingIPAddress'] });
  f.relay = 0;
  f.infoGate.resolve();
  assert.equal(await polling, false);
  await settings;
  assert.equal(f.writes.length, writes, 'Late old-host readings never update Homey during a settings change');
  f.device.settings.settingIPAddress = '192.0.2.11';
  await f.device.pollStatus();
  assert.equal(f.device.values.onoff, false);
  assert.equal(f.device.available, true);
  f.device.onDeleted();
});

test('global-account refresh waits for the old poll and reconnects using the new complete account', async () => {
  const f = fixture('ks200', { transport: 'klap', protocol: 'iot' });
  f.globalCredentials = { username: 'owner@example.com', password: 'old-secret' };
  f.device.settings.credentialSource = 'global';
  await f.device.onInit();
  f.infoGate = deferred();
  const polling = f.device.pollStatus();
  await new Promise(setImmediate);
  f.globalCredentials = { username: 'owner@example.com', password: 'new-secret' };
  const refresh = f.device.refreshGlobalCredentials();
  f.infoGate.resolve();
  assert.equal(await polling, false);
  assert.equal(await refresh, true);
  assert.equal(f.clients.at(-1).options.credentials.password, 'new-secret');
  assert.equal(f.device.available, true);
  assert.equal(f.logs.some(line => line.includes('old-secret') || line.includes('new-secret')), false);
  f.device.onDeleted();
});

test('dynamic-IP recovery matches exact physical identity and uses isolated discovery sessions', async () => {
  const f = fixture('ks200');
  f.device.settings.dynamicIp = true;
  await f.device.onInit();
  await f.device.discover();
  const client = f.clients.at(-1);
  assert.notEqual(client, f.clients[0]);
  const wrong = { host: '192.0.2.20', deviceId: 'wrong', getSysInfo: async () => ({ model: 'KS200(US)', deviceId: 'wrong' }) };
  client.emit('plug-new', wrong);
  await new Promise(setImmediate);
  assert.equal(f.device.settings.settingIPAddress, '192.0.2.10');
  const correct = { host: '192.0.2.21', port: 8080, deviceId: 'physical-1',
    defaultSendOptions: { transport: 'klap' }, getSysInfo: async () => ({ model: 'KS200(US)', deviceId: 'physical-1', type: 'IOT.SMARTPLUGSWITCH' }) };
  client.emit('plug-new', correct);
  await new Promise(setImmediate);
  assert.equal(f.device.settings.settingIPAddress, '192.0.2.21');
  assert.equal(f.device.store.tplinkConnection.transport, 'klap');
  assert.equal(f.device.store.tplinkConnection.port, 8080);
  assert.equal(client.stopped, true);
  assert.equal(f.device.values.onoff, true, 'Discovery does not invent a replacement status reading');
  f.device.onDeleted();
});

test('clearing global credentials closes cached authenticated access instead of retaining the old account', async () => {
  const f = fixture('ks200', { transport: 'klap', protocol: 'iot' });
  f.globalCredentials = { username: 'owner@example.com', password: 'old-secret' };
  f.device.settings.credentialSource = 'global';
  await f.device.onInit();
  const oldDevice = f.devices[0];
  const clients = f.clients.length;
  f.globalCredentials = null;
  assert.equal(await f.device.refreshGlobalCredentials(), false);
  assert.equal(oldDevice.closed, true);
  assert.equal(f.device.available, false);
  assert.match(f.device.reason, /complete TP-Link account/);
  assert.equal(f.clients.length, clients, 'No unauthenticated fallback or stale authenticated client is used');
  f.device.onDeleted();
});
