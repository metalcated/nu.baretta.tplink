'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');
const { LanScanner } = require('../lib/lan-discovery');
const { parseTargets } = require('../lib/lan-targets');

function loadFresh(filename, stubs) {
  const resolved = require.resolve(filename);
  const previous = require.cache[resolved];
  const original = Module._load;
  delete require.cache[resolved];
  Module._load = function load(request, parent, main) {
    return Object.hasOwn(stubs, request) ? stubs[request] : original.call(this, request, parent, main);
  };
  try { return require(resolved); } finally {
    Module._load = original;
    delete require.cache[resolved];
    if (previous) require.cache[resolved] = previous;
  }
}

function discoveryFixture({ respond = [] } = {}) {
  const state = { discovery: [], reads: [], stops: 0 };
  const devices = {
    '192.168.181.102': { model: 'KP400(US)', deviceId: 'outdoor-parent', type: 'IOT.SMARTPLUGSWITCH', alias: 'Outdoor',
      children: [{ id: 'outdoor-parent00', alias: 'Patio' }, { id: 'outdoor-parent01', alias: 'Garden' }] },
    '192.168.181.104': { model: 'KL135(US)', deviceId: 'bulb-parent', type: 'IOT.SMARTBULB', alias: 'Bulb' },
  };
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    startDiscovery(options) {
      state.discovery.push(options);
      for (const host of respond) this.emit(devices[host].type.includes('BULB') ? 'bulb-new' : 'plug-new',
        { host, sysInfo: structuredClone(devices[host]) });
    }
    stopDiscovery() { state.stops++; }
    async getSysInfo(host) {
      state.reads.push(host);
      if (!devices[host]) throw new Error('No device reply');
      return structuredClone(devices[host]);
    }
    getPlug({ sysInfo }) { return { children: new Map((sysInfo.children || []).map(child => [child.id, child])) }; }
  }
  return { Client, state };
}

function appFixture(initial = {}) {
  const App = loadFresh('../app', { homey: { App: class {} }, 'tplink-smarthome-api': { Client: class {} } });
  const stored = new Map(Object.entries(initial));
  const writes = [];
  const app = new App();
  app.homey = { settings: {
    get: key => stored.get(key),
    set: (key, value) => { writes.push({ key, value }); stored.set(key, value); },
  } };
  return { app, stored, writes };
}

async function pairingFixture(app) {
  const scans = [];
  class Scanner {
    constructor() { this.targets = new Map(); }
    async scan(addresses, discoveryHosts) { scans.push({ addresses, discoveryHosts }); return []; }
    stop() { this.cancelled = true; }
  }
  const discovery = require('../lib/lan-discovery');
  const { LanDriver } = loadFresh('../lib/lan-pairing', {
    homey: { Driver: class {} }, './lan-discovery': { ...discovery, LanScanner: Scanner },
  });
  app.getGlobalCredentials = () => null;
  const driver = new LanDriver();
  driver.homey = { app, drivers: { getDrivers: () => ({}) } };
  const handlers = new Map();
  await driver.onPair({ setHandler: (event, handler) => handlers.set(event, handler) });
  return { scans, handlers };
}

test('saved private CIDR hosts become directed UDP targets and only responding devices get TCP validation', async () => {
  const targets = parseTargets('192.168.181.0/24');
  const { Client, state } = discoveryFixture({ respond: ['192.168.181.102', '192.168.181.104'] });
  const scanner = new LanScanner({ Client, duration: 5 });
  const rows = await scanner.scan(targets.addresses, targets.discoveryHosts);
  assert.equal(state.discovery[0].devices.length, 254);
  assert.deepEqual(state.discovery[0].devices[0], { host: '192.168.181.1' });
  assert.deepEqual(state.discovery[0].devices.at(-1), { host: '192.168.181.254' });
  assert.ok(!state.discovery[0].devices.some(target => target.host.endsWith('.0') || target.host.endsWith('.255')));
  assert.deepEqual(state.reads.sort(), ['192.168.181.102', '192.168.181.104']);
  assert.equal(rows.length, 3, 'the responding outdoor plug contributes two outlets, plus the bulb');
  assert.ok(rows.every(row => row.status === 'ready'));
});

test('a network with no UDP responses never turns into a TCP or HTTP sweep', async () => {
  const targets = parseTargets('192.168.181.0/24');
  const { Client, state } = discoveryFixture();
  const rows = await new LanScanner({ Client, duration: 5 }).scan(targets.addresses, targets.discoveryHosts);
  assert.equal(state.discovery[0].devices.length, 254);
  assert.deepEqual(state.reads, []);
  assert.deepEqual(rows, []);
});

