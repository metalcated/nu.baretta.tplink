'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { LanScanner, descriptor, identity, knownDevices, modelDriver, parseAddresses } = require('../lib/lan-discovery');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(devices, { events = Object.keys(devices), read, startError } = {}) {
  const state = { clients: [], reads: [], stops: 0, options: [] };
  class Client extends EventEmitter {
    constructor(options = {}) { super(); this.options = options; state.clients.push(this); }
    async getSysInfo(host, port) {
      state.reads.push({ host, port, options: this.options });
      if (read) return read.call(this, host, port, state);
      const entry = devices[host];
      if (!entry) throw new Error('Device did not respond');
      if (entry.error) throw entry.error;
      return structuredClone(entry.info || entry);
    }
    getPlug({ host, sysInfo }) {
      // Match the API contract: IOT outlet IDs are normalized by the Plug.
      return { children: new Map((sysInfo.children || []).map(child => [
        child.id.length <= 2 ? sysInfo.deviceId + child.id.padStart(2, '0') : child.id, child,
      ])), sendSmartRequests: async () => ({ get_child_device_list: {
        child_device_list: devices[host].smartChildren || [],
      } }) };
    }
    startDiscovery(options) {
      state.options.push(options);
      if (startError) throw startError;
      // Deliberately synchronous: listeners must be in place before starting.
      for (const host of events) {
        const entry = devices[host];
        const info = entry.info || entry;
        const event = String(info.type || '').includes('BULB') ? 'bulb-new' : 'plug-new';
        this.emit(event, { host, sysInfo: structuredClone(info) });
        this.emit(event.replace('-new', '-online'), { host, sysInfo: structuredClone(info) });
      }
    }
    stopDiscovery() { state.stops++; }
  }
  return { Client, state };
}

function info(model, deviceId, extra = {}) {
  return { model, deviceId, alias: model + ' fixture', type: model.startsWith('KL') ? 'IOT.SMARTBULB' : 'IOT.SMARTPLUGSWITCH', ...extra };
}

test('model matching accepts documented aliases and keeps neighboring families separate', () => {
  for (const [model, expected] of [['HS105(US)', 'hs103'], ['KL125(EU)', 'kl130'], ['KL135(US)', 'kl135'],
    ['KS200(US)', 'ks200'], ['KS200M(US)', 'ks200m'], ['KS225', 'ks225'], ['KP400(US)', 'kp400']]) {
    assert.equal(modelDriver(model), expected, model);
  }
  for (const model of ['KS200OTHER', 'KS200-unknown', 'KL1350', 'P110', '../ks225', '', null]) {
    assert.equal(modelDriver(model), null, String(model));
  }
});

test('manual addresses are bounded, unique device IPv4 addresses', () => {
  assert.deepEqual(parseAddresses('192.0.2.1, 192.0.2.2;192.0.2.1\n192.0.2.3'), ['192.0.2.1', '192.0.2.2', '192.0.2.3']);
  assert.deepEqual(parseAddresses(), []);
  for (const value of ['device.example', '192.0.2.1/24', '::1', '0.0.0.0', '255.255.255.255', ['192.0.2.1'],
    Array.from({ length: 65 }, (_, i) => '192.0.2.' + (i + 1)).join(',')]) {
    assert.throws(() => parseAddresses(value), /IPv4 addresses/);
  }
});

