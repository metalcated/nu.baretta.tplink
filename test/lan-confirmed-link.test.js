'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const discovery = require('../lib/lan-discovery');

const credentials = { username: 'fixture@example.test', password: 'fixture-secret' };

function fixture(model = 'KS200', { port, advertised = false } = {}) {
  const state = { reads: [], finalizations: 0 };
  const host = '192.0.2.20';
  const info = { model: model + '(US)', deviceId: 'physical-' + model,
    type: model.startsWith('KL') ? 'IOT.SMARTBULB' : model === 'KS225' ? 'SMART.KASASWITCH' : 'IOT.SMARTPLUGSWITCH',
    relay_state: 1, led_off: 0 };
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    async getSysInfo(address, targetPort) {
      const options = this.options.defaultSendOptions;
      state.reads.push({ host: address, port: targetPort, transport: options?.transport, protocol: options?.protocol });
      const protocol = model === 'KS225' ? 'smart' : 'iot';
      if (options?.transport !== 'klap' || options.protocol !== protocol || (port && targetPort !== port)) {
        throw new Error('This local protocol is unavailable');
      }
      // Authenticated IOT get_sysinfo omits discovery's encryption scheme metadata.
      return { ...info };
    }
    startDiscovery() {
      if (advertised) this.emit('plug-new', { host, sysInfo: { ...info,
        mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: port || 80 } } });
    }
    stopDiscovery() {}
  }
  return { Client, state, info, host };
}

function pairingDriver(f) {
  const filename = path.resolve(__dirname, '../lib/lan-pairing.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  class Scanner extends discovery.LanScanner {
    constructor(options) { super({ ...options, Client: f.Client, duration: 1 }); }
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: name => name === 'homey' ? { Driver: class {} }
      : name === './lan-discovery' ? { ...discovery, LanScanner: Scanner } : localRequire(name),
  }, { filename });
  const driver = new module.exports.LanDriver();
  driver.homey = {
    drivers: { getDrivers: () => ({}) },
    app: {
      getGlobalCredentials: () => credentials,
      async finalizePairingCredentials() {
        f.state.finalizations++;
        return { settings: { credentialSource: 'global', deviceUsername: '', devicePassword: '' } };
      },
    },
  };
  return driver;
}

for (const model of ['KS200', 'HS200', 'HS210', 'HS220', 'EP10', 'KL135']) {
  test(model + ' manual KLAP/IOT discovery retains the confirmed wire protocol during revalidation', async () => {
    const f = fixture(model);
    const scanner = new discovery.LanScanner({ Client: f.Client, duration: 1, credentials });
    const rows = await scanner.scan([f.host]);
    assert.equal(rows[0].status, 'ready');
    assert.equal(rows[0].transport, 'klap');
    assert.equal(rows[0].protocol, 'iot');
    assert.deepEqual(f.state.reads.map(item => item.transport + ':' + item.protocol), ['tcp:iot', 'klap:smart', 'klap:iot']);
    const row = scanner.targets.get(rows[0].key);
    assert.equal(row.target.info.mgt_encrypt_schm, undefined);
    const validated = await scanner.revalidate(row);
    assert.equal(validated.key, row.key);
    assert.deepEqual(f.state.reads.at(-1), { host: f.host, port: undefined, transport: 'klap', protocol: 'iot' });
    assert.equal(f.state.reads.length, 4, 'Revalidation reuses the successful route instead of retrying TCP');
    scanner.stop();
  });
}

test('bulk prepare retains confirmed KLAP/IOT routing when the device response omits encryption metadata', async () => {
  const f = fixture('KS200');
  const driver = pairingDriver(f);
  const handlers = new Map();
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  const rows = await handlers.get('scan')({ addresses: f.host });
  assert.equal(rows[0].status, 'ready');
  const prepared = await handlers.get('prepare_devices')([rows[0].key]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].device.data.transport, 'klap');
  assert.equal(prepared[0].device.data.protocol, 'iot');
  assert.equal(prepared[0].device.settings.credentialSource, 'global');
  assert.equal(f.state.finalizations, 1);
  assert.equal(f.state.reads.at(-1).transport, 'klap');
  assert.equal(f.state.reads.at(-1).protocol, 'iot');
  handlers.get('disconnect')();
});

test('KS225 on a nonstandard HTTP port remains unpairable when its existing runtime cannot use that port', async () => {
  const f = fixture('KS225', { port: 8080, advertised: true });
  const scanner = new discovery.LanScanner({ Client: f.Client, duration: 1, credentials });
  const rows = await scanner.scan();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].reason, /nonstandard local port/);
  assert.equal(scanner.targets.size, 0, 'An unsupported runtime must not become a selectable device');
  assert.equal(f.state.reads[0].port, 8080);
  scanner.stop();
});

test('KS200 on an advertised nonstandard port preserves that port through scan, bulk verification, and descriptor', async () => {
  const f = fixture('KS200', { port: 8080, advertised: true });
  const driver = pairingDriver(f);
  const handlers = new Map();
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  const rows = await handlers.get('scan')({});
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].port, 8080);
  const prepared = await handlers.get('prepare_devices')([rows[0].key]);
  assert.equal(prepared[0].device.data.port, 8080);
  assert.equal(prepared[0].device.data.transport, 'klap');
  assert.equal(prepared[0].device.data.protocol, 'iot');
  assert.ok(f.state.reads.every(read => read.port === 8080));
  handlers.get('disconnect')();
});
