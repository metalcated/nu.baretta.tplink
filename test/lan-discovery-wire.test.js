'use strict';

// Real UDP discovery and TCP/XOR validation on loopback, never physical hardware.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const { LanScanner, descriptor } = require('../lib/lan-discovery');

function encode(value) {
  const input = Buffer.from(JSON.stringify(value));
  let key = 0xab;
  return Buffer.from(input.map(byte => { key ^= byte; return key; }));
}

function decode(input) {
  let key = 0xab;
  const plain = Buffer.from(input.map(byte => { const value = key ^ byte; key = byte; return value; }));
  return JSON.parse(plain.toString());
}

test('real UDP discovery and TCP validation find both KP400 outlets through the bundled API', async t => {
  const info = { err_code: 0, deviceId: 'loopback-kp400', model: 'KP400(US)', alias: 'Loopback patio',
    type: 'IOT.SMARTPLUGSWITCH', mac: '00:00:00:00:00:02', hw_ver: '1.0', sw_ver: 'emulated',
    feature: 'TIM', led_off: 0, children: [{ id: '00', alias: 'Patio left', state: 1 },
      { id: '01', alias: 'Patio right', state: 0 }] };
  const response = { system: { get_sysinfo: info } };
  let udpQueries = 0, tcpQueries = 0;
  const udp = dgram.createSocket('udp4');
  const sockets = new Set();
  const tcp = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4 || buffered.length < buffered.readUInt32BE(0) + 4) return;
      const request = decode(buffered.subarray(4, 4 + buffered.readUInt32BE(0)));
      assert.deepEqual(request, { system: { get_sysinfo: {} } });
      tcpQueries++;
      const body = encode(response), header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.end(Buffer.concat([header, body]));
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
    await new Promise(resolve => udp.close(resolve));
  });
  udp.on('message', (message, source) => {
    assert.deepEqual(decode(message), { system: { get_sysinfo: {} } });
    udpQueries++;
    udp.send(encode(response), source.port, source.address);
  });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(9999, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(9999, '127.0.0.1', resolve); });
  const scanner = new LanScanner({ duration: 80 });
  t.after(() => scanner.stop());
  const rows = await scanner.scan([], ['127.0.0.1']);
  assert.ok(udpQueries > 0, 'the real API must send a directed UDP probe');
  assert.ok(tcpQueries > 0, 'a discovery reply must be checked using a real TCP read');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.childId).sort(), ['loopback-kp40000', 'loopback-kp40001']);
  assert.ok(rows.every(row => row.status === 'ready' && row.modelDriver === 'kp400'));
  const selected = rows.map(row => descriptor(row));
  assert.deepEqual(selected.map(device => device.name).sort(), ['Patio left', 'Patio right']);
  assert.ok(selected.every(device => device.data.id === 'loopback-kp400' && device.class === 'socket'));
  const refreshed = await scanner.revalidate(scanner.targets.get(rows[0].key));
  assert.equal(refreshed.key, rows[0].key);
});
