'use strict';

// Loopback protocol emulation exercises the real bundled API; it is not physical-device acceptance.
const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function encode(value) {
  const source = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(source.length + 4);
  result.writeUInt32BE(source.length);
  let key = 0xab;
  for (let i = 0; i < source.length; i++) {
    key ^= source[i];
    result[i + 4] = key;
  }
  return result;
}

function decode(buffer) {
  const plain = Buffer.alloc(buffer.length);
  let key = 0xab;
  for (let i = 0; i < buffer.length; i++) {
    plain[i] = key ^ buffer[i];
    key = buffer[i];
  }
  return JSON.parse(plain.toString('utf8'));
}

async function emulator(t, model) {
  const state = {
    model, id: 'emulated-physical-' + model, requests: [], rejectCommands: false,
    light: { on_off: 1, brightness: 65, hue: 120, saturation: 80, color_temp: 0, mode: 'normal' },
    relay: 1, ledOff: 0,
  };
  const info = () => ({
    err_code: 0, alias: 'Emulated ' + model, deviceId: state.id, model: model + '(US)',
    sw_ver: '1.0.15 emulated', hw_ver: '1.0', mac: '00:00:00:00:00:01',
    ...(model === 'KL135' ? {
      mic_type: 'IOT.SMARTBULB', mic_mac: '000000000001', description: 'Emulated colour bulb',
      is_dimmable: 1, is_color: 1, is_variable_color_temp: 1, light_state: { ...state.light },
    } : { type: 'IOT.SMARTPLUGSWITCH', feature: 'TIM', relay_state: state.relay, led_off: state.ledOff }),
  });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (pending.length < 4 || pending.length < pending.readUInt32BE() + 4) return;
      const command = decode(pending.subarray(4, 4 + pending.readUInt32BE()));
      state.requests.push(command);
      const response = {};
      for (const [module, methods] of Object.entries(command)) {
        if (module === 'context') continue;
        response[module] = {};
        for (const [method, params] of Object.entries(methods)) {
          let result = { err_code: 0 };
          if (method === 'get_sysinfo') result = info();
          else if (method === 'get_light_state') result = { err_code: 0, ...state.light };
          else if (method === 'get_realtime') result = { err_code: 0, power_mw: 8300, total_wh: 42 };
          else if (state.rejectCommands) result = { err_code: -1, err_msg: 'Emulated command rejection' };
          else if (method === 'transition_light_state') {
            Object.assign(state.light, params);
            result = { err_code: 0, ...state.light };
          } else if (method === 'set_relay_state') state.relay = params.state;
          else if (method === 'set_led_off') state.ledOff = params.off;
          else result = { err_code: -1, err_msg: 'Unsupported emulated method' };
          response[module][method] = result;
        }
      }
      socket.end(encode(response));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  state.port = server.address().port;
  return state;
}

function homeyDevice(t, model, server) {
  const root = path.resolve(__dirname, '..');
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
        const resolved = localRequire.resolve(name);
        return resolved.startsWith(root + '/lib/') ? load(resolved) : localRequire(name);
      },
      setTimeout, clearTimeout,
    }, { filename });
    return module.exports;
  };
  const Device = load(path.join(root, 'drivers', model.toLowerCase(), 'device.js'));
  const device = new Device();
  device.settings = { settingIPAddress: '127.0.0.1', deviceId: server.id, pollingInterval: 10, dynamicIp: false };
  device.values = model === 'KL135' ? { onoff: null, dim: null, light_hue: null, light_saturation: null,
    light_temperature: null, light_mode: null, measure_power: null } : { onoff: null, ledonoff: null };
  Object.assign(device, {
    available: false,
    homey: { app: { getGlobalCredentials: () => null } },
    getData: () => ({ id: 'homey-' + model, deviceId: server.id, transport: 'tcp', protocol: 'iot', port: server.port }),
    getSettings() { return { ...this.settings }; },
    getStoreValue() {},
    getAvailable() { return this.available; },
    async setAvailable() { this.available = true; },
    async setUnavailable(reason) { this.available = false; this.reason = reason; },
    hasCapability(key) { return Object.hasOwn(this.values, key); },
    getCapabilityValue(key) { return this.values[key]; },
    async setCapabilityValue(key, value) { this.values[key] = value; },
    registerCapabilityListener() {}, log() {},
  });
  t.after(() => device.onDeleted());
  return device;
}

test('KL135 real TCP/XOR API reads watts and applies lighting, mode, transition, and on/off commands', async t => {
  const server = await emulator(t, 'KL135');
  const device = homeyDevice(t, 'KL135', server);
  await device.onInit();
  assert.equal(device.available, true, device.reason);
  assert.equal(device.values.measure_power, 8.3, 'API milliwatts are normalized to Homey watts');
  assert.equal(device.values.light_mode, 'color');
  await device.onCapabilityDim(0.4);
  await device.onCapabilityHue(0.5);
  await device.onCapabilitySaturation(0.3);
  await device.onCapabilityTemperature(0);
  assert.equal(device.values.dim, 0.4);
  assert.equal(device.values.light_hue, 0.5);
  assert.equal(device.values.light_saturation, 0.3);
  assert.equal(device.values.light_temperature, 0);
  assert.equal(device.values.light_mode, 'temperature');
  await device.onCapabilityMode('color');
  await device.circadianModeOn();
  await device.circadianModeOff();
  await device.offTransition('127.0.0.1', 500);
  assert.equal(device.values.onoff, false);
  await device.onCapabilityOnoff(true);
  assert.equal(device.values.onoff, true);
  assert.ok(server.requests.some(request => request['smartlife.iot.common.emeter']?.get_realtime));
  assert.ok(server.requests.some(request => request['smartlife.iot.smartbulb.lightingservice']?.transition_light_state?.transition_period === 500));
  assert.equal(server.requests.some(request => Object.keys(request).some(key => /cloud/.test(key))), false,
    'All tested reads and controls stay on local device modules');
});

test('KS200 real TCP/XOR API sends relay/LED commands, rejects device errors, and retains physical identity', async t => {
  const server = await emulator(t, 'KS200');
  const device = homeyDevice(t, 'KS200', server);
  await device.onInit();
  assert.equal(device.available, true, device.reason);
  await device.onCapabilityOnoff(false);
  await device.onCapabilityLedOnoff(false);
  assert.equal(device.values.onoff, false);
  assert.equal(device.values.ledonoff, false);
  assert.ok(server.requests.some(request => request.system?.set_relay_state?.state === 0));
  assert.ok(server.requests.some(request => request.system?.set_led_off?.off === 1));
  server.rejectCommands = true;
  await assert.rejects(device.onCapabilityOnoff(true), /Emulated command rejection/);
  assert.equal(device.values.onoff, false);
  assert.equal(device.available, false);
  server.rejectCommands = false;
  await device.pollStatus();
  assert.equal(device.available, true);
  server.id = 'different-physical-device';
  await assert.rejects(device.onCapabilityOnoff(true), /does not match the paired device/);
  assert.equal(device.values.onoff, false);
});
