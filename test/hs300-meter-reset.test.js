'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, flush } = require('./helpers/tplink-device-fixture');

function meterFixture() {
  const f = fixture('hs300');
  f.sysInfo = { children: [{ id: 'child-1', state: 1 }, { id: 'child-2', state: 0 }] };
  f.totals = { 'child-1': 12.5, 'child-2': 41.75 };
  f.meterReads = [];
  f.clients[0].getPlug = options => {
    f.lastPlugOptions = options;
    return { emeter: {
      getRealtime: async (...args) => {
        assert.equal(args.length, 0, 'The child is scoped at getPlug, not passed as sendOptions');
        f.meterReads.push({ host: options.host, childId: options.childId });
        if (f.infoError) throw f.infoError;
        return { total: f.totals[options.childId], power: 20, voltage: 230, current: 0.1 };
      },
      eraseStats() { assert.fail('Homey offset resets must not erase physical-device statistics'); },
    } };
  };
  return f;
}

test('HS300 reset uses the fresh per-outlet absolute kWh total and repeated resets remain correct', async () => {
  const f = meterFixture();
  f.device.values.meter_power = 999;
  assert.equal(await f.device.meter_reset('192.0.2.10'), true);
  assert.equal(f.device.totalOffset, 12.5);
  assert.equal(f.device.settings.totalOffset, 12.5);
  assert.equal(f.device.values.meter_power, 0);
  assert.deepEqual(f.meterReads, [{ host: '192.0.2.10', childId: 'child-1' }]);
  f.totals['child-1'] = 13.25;
  await f.device.getStatus();
  assert.equal(f.device.values.meter_power, 0.75);
  await f.device.meter_reset('192.0.2.10');
  assert.equal(f.device.totalOffset, 13.25, 'A second reset replaces the absolute offset, rather than the displayed difference');
  f.totals['child-1'] = 13.5;
  await f.device.getStatus();
  assert.equal(f.device.values.meter_power, 0.25);
  assert.deepEqual(f.writes.map(write => write.totalOffset), [12.5, 13.25]);
});

test('HS300 undo restores the absolute outlet total and remains undone after polling', async () => {
  const f = meterFixture();
  await f.device.meter_reset('192.0.2.10');
  f.totals['child-1'] = 14;
  assert.equal(await f.device.undo_meter_reset('192.0.2.10'), true);
  assert.equal(f.device.totalOffset, 0);
  assert.equal(f.device.settings.totalOffset, 0);
  assert.equal(f.device.values.meter_power, 14);
  f.totals['child-1'] = 14.5;
  await f.device.getStatus();
  assert.equal(f.device.values.meter_power, 14.5);
  await f.device.undo_meter_reset('192.0.2.10');
  assert.equal(f.device.values.meter_power, 14.5);
});

test('HS300 offset reset stays isolated to its paired outlet', async () => {
  const f = meterFixture();
  const second = f.makeDevice();
  second.getData = () => ({ id: 'same-strip', childId: 'child-2' });
  second.values.meter_power = 41.75;
  await f.device.meter_reset('192.0.2.10');
  assert.equal(second.totalOffset, 0);
  assert.equal(second.settings.totalOffset, undefined);
  assert.equal(second.values.meter_power, 41.75);
  await second.meter_reset('192.0.2.10');
  assert.equal(second.totalOffset, 41.75);
  assert.equal(f.device.totalOffset, 12.5);
  assert.deepEqual(f.meterReads.map(read => read.childId), ['child-1', 'child-2']);
});

for (const operation of ['meter_reset', 'undo_meter_reset']) {
  test(`HS300 ${operation} rejects read and persistence failures without changing the existing offset`, async () => {
    const f = meterFixture();
    f.device.totalOffset = 8;
    f.device.settings.totalOffset = 8;
    f.device.values.meter_power = 4.5;
    for (const failure of ['error', 'infoError', 'saveError']) {
      f[failure] = new Error('Intentional ' + failure);
      await assert.rejects(f.device[operation]('192.0.2.10'), /Intentional/);
      assert.equal(f.device.totalOffset, 8);
      assert.equal(f.device.settings.totalOffset, 8);
      assert.equal(f.device.values.meter_power, 4.5);
      assert.equal(f.writes.length, 0);
      f[failure] = null;
    }
  });

  test(`HS300 ${operation} rejects missing, negative and non-finite outlet totals`, async () => {
    const f = meterFixture();
    f.device.totalOffset = 8;
    f.device.settings.totalOffset = 8;
    for (const total of [undefined, null, '12.5', -1, Infinity, NaN]) {
      f.totals['child-1'] = total;
      await assert.rejects(f.device[operation]('192.0.2.10'), /valid energy total/);
      assert.equal(f.device.totalOffset, 8);
      assert.equal(f.device.settings.totalOffset, 8);
      assert.equal(f.writes.length, 0);
    }
  });

  test(`HS300 ${operation} persists the new offset before changing its live counter`, async () => {
    const f = meterFixture();
    f.device.totalOffset = 8;
    f.device.settings.totalOffset = 8;
    f.device.values.meter_power = 4.5;
    let release;
    f.saveGate = new Promise(resolve => { release = resolve; });
    const pending = f.device[operation]('192.0.2.10');
    await flush();
    assert.equal(f.device.totalOffset, 8);
    assert.equal(f.device.values.meter_power, 4.5);
    release();
    await pending;
    assert.equal(f.device.totalOffset, operation === 'meter_reset' ? 12.5 : 0);
    assert.equal(f.device.values.meter_power, operation === 'meter_reset' ? 0 : 12.5);
  });
}

test('HS300 reset and undo reject an unpaired parent instead of operating on all outlets', async () => {
  const f = meterFixture();
  f.device.getData = () => ({ id: 'strip-without-outlet' });
  await assert.rejects(f.device.meter_reset('192.0.2.10'), /paired outlet/);
  await assert.rejects(f.device.undo_meter_reset('192.0.2.10'), /paired outlet/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.meterReads.length, 0);
});

test('the pinned API normalizes per-outlet watt-hours to kWh before reset calculations', async () => {
  const Emeter = require('tplink-smarthome-api/lib/shared/emeter').default;
  const meter = new Emeter({
    emit() {},
    async sendCommand(command, childId) {
      assert.deepEqual(command, { emeter: { get_realtime: {} } });
      assert.equal(childId, 'child-1');
      return { err_code: 0, total_wh: 12500, power_mw: 2000 };
    },
  }, 'emeter', 'child-1');
  assert.equal((await meter.getRealtime()).total, 12.5);
});
