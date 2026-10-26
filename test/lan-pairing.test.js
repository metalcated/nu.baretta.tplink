'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const discovery = require('../lib/lan-discovery');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function withModules(stubs, operation) {
  const original = Module._load;
  Module._load = function load(request, parent, main) {
    return Object.hasOwn(stubs, request) ? stubs[request] : original.call(this, request, parent, main);
  };
  try { return operation(); } finally { Module._load = original; }
}

function loadFresh(filename, stubs) {
  const path = require.resolve(filename);
  const previous = require.cache[path];
  delete require.cache[path];
  try { return withModules(stubs, () => require(path)); } finally {
    delete require.cache[path];
    if (previous) require.cache[path] = previous;
  }
}

function row(parentId, modelDriver = 'ks200', extra = {}) {
  const childId = extra.childId || '';
  const result = { parentId, childId, modelDriver, model: modelDriver.toUpperCase(),
    key: discovery.identity(parentId, childId), name: modelDriver + ' fixture', host: '192.0.2.1',
    status: 'ready', transport: 'tcp', protocol: 'iot', ...extra };
  result.target = { info: { model: result.model, deviceId: parentId } };
  return result;
}

async function harness({ rows = [row('switch')], scan, probe, globalCredentials = null, finalize } = {}) {
  const state = { scanners: [], calls: [], paired: [], finalizations: [] };
  class Scanner {
    constructor(options) {
      this.options = options;
      this.cancelled = false;
      this.targets = new Map(rows.map(item => [item.key, item]));
      state.scanners.push(this);
    }
    async scan(addresses) {
      state.calls.push({ type: 'scan', addresses, scanner: this });
      return scan ? scan.call(this, state) : rows.map(({ target, ...item }) => item);
    }
    async probe(host, info) {
      state.calls.push({ type: 'probe', host, info, scanner: this });
      return probe ? probe.call(this, host, info, state) : rows.filter(item => item.parentId === info.deviceId);
    }
    stop() { this.cancelled = true; state.calls.push({ type: 'stop', scanner: this }); }
  }
  const { LanDriver } = loadFresh('../lib/lan-pairing', {
    homey: { Driver: class {} }, './lan-discovery': { ...discovery, LanScanner: Scanner },
  });
  const app = {
    getGlobalCredentials: () => globalCredentials,
    getCredentialStatus: () => ({ configured: Boolean(globalCredentials) }),
    async finalizePairingCredentials(resolution) {
      state.calls.push({ type: 'finalize' });
      state.finalizations.push(resolution);
      return finalize ? finalize(resolution, state) : { settings: { credentialSource: 'global' } };
    },
  };
  const driver = new LanDriver();
  driver.homey = { app, drivers: { getDrivers: () => ({ existing: { getDevices: () => state.paired } }) } };
  const handlers = new Map();
  const session = { setHandler: (name, callback) => handlers.set(name, callback) };
  await driver.onPair(session);
  return { driver, handlers, state, app, LanDriver };
}

test('mixed selection returns model-specific controls and independent outlets in one batch', async () => {
  const rows = [row('bulb', 'kl135'), row('switch'),
    row('strip', 'kp303', { childId: 'strip00', name: 'Tree' }),
    row('strip', 'kp303', { childId: 'strip01', name: 'TV' })];
  const { handlers, state } = await harness({ rows });
  await handlers.get('scan')({ addresses: '192.0.2.1' });
  const devices = await handlers.get('prepare_devices')(rows.map(item => item.key));
  assert.equal(devices.length, 4);
  assert.equal(state.calls.filter(call => call.type === 'probe').length, 3, 'outlets share one physical parent verification');
  const bulb = devices.find(item => item.device.data.modelDriver === 'kl135').device;
  assert.ok(bulb.capabilities.includes('light_hue'));
  assert.ok(bulb.capabilities.includes('measure_power'));
  assert.equal(bulb.class, 'light');
  const outlets = devices.filter(item => item.device.data.modelDriver === 'kp303');
  assert.deepEqual(outlets.map(item => item.device.data.childId), ['strip00', 'strip01']);
  assert.equal(state.finalizations.length, 0, 'TCP-only pairing does not save an unused account');
});

test('selections are server-bound and cannot inject an address, model or capability list', async () => {
  const { handlers, state } = await harness();
  await handlers.get('scan')({});
  await assert.rejects(handlers.get('prepare_devices')([{ key: discovery.identity('switch'),
    host: '192.0.2.99', modelDriver: 'ks225', capabilities: ['lock'] }]), /Select at least/);
  await assert.rejects(handlers.get('prepare_devices')([discovery.identity('invented')]), /not part of the current scan/);
  await assert.rejects(handlers.get('prepare_devices')([]), /Select at least/);
  await assert.rejects(handlers.get('prepare_devices')(Array.from({ length: 129 }, () => 'x')), /Select at least/);
  assert.equal(state.calls.filter(call => call.type === 'probe').length, 0);
  assert.equal(state.finalizations.length, 0);
});