test('one scan handles mixed models, immediate events, aliases, duplicate packets and separate outlets', async () => {
  const devices = {
    '192.0.2.1': info('KL135(US)', 'bulb'),
    '192.0.2.2': info('KS200(US)', 'switch'),
    '192.0.2.3': info('HS105(US)', 'plug'),
    '192.0.2.4': info('KP303(US)', 'strip', { children: [
      { id: '00', alias: 'Tree' }, { id: '01', alias: 'Houses' }, { id: '02', alias: 'TV' },
    ] }),
    '192.0.2.5': info('KP400(US)', 'outdoor', { children: [{ id: '00', alias: 'Patio' }, { id: '01', alias: 'Garden' }] }),
  };
  const { Client, state } = fixture(devices);
  const scanner = new LanScanner({ Client, duration: 5, known: new Set([identity('strip', 'strip01')]) });
  const rows = await scanner.scan();
  assert.equal(rows.length, 8);
  assert.equal(state.reads.length, 5, 'one physical read per host despite new/online packets');
  assert.deepEqual(state.options[0].deviceTypes, ['plug', 'bulb']);
  assert.equal(state.options[0].breakoutChildren, false);
  assert.deepEqual(rows.filter(row => row.modelDriver === 'kp303').map(row => row.childId).sort(), ['strip00', 'strip01', 'strip02']);
  assert.equal(rows.find(row => row.childId === 'strip01').status, 'paired');
  assert.ok(rows.every(row => !Object.hasOwn(row, 'target')), 'wire metadata stays server side');
  assert.equal(scanner.targets.size, 8);
  assert.equal(state.clients[0].listenerCount('plug-new'), 0);
});

test('KS240 scan expands only supported fan and light channels with canonical identity', async () => {
  const devices = { '192.0.2.24': { info: info('KS240(US)', 'controller', { type: 'SMART.KASASWITCH',
    mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } }), smartChildren: [
    { device_id: 'fan-child', alias: 'Fan', category: 'kasa.switch.outlet.sub-fan' },
    { device_id: 'light-child', alias: 'Light', category: 'kasa.switch.outlet.sub-dimmer' },
    { device_id: 'unknown-child', category: 'unknown.new.channel' },
  ] } };
  const { Client } = fixture(devices);
  const scanner = new LanScanner({ Client, duration: 5, credentials: { username: 'fixture@example.test', password: 'fixture-password' } });
  const rows = await scanner.scan();
  assert.deepEqual(rows.map(row => row.channelType).sort(), ['fan', 'light']);
  assert.ok(rows.every(row => row.parentId === 'controller' && row.transport === 'klap'));
  const fan = descriptor(rows.find(row => row.channelType === 'fan'), { credentialSource: 'global' });
  assert.equal(fan.data.id, 'fan-child');
  assert.equal(fan.data.parentId, 'controller');
  assert.equal(fan.settings.deviceId, 'controller');
  assert.equal(fan.settings.childId, 'fan-child');
  assert.equal(fan.settings.channelType, 'fan');
  assert.equal(fan.class, 'fan');
});

test('missing accounts and rejected authentication produce explanatory rows without exposing secrets', async () => {
  const devices = { '192.0.2.25': info('KS225(US)', 'dimmer', { type: 'SMART.KASASWITCH',
    mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } }) };
  const withoutAccount = fixture(devices);
  const scanner = new LanScanner({ Client: withoutAccount.Client, duration: 5 });
  const missing = await scanner.scan();
  assert.equal(missing[0].status, 'account');
  assert.equal(withoutAccount.state.reads.length, 0);
  assert.equal(scanner.targets.size, 0);

  const account = { username: 'fixture-owner@example.test', password: 'fixture-secret' };
  const rejected = fixture(devices, { read: async () => { throw new Error(`Authentication rejected for ${account.username}: ${account.password}`); } });
  const wrong = await new LanScanner({ Client: rejected.Client, credentials: account, duration: 5 }).scan();
  assert.equal(wrong[0].status, 'error');
  assert.match(wrong[0].reason, /Authentication rejected/);
  assert.doesNotMatch(JSON.stringify(wrong), /fixture-owner|fixture-secret/);
  assert.equal(rejected.state.reads.length, 1, 'do not retry an authentication rejection');
});

test('unknown models and firmware remain visible but unpairable', async () => {
  const devices = {
    '192.0.2.1': info('P110', 'unknown'),
    '192.0.2.2': info('KS225', 'new-encryption', { mgt_encrypt_schm: { encrypt_type: 'TPAP', http_port: 4433 } }),
  };
  const { Client, state } = fixture(devices);
  const scanner = new LanScanner({ Client, duration: 5 });
  const rows = await scanner.scan();
  assert.equal(rows.find(row => row.model === 'P110').status, 'unsupported');
  assert.equal(rows.find(row => row.model === 'KS225').status, 'error');
  assert.match(rows.find(row => row.model === 'KS225').reason, /protocol.*not supported/);
  assert.equal(state.reads.length, 0);
  assert.equal(scanner.targets.size, 0);
});