test('an explicit individual IP retains direct fallback while adjacent CIDR hosts remain UDP only', async () => {
  const targets = parseTargets('192.168.181.0/24, 192.168.181.104');
  const { Client, state } = discoveryFixture();
  const rows = await new LanScanner({ Client, duration: 5 }).scan(targets.addresses, targets.discoveryHosts);
  assert.equal(state.discovery[0].devices.length, 254, 'overlapping individual/network UDP targets are unique');
  assert.deepEqual(state.reads, ['192.168.181.104']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelDriver, 'kl135');
});

test('blank scan input uses targets saved in the app database without rewriting them', async () => {
  const { app, stored, writes } = appFixture({ kasaDiscoveryTargets: '192.168.181.0/24' });
  const { handlers, scans } = await pairingFixture(app);
  assert.deepEqual(await handlers.get('get_discovery_settings')(), { targets: '192.168.181.0/24' });
  await handlers.get('scan')({});
  await handlers.get('scan')({ addresses: ' \n ' });
  assert.equal(scans.length, 2);
  for (const scan of scans) {
    assert.deepEqual(scan.addresses, []);
    assert.equal(scan.discoveryHosts.length, 254);
    assert.ok(scan.discoveryHosts.includes('192.168.181.102'));
  }
  assert.equal(stored.get('kasaDiscoveryTargets'), '192.168.181.0/24');
  assert.deepEqual(writes, []);
});

test('one-off pairing target override does not replace the saved network', async () => {
  const { app, stored, writes } = appFixture({ kasaDiscoveryTargets: '192.168.181.0/24' });
  const { handlers, scans } = await pairingFixture(app);
  await handlers.get('scan')({ addresses: '192.168.181.104' });
  assert.deepEqual(scans[0], { addresses: ['192.168.181.104'], discoveryHosts: ['192.168.181.104'] });
  assert.equal(stored.get('kasaDiscoveryTargets'), '192.168.181.0/24');
  assert.deepEqual(writes, []);
  await handlers.get('scan')({});
  assert.equal(scans[1].discoveryHosts.length, 254, 'the next blank scan returns to saved scope');
});

test('saving targets validates completely before changing the existing database setting', () => {
  const { app, stored, writes } = appFixture({ kasaDiscoveryTargets: '192.168.181.0/24' });
  for (const targets of ['192.168.181.0/16', '8.8.8.0/24', '192.168.181.0/24, not-an-address', null, 42, {}, undefined]) {
    assert.throws(() => app.saveDiscoverySettings({ targets }), undefined, String(targets));
    assert.equal(stored.get('kasaDiscoveryTargets'), '192.168.181.0/24');
  }
  assert.deepEqual(writes, []);
});

test('an explicit empty targets string clears the saved network and returns to broadcast-only scanning', async () => {
  const { app, stored } = appFixture({ kasaDiscoveryTargets: '192.168.181.0/24' });
  assert.deepEqual(app.saveDiscoverySettings({ targets: '' }), { targets: '' });
  assert.equal(stored.get('kasaDiscoveryTargets'), '');
  const { handlers, scans } = await pairingFixture(app);
  await handlers.get('scan')({});
  assert.deepEqual(scans, [{ addresses: [], discoveryHosts: [] }]);
});

test('discovery settings API exposes normalized scope and saves through the validated app methods', async () => {
  const api = require('../api');
  const { app, stored } = appFixture();
  const homey = { app };
  assert.deepEqual(await api.getDiscoverySettings({ homey }), { targets: '' });
  assert.deepEqual(await api.saveDiscoverySettings({ homey, body: { targets: '192.168.181.104; 192.168.181.123/24' } }),
    { targets: '192.168.181.104, 192.168.181.0/24' });
  assert.equal(stored.get('kasaDiscoveryTargets'), '192.168.181.104, 192.168.181.0/24');
  await assert.rejects(api.saveDiscoverySettings({ homey, body: { targets: '192.168.181.0/8' } }));
  assert.equal(stored.get('kasaDiscoveryTargets'), '192.168.181.104, 192.168.181.0/24');
  const declarations = require('../app.json').api;
  assert.equal(declarations.getDiscoverySettings.method, 'GET');
  assert.equal(declarations.saveDiscoverySettings.method, 'POST');
});

test('a missing API targets field cannot silently erase the existing network scope', async () => {
  const api = require('../api');
  const { app, stored, writes } = appFixture({ kasaDiscoveryTargets: '192.168.181.0/24' });
  await assert.rejects(api.saveDiscoverySettings({ homey: { app }, body: {} }));
  assert.equal(stored.get('kasaDiscoveryTargets'), '192.168.181.0/24');
  assert.deepEqual(writes, []);
});