test('all selected targets revalidate before the account can be persisted', async () => {
  const rows = [row('first', 'ks225', { host: '192.0.2.1', transport: 'klap', protocol: 'smart' }),
    row('second', 'ks225', { host: '192.0.2.2', transport: 'klap', protocol: 'smart' })];
  const gate = deferred();
  const { handlers, state } = await harness({ rows, probe: async (_host, info) => {
    if (info.deviceId === 'second') return gate.promise;
    return rows.filter(item => item.parentId === info.deviceId);
  } });
  await handlers.get('scan')({ username: 'fixture@example.test', password: 'fixture-secret' });
  const prepared = handlers.get('prepare_devices')(rows.map(item => item.key));
  assert.equal(state.calls.filter(call => call.type === 'probe').length, 2);
  assert.equal(state.finalizations.length, 0);
  gate.resolve([rows[1]]);
  const result = await prepared;
  assert.equal(result.length, 2);
  assert.equal(state.finalizations.length, 1);
  assert.equal(state.calls.at(-1).type, 'finalize');
  assert.ok(result.every(item => item.device.settings.credentialSource === 'global'));
});

test('failed verification of one target leaves account settings untouched for the whole batch', async () => {
  const rows = [row('first', 'ks225', { transport: 'klap', protocol: 'smart' }),
    row('second', 'ks225', { host: '192.0.2.2', transport: 'klap', protocol: 'smart' })];
  const { handlers, state } = await harness({ rows, probe: async (_host, info) => {
    if (info.deviceId === 'second') throw new Error('Device stopped responding');
    return [rows[0]];
  } });
  await handlers.get('scan')({ username: 'fixture@example.test', password: 'fixture-secret' });
  await assert.rejects(handlers.get('prepare_devices')(rows.map(item => item.key)), /stopped responding/);
  assert.equal(state.finalizations.length, 0);
});

test('replacement physical devices and removed child outlets cannot be added from an old scan', async () => {
  const outlet = row('strip', 'kp303', { childId: 'strip01' });
  const { handlers, state } = await harness({ rows: [outlet], probe: async () => [row('strip', 'kp303', { childId: 'strip00' })] });
  await handlers.get('scan')({});
  await assert.rejects(handlers.get('prepare_devices')([outlet.key]), /changed/);
  assert.equal(state.finalizations.length, 0);
});

test('rescan cancels the old scanner and stale completion cannot replace the newer results', async () => {
  const old = deferred();
  const currentRows = [{ key: 'new-scan', status: 'ready' }];
  const { handlers, state } = await harness({ scan: function () {
    return state.scanners.length === 1 ? old.promise : currentRows;
  } });
  const first = handlers.get('scan')({});
  const second = handlers.get('scan')({ addresses: '192.0.2.2' });
  assert.deepEqual(await second, currentRows);
  assert.equal(state.scanners[0].cancelled, true);
  old.resolve([{ key: 'stale-scan', status: 'ready' }]);
  assert.deepEqual(await first, []);
  assert.equal(state.scanners[1].cancelled, false);
});

for (const event of ['cancel', 'disconnect']) {
  test(event + ' discards in-flight scan results and blocks further pairing', async () => {
    const pending = deferred();
    const { handlers, state } = await harness({ scan: () => pending.promise });
    const scan = handlers.get('scan')({});
    handlers.get(event)();
    pending.resolve([{ key: 'late-result', status: 'ready' }]);
    assert.deepEqual(await scan, []);
    assert.equal(state.scanners[0].cancelled, true);
    await assert.rejects(handlers.get('scan')({}), /closed/);
    await assert.rejects(handlers.get('prepare_devices')([discovery.identity('switch')]), /Scan for devices/);
  });

  test(event + ' during target verification prevents account persistence and device creation', async () => {
    const pending = deferred();
    const selected = row('dimmer', 'ks225', { transport: 'klap', protocol: 'smart' });
    const { handlers, state } = await harness({ rows: [selected], probe: () => pending.promise });
    await handlers.get('scan')({ username: 'fixture@example.test', password: 'fixture-secret' });
    const prepare = handlers.get('prepare_devices')([selected.key]);
    handlers.get(event)();
    pending.resolve([selected]);
    await assert.rejects(prepare, /changed during verification/);
    assert.equal(state.finalizations.length, 0);
  });
}