test('manual IP targeting uses the API object contract and performs a direct read without UDP replies', async () => {
  const devices = { '192.0.2.25': info('KS200(US)', 'switch') };
  const { Client, state } = fixture(devices, { events: [] });
  const rows = await new LanScanner({ Client, duration: 5 }).scan(['192.0.2.25']);
  assert.deepEqual(state.options[0].devices, [{ host: '192.0.2.25' }]);
  assert.deepEqual(state.reads.map(row => row.host), ['192.0.2.25']);
  assert.equal(rows[0].modelDriver, 'ks200');
  assert.equal(rows[0].status, 'ready');
});

test('encrypted IOT devices preserve protocol and advertised HTTP port through descriptor creation', async () => {
  const devices = { '192.0.2.20': info('KS200(US)', 'switch', {
    mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 8080 },
  }) };
  const { Client, state } = fixture(devices);
  const rows = await new LanScanner({ Client, duration: 5, credentials: { username: 'a@example.test', password: 'fixture' } }).scan();
  const read = state.reads[0];
  assert.equal(read.options.defaultSendOptions.transport, 'klap');
  assert.equal(read.options.defaultSendOptions.protocol, 'iot');
  assert.equal(read.port, 8080);
  const device = descriptor(rows[0], { credentialSource: 'global' });
  assert.equal(device.data.port, 8080);
  assert.equal(device.data.protocol, 'iot');
  assert.equal(device.data.transport, 'klap');
});

test('cancel stops discovery promptly and discards a late successful probe', async () => {
  const pending = deferred();
  const devices = { '192.0.2.1': info('KL135(US)', 'bulb') };
  const { Client, state } = fixture(devices, { read: () => pending.promise });
  const scanner = new LanScanner({ Client, duration: 1000 });
  const scan = scanner.scan();
  scanner.stop();
  assert.deepEqual(await scan, []);
  pending.resolve(devices['192.0.2.1']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanner.rows.size, 0);
  assert.equal(scanner.targets.size, 0);
  assert.ok(state.stops >= 1);
  assert.equal(state.clients[0].listenerCount('plug-new'), 0);
});

test('separate scans use separate clients and one cancellation does not end the other', async () => {
  const { Client, state } = fixture({ '192.0.2.1': info('KS200', 'switch') });
  const first = new LanScanner({ Client, duration: 20 });
  const second = new LanScanner({ Client, duration: 5 });
  const oldScan = first.scan();
  const liveScan = second.scan();
  first.stop();
  assert.deepEqual(await oldScan, []);
  assert.equal((await liveScan)[0].parentId, 'switch');
  assert.notEqual(state.clients[0], state.clients[2]);
});

test('existing simple, multi-outlet, SMART-channel and generic devices share physical duplicate keys', () => {
  const device = (data, settings) => ({ getData: () => data, getSettings: () => settings });
  const homey = { drivers: { getDrivers: () => ({
    kl130: { getDevices: () => [device({ id: 'random-homey-id' }, { deviceId: 'bulb' })] },
    kp303: { getDevices: () => [device({ id: 'strip', childId: 'strip00' }, {})] },
    ks240: { getDevices: () => [device({ id: 'fan', childId: 'fan' }, { deviceId: 'controller' })] },
    kasa: { getDevices: () => [device({ id: 'switch', deviceId: 'switch', modelDriver: 'ks200' }, {})] },
  }) } };
  assert.deepEqual([...knownDevices(homey)].sort(), [identity('bulb'), identity('strip', 'strip00'),
    identity('controller', 'fan'), identity('switch')].sort());
});

