'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { getRecovery } = require('../lib/tplink-recovery');
const { fixture: deviceFixture } = require('./helpers/tplink-device-fixture');

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture({ targets = '192.168.181.0/24', dynamicIp = true, app } = {}) {
  const state = { writes: [], logs: [], clients: [], directReads: 0, targets };
  const settings = { settingIPAddress: '192.168.181.104', dynamicIp, deviceId: 'physical-bulb' };
  class Client extends EventEmitter {
    startDiscovery(options) { this.options = options; }
    stopDiscovery() { this.stops = (this.stops || 0) + 1; }
    async getSysInfo() { state.directReads++; throw new Error('Recovery must not sweep TCP targets'); }
  }
  const device = {
    client: {}, unreachableCount: 0, discoverCount: 0,
    getSettings: () => ({ ...settings }),
    getData: () => ({ id: 'existing-homey-identity', childId: 'existing-child' }),
    async setSettings(update) { state.writes.push(update); Object.assign(settings, update); },
    log: line => state.logs.push(line),
    homey: { app: app || { getDiscoverySettings: () => ({ targets: state.targets }) } },
  };
  const recovery = getRecovery(device);
  recovery.initialize();
  const discover = options => recovery.discover({ type: 'bulb', createClient: () => {
    const client = new Client();
    state.clients.push(client);
    return client;
  }, ...options });
  return { state, settings, device, recovery, discover };
}

function candidate(changes = {}) {
  return { host: '192.168.181.108', deviceId: 'physical-bulb', defaultSendOptions: { transport: 'tcp' }, ...changes };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('dynamic-IP recovery includes saved private network hosts as bounded UDP device targets', t => {
  const f = fixture();
  t.after(() => f.recovery.destroy());
  f.discover();
  const client = f.state.clients[0];
  assert.equal(client.options.devices.length, 254);
  assert.deepEqual(client.options.devices[0], { host: '192.168.181.1' });
  assert.deepEqual(client.options.devices.at(-1), { host: '192.168.181.254' });
  assert.deepEqual(client.options.deviceTypes, ['bulb']);
  assert.equal(client.options.breakoutChildren, false);
  assert.equal(client.options.discoveryInterval, 6000, 'one directed UDP round during the five-second receive window');
  assert.equal(client.options.discoveryTimeout, 5000);
  assert.equal(client.options.broadcast, undefined, 'retain the existing local broadcast as well');
  assert.equal(f.state.directReads, 0, 'expanding a network never directly probes its hosts');
});

test('saved networks do not weaken recovery physical-identity filtering or paired identity', async t => {
  const f = fixture();
  t.after(() => f.recovery.destroy());
  const originalData = f.device.getData();
  f.discover();
  const client = f.state.clients[0];
  client.emit('bulb-new', candidate({ deviceId: 'other-bulb' }));
  await flush();
  assert.deepEqual(f.state.writes, []);
  client.emit('bulb-online', candidate());
  client.emit('bulb-new', candidate());
  await flush();
  assert.deepEqual(f.state.writes, [{ settingIPAddress: '192.168.181.108' }]);
  assert.equal(f.settings.deviceId, 'physical-bulb');
  assert.deepEqual(f.device.getData(), originalData);
  assert.equal(client.stops, 1);
  assert.deepEqual(client.eventNames(), []);
});

test('deletion rejects late network-discovery callbacks and releases its listeners', async () => {
  const f = fixture();
  f.discover();
  const client = f.state.clients[0];
  const stale = client.listeners('bulb-new')[0];
  f.recovery.destroy();
  await stale(candidate());
  assert.deepEqual(f.state.writes, []);
  assert.equal(client.stops, 1);
  assert.deepEqual(client.eventNames(), []);
  assert.equal(f.recovery.scan, null);
});

test('late authenticated identity validation after deletion cannot write a recovered address', async () => {
  const f = fixture();
  const pending = deferred();
  f.discover();
  const client = f.state.clients[0];
  client.emit('bulb-new', candidate({ deviceId: 'discovery-hash',
    defaultSendOptions: { transport: 'klap' }, getSysInfo: () => pending.promise }));
  f.recovery.destroy();
  pending.resolve({ deviceId: 'physical-bulb' });
  await flush();
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.recovery.pendingSave, null);
});

test('fixed-IP transport recovery retains only its original exact address despite saved networks', t => {
  const f = fixture({ dynamicIp: false });
  t.after(() => f.recovery.destroy());
  f.discover({ allowFixedIp: true });
  const client = f.state.clients[0];
  assert.deepEqual(client.options.devices, [{ host: '192.168.181.104' }]);
  assert.equal(client.options.broadcast, '192.168.181.104');
  assert.equal(client.options.discoveryInterval, 1000, 'fixed-IP transport recovery keeps the existing cadence');
  client.emit('bulb-new', candidate());
  assert.deepEqual(f.state.writes, [], 'another address is rejected even with the same physical identity');
});

test('fixed-IP devices without transport-recovery permission never start a network scan', () => {
  const f = fixture({ dynamicIp: false });
  f.discover();
  assert.equal(f.state.clients.length, 0);
  assert.equal(f.recovery.scan, null);
});

test('empty or unavailable saved settings preserve the original broadcast-only recovery', t => {
  for (const options of [{ targets: '' }, { app: {} }]) {
    const f = fixture(options);
    t.after(() => f.recovery.destroy());
    f.discover();
    assert.equal(f.state.clients[0].options.devices, undefined);
    assert.equal(f.state.clients[0].options.broadcast, undefined);
    assert.equal(f.state.clients[0].options.discoveryInterval, 1000);
  }
});

test('invalid saved settings do not escape their scope and leave broadcast recovery available', t => {
  const f = fixture({ targets: '192.168.0.0/16' });
  t.after(() => f.recovery.destroy());
  f.discover();
  assert.equal(f.state.clients[0].options.devices, undefined);
  assert.equal(f.state.clients[0].options.broadcast, undefined);
  assert.equal(f.state.clients[0].options.discoveryInterval, 1000);
  assert.match(f.state.logs.join(' '), /Unable to read saved discovery networks/);
  assert.equal(f.state.directReads, 0);
});

test('a later recovery attempt reads the current saved scope instead of retaining a stale network', t => {
  const f = fixture();
  t.after(() => f.recovery.destroy());
  f.discover();
  f.recovery.stopDiscovery();
  f.state.targets = '192.168.181.104';
  f.discover();
  assert.deepEqual(f.state.clients[1].options.devices, [{ host: '192.168.181.104' }]);
  f.recovery.stopDiscovery();
  f.state.targets = '';
  f.discover();
  assert.equal(f.state.clients[2].options.devices, undefined);
});

test('saved-network recovery retains the existing one-attempt-per-minute device cooldown', async () => {
  const f = deviceFixture('hs110');
  f.device.homey.app.getDiscoverySettings = () => ({ targets: '192.168.181.0/24' });
  f.error = new Error('TCP Timeout after 10000ms');
  await f.poll(3);
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[1].discoveryOptions.devices.length, 254);
  assert.equal(f.clients[1].discoveryOptions.discoveryInterval, 6000);
  f.expireScan();
  f.now = 59999;
  await f.poll(5);
  assert.equal(f.clients.length, 2);
  f.now = 60000;
  await f.poll();
  assert.equal(f.clients.length, 3);
  assert.equal(f.clients[2].discoveryOptions.devices.length, 254);
  f.device.onDeleted();
  assert.equal(f.timers.size, 0);
});