test('overlapping verification and rescanning are rejected while an existing batch is being verified', async () => {
  const pending = deferred();
  const selected = row('switch');
  const { handlers } = await harness({ rows: [selected], probe: () => pending.promise });
  await handlers.get('scan')({});
  const prepare = handlers.get('prepare_devices')([selected.key]);
  await assert.rejects(handlers.get('prepare_devices')([selected.key]), /already running/);
  await assert.rejects(handlers.get('scan')({}), /finish verification/);
  pending.resolve([selected]);
  assert.equal((await prepare).length, 1);
});

test('already-paired devices and repeated keys are not returned as duplicate creations', async () => {
  const rows = [row('first'), row('second')];
  const { handlers, state } = await harness({ rows });
  await handlers.get('scan')({});
  state.paired.push({ getData: () => ({ id: 'old-random-id' }), getSettings: () => ({ deviceId: 'first' }) });
  const prepared = await handlers.get('prepare_devices')([rows[0].key, rows[1].key, rows[1].key]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].device.data.id, 'second');
});

test('separate pairing sessions hold separate selection and cancellation state', async () => {
  const first = await harness();
  const second = await harness();
  await first.handlers.get('scan')({});
  await second.handlers.get('scan')({});
  first.handlers.get('cancel')();
  assert.equal((await second.handlers.get('prepare_devices')([discovery.identity('switch')])).length, 1);
  assert.equal(second.state.scanners[0].cancelled, false);
});

test('mapping returns the registered model class and rejects unsupported/path-injected models', async () => {
  const { driver } = await harness();
  class BulbRuntime {}
  class SwitchRuntime {}
  withModules({ '../drivers/kl135/device': BulbRuntime, '../drivers/ks200/device': SwitchRuntime }, () => {
    assert.equal(driver.onMapDeviceClass({ getData: () => ({ modelDriver: 'kl135' }) }), BulbRuntime);
    assert.equal(driver.onMapDeviceClass({ getData: () => ({ modelDriver: 'ks200' }) }), SwitchRuntime);
  });
  for (const modelDriver of ['kasa', '../../app', 'invented', undefined]) {
    assert.throws(() => driver.onMapDeviceClass({ getData: () => ({ modelDriver }) }), /no supported local model/);
  }
});

test('generic authenticated devices participate in global account management using their model', () => {
  const App = loadFresh('../app', { homey: { App: class {} }, 'tplink-smarthome-api': { Client: class {} } });
  const app = new App();
  const device = (id, modelDriver, transport) => ({
    getData: () => ({ id, modelDriver, transport }),
    getSettings: () => ({ settingIPAddress: '192.0.2.1', credentialSource: 'global' }),
    getStoreValue: () => undefined,
  });
  app.homey = { drivers: { getDrivers: () => ({ kasa: { id: 'kasa', getDevices: () => [
    device('one', 'ks225', 'klap'), device('two', 'ks200', 'klap'), device('three', 'kl135', 'tcp'),
  ] } }) } };
  app.error = () => {};
  const entries = app.getManagedDevices();
  assert.ok(entries.some(entry => entry.driverId === 'ks225'));
  assert.ok(entries.some(entry => entry.driverId === 'ks200'));
  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length);
});

test('large selected batches keep simultaneous physical verification bounded to four parents', async () => {
  const rows = Array.from({ length: 9 }, (_, index) => row('parent-' + index, 'ks200', { host: '192.0.2.' + (index + 1) }));
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const { handlers } = await harness({ rows, probe: async (_host, info) => {
    active++;
    peak = Math.max(active, peak);
    await gate.promise;
    active--;
    return rows.filter(item => item.parentId === info.deviceId);
  } });
  await handlers.get('scan')({});
  const prepared = handlers.get('prepare_devices')(rows.map(item => item.key));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(peak <= 4, `started ${peak} simultaneous parent reads`);
  } finally {
    gate.resolve();
    assert.equal((await prepared).length, 9);
  }
});

test('a device paired by another session during verification is not returned for duplicate creation', async () => {
  const selected = row('switch');
  const pending = deferred();
  const { handlers, state } = await harness({ rows: [selected], probe: () => pending.promise });
  await handlers.get('scan')({});
  const prepared = handlers.get('prepare_devices')([selected.key]);
  state.paired.push({ getData: () => ({ id: 'other-session-id', modelDriver: 'ks200' }),
    getSettings: () => ({ deviceId: 'switch' }) });
  pending.resolve([selected]);
  assert.deepEqual(await prepared, []);
});