test('a selected device is rejected when its physical identity changes after discovery', async () => {
  const devices = { '192.0.2.1': info('KS200', 'original') };
  const { Client } = fixture(devices);
  const scanner = new LanScanner({ Client, duration: 5 });
  await scanner.scan();
  const row = [...scanner.targets.values()][0];
  devices['192.0.2.1'] = info('KS200', 'replacement');
  await assert.rejects(scanner.revalidate(row), /changed/);
});

test('network startup failure is returned as a readable scan result and closes listeners', async () => {
  const { Client, state } = fixture({}, { startError: new Error('UDP unavailable') });
  const rows = await new LanScanner({ Client, duration: 5 }).scan();
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].reason, /UDP unavailable/);
  assert.equal(state.clients[0].listenerCount('error'), 0);
});

test('manual address supports an AES-only model when discovery replies are blocked', async () => {
  const devices = { '192.0.2.50': info('S500D(US)', 'aes-dimmer', { type: 'SMART.KASASWITCH',
    mgt_encrypt_schm: { encrypt_type: 'AES', http_port: 80 } }) };
  const { Client, state } = fixture(devices, { events: [], read: async function (host) {
    const options = this.options.defaultSendOptions;
    if (options.transport !== 'aes' || options.protocol !== 'smart') throw new Error('This local protocol is unavailable');
    return devices[host];
  } });
  const rows = await new LanScanner({ Client, duration: 5, credentials: {
    username: 'fixture@example.test', password: 'fixture-secret',
  } }).scan(['192.0.2.50']);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].modelDriver, 's500d');
  assert.equal(rows[0].transport, 'aes');
  assert.equal(rows[0].protocol, 'smart');
  assert.ok(state.reads.length <= 5, 'manual probing remains bounded');
});

test('manual fallback stops at the first rejected authentication and never tries other transports', async () => {
  const { Client, state } = fixture({}, { events: [], read: async function () {
    if (this.options.defaultSendOptions.transport === 'tcp') throw new Error('Connection refused');
    const error = new Error('Local authentication was rejected');
    error.errorCode = -1501;
    throw error;
  } });
  const rows = await new LanScanner({ Client, duration: 5, credentials: {
    username: 'fixture@example.test', password: 'fixture-secret',
  } }).scan(['192.0.2.50']);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].reason, /authentication was rejected/);
  assert.deepEqual(state.reads.map(read => read.options.defaultSendOptions.transport), ['tcp', 'klap']);
});

test('an empty SMART channel identity cannot become a selectable device', async () => {
  const devices = { '192.0.2.24': { info: info('KS240(US)', 'controller', { type: 'SMART.KASASWITCH',
    mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } }), smartChildren: [
    { device_id: '', alias: 'Invalid channel', category: 'kasa.switch.outlet.sub-fan' },
  ] } };
  const { Client } = fixture(devices);
  const scanner = new LanScanner({ Client, duration: 5, credentials: {
    username: 'fixture@example.test', password: 'fixture-secret',
  } });
  const rows = await scanner.scan();
  assert.equal(rows[0].status, 'error');
  assert.equal(scanner.targets.size, 0);
});

test('cancelling a direct read after broadcast completion settles immediately and ignores a late reply', async () => {
  const gate = deferred();
  const { Client } = fixture({}, { events: [], read: () => gate.promise });
  const scanner = new LanScanner({ Client, duration: 1 });
  const pending = scanner.scan(['192.0.2.1']);
  await new Promise(resolve => setTimeout(resolve, 5));
  scanner.stop();
  assert.deepEqual(await pending, []);
  gate.resolve(info('KS200', 'late-switch'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanner.targets.size, 0);
});

test('the overall scan budget bounds an unresponsive direct read and reports incomplete discovery', async () => {
  const gate = deferred();
  const { Client } = fixture({}, { events: [], read: () => gate.promise });
  const scanner = new LanScanner({ Client, duration: 1, budgetMs: 12 });
  const rows = await scanner.scan(['192.0.2.1']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].reason, /did not reply in time/);
  gate.resolve(info('KS200', 'late-switch'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanner.targets.size, 0);
  scanner.stop();
});
