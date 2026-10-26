'use strict';

const Homey = require('homey');
const { LanScanner, knownDevices, parseAddresses, descriptor } = require('./lan-discovery');
const { assertValidCredentialPair, resolvePairingCredentials, getPairedCredentialSettings } = require('./tplink-credentials');
const manifest = require('../app.json');

class LanDriver extends Homey.Driver {
  onMapDeviceClass(device) {
    const id = device.getData().modelDriver;
    if (!manifest.drivers.some(driver => driver.id === id && id !== 'kasa')) {
      throw new Error('This device has no supported local model.');
    }
    return require(`../drivers/${id}/device`);
  }

  async onPair(session) {
    let scanner = null;
    let resolution = null;
    let generation = 0;
    let open = true;
    let preparing = false;
    const stop = () => { generation++; if (scanner) scanner.stop(); scanner = null; };

    session.setHandler('get_credential_status', async () => {
      const app = this.homey.app;
      return typeof app.getCredentialStatus === 'function' ? app.getCredentialStatus() : { configured: false };
    });
    session.setHandler('scan', async (input = {}) => {
      if (!open) throw new Error('Pairing is closed.');
      if (preparing) throw new Error('Wait for the selected devices to finish verification.');
      const addresses = parseAddresses(input.addresses || '');
      const supplied = assertValidCredentialPair(input, { required: false });
      const global = this.homey.app.getGlobalCredentials();
      stop();
      const current = generation;
      resolution = supplied || global
        ? resolvePairingCredentials(input, global) : null;
      scanner = new LanScanner({ credentials: resolution?.credentials,
        known: knownDevices(this.homey), onlyModel: this.modelFilter || null });
      const active = scanner;
      const rows = await active.scan(addresses);
      if (!open || current !== generation) return [];
      return rows;
    });
    session.setHandler('prepare_devices', async (keys = []) => {
      if (!open || !scanner || scanner.cancelled) throw new Error('Scan for devices before adding them.');
      if (preparing) throw new Error('Device verification is already running.');
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 128 || keys.some(key => typeof key !== 'string')) {
        throw new Error('Select at least one device to add.');
      }
      const current = generation;
      const active = scanner;
      const known = knownDevices(this.homey);
      let selected = [...new Set(keys)].map(key => {
        const row = active.targets.get(key);
        if (!row || row.status !== 'ready') throw new Error('A selection is not part of the current scan. Scan again.');
        return row;
      }).filter(row => !known.has(row.key));
      preparing = true;
      try {
        // Validate every selected physical device before persisting any account.
        // Share one read per physical parent even when several outlets are added.
        const parents = new Map();
        for (const row of selected) {
          const key = row.parentId;
          if (!parents.has(key)) parents.set(key, row);
        }
        const queue = [...parents];
        const results = new Map();
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length) {
            if (!open || current !== generation) throw new Error('Pairing changed during verification.');
            const [key, row] = queue.shift();
            results.set(key, await active.probe(row.host, row.target.info, Infinity, {
              transport: row.transport, protocol: row.protocol, ...(row.port ? { port: row.port } : {}),
            }));
          }
        }));
        for (const row of selected) {
          const rows = results.get(row.parentId);
          if (!Array.isArray(rows) || !rows.some(item => item.key === row.key && item.modelDriver === row.modelDriver)) {
            throw new Error('A selected device or outlet changed. Scan again before adding it.');
          }
        }
        if (!open || current !== generation) throw new Error('Pairing changed during verification. Scan again.');
        const latestKnown = knownDevices(this.homey);
        selected = selected.filter(row => !latestKnown.has(row.key));
        let settings = {};
        if (selected.some(row => row.transport !== 'tcp')) {
          if (!resolution) throw new Error('Enter the TP-Link account and scan again.');
          const finalized = typeof this.homey.app.finalizePairingCredentials === 'function'
            ? await this.homey.app.finalizePairingCredentials(resolution)
            : { settings: getPairedCredentialSettings(resolution) };
          settings = finalized.settings;
        }
        if (!open || current !== generation) throw new Error('Pairing was closed during verification.');
        return selected.map(row => ({ key: row.key,
          device: descriptor(row, row.transport === 'tcp' ? {} : settings) }));
      } finally { preparing = false; }
    });
    session.setHandler('cancel', () => { open = false; stop(); });
    session.setHandler('disconnect', () => { open = false; stop(); });
  }
}

module.exports = { LanDriver };