function controller({ rows = [], scanError, create } = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.textContent = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.open = false;
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const state = { emits: [], creations: [], done: 0 };
  const Homey = {
    setTitle() {},
    done() { state.done++; },
    async emit(name, input) {
      state.emits.push({ name, input });
      if (name === 'get_credential_status') return { configured: false };
      if (name === 'scan') {
        if (scanError) throw scanError;
        return structuredClone(rows);
      }
      if (name === 'prepare_devices') return input.map(key => ({ key,
        device: { name: rows.find(item => item.key === key).name, data: { id: key } } }));
      throw new Error('Unexpected Homey event: ' + name);
    },
    async createDevice(device) {
      state.creations.push(device);
      return create ? create(device, state) : {};
    },
  };
  const html = fs.readFileSync(path.resolve(__dirname, '../drivers/kasa/pair/start.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document: { getElementById: element, createElement: tag => new Element(tag) }, Homey },
    { filename: 'kasa-pairing-controller.js' });
  return { element, state };
}

test('pairing controller select-all includes only ready devices and treats aliases as text', async () => {
  const rows = [
    { key: 'bulb', name: '<img src=x onerror=alert(1)>', model: 'KL135', host: '192.0.2.1', status: 'ready' },
    { key: 'switch', name: 'Switch', model: 'KS200', host: '192.0.2.2', status: 'ready' },
    { key: 'existing', name: 'Existing plug', model: 'HS103', host: '192.0.2.3', status: 'paired' },
    { key: 'unsupported', name: 'Unknown model', model: 'P110', host: '192.0.2.4', status: 'unsupported' },
  ];
  const { element, state } = controller({ rows });
  await element('scan').onclick();
  const firstName = element('results').children[0].children[0].children[1].children[0];
  assert.equal(firstName.textContent, rows[0].name);
  element('select-all').checked = true;
  element('select-all').onchange();
  assert.equal(element('count').textContent, '2 selected');
  assert.equal(element('add').disabled, false);
  await element('add').onclick();
  assert.deepEqual(state.creations.map(item => item.name), [rows[0].name, rows[1].name]);
  assert.equal(element('count').textContent, '0 selected');
  assert.equal(element('add').disabled, true);
});

test('partial Homey creation leaves failures selected and retry never recreates successful devices', async () => {
  const rows = [{ key: 'bulb', name: 'Bulb', model: 'KL135', host: '192.0.2.1', status: 'ready' },
    { key: 'outlet', name: 'Outlet', model: 'KP303', host: '192.0.2.2', status: 'ready' }];
  let failed = false;
  const { element, state } = controller({ rows, create: async device => {
    if (device.name === 'Outlet' && !failed) { failed = true; throw new Error('Temporary add failure'); }
    return {};
  } });
  await element('scan').onclick();
  element('select-all').checked = true;
  element('select-all').onchange();
  await element('add').onclick();
  assert.equal(element('count').textContent, '1 selected');
  assert.equal(element('add').disabled, false);
  assert.equal(element('issue').open, true);
  assert.match(element('issue-text').textContent, /Outlet/);
  element('close-issue').onclick();
  assert.equal(element('issue').open, false);
  await element('add').onclick();
  assert.deepEqual(state.creations.map(item => item.name), ['Bulb', 'Outlet', 'Outlet']);
  assert.equal(element('count').textContent, '0 selected');
  assert.match(element('status').textContent, /^2 added/);
  assert.equal(element('add').disabled, true);
  element('done').onclick();
  assert.equal(state.done, 1);
});

test('scan failure opens an in-page modal and re-enables scan controls', async () => {
  const { element, state } = controller({ scanError: new Error('Network scan could not start') });
  await element('scan').onclick();
  assert.equal(element('issue').open, true);
  assert.equal(element('issue-text').textContent, 'Network scan could not start');
  assert.equal(element('scan').disabled, false);
  assert.equal(element('username').disabled, false);
  assert.equal(element('password').disabled, false);
  assert.equal(element('addresses').disabled, false);
  assert.equal(element('add').disabled, true);
  assert.equal(state.creations.length, 0);
});

for (const field of ['username', 'password', 'addresses']) {
  test('editing ' + field + ' invalidates scan selections before another add', async () => {
    const { element, state } = controller({ rows: [{ key: 'switch', name: 'Switch', model: 'KS200',
      host: '192.0.2.1', status: 'ready' }] });
    await element('scan').onclick();
    element('select-all').checked = true;
    element('select-all').onchange();
    assert.equal(element('count').textContent, '1 selected');
    element(field).value = field === 'addresses' ? '192.0.2.99' : 'updated-fixture-value';
    element(field).oninput();
    assert.equal(element('results').children.length, 0);
    assert.equal(element('count').textContent, '0 selected');
    assert.equal(element('add').disabled, true);
    assert.match(element('status').textContent, /Scan again/);
    assert.equal(state.creations.length, 0);
    assert.equal(state.emits.filter(event => event.name === 'prepare_devices').length, 0);
  });
}
