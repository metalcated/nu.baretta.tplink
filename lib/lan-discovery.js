'use strict';

const { isIP } = require('node:net');
const manifest = require('../app.json');
const { getSafeErrorMessage, isAuthenticationError } = require('./tplink-credentials');

const ALIASES = Object.freeze({ HS105: 'hs103', KL125: 'kl130' });
const AUTH_MODELS = Object.freeze({ ks225: 'klap', s500d: 'aes', ks240: 'aes' });
const DUAL_MODELS = new Set(['ep10', 'hs200', 'hs210', 'hs220', 'ks200', 'kl135']);
const MULTI_MODELS = new Set(['hs107', 'hs300', 'kp200', 'kp303', 'kp400', 'ep40']);
const BULK_DRIVER = 'kasa';

function modelDriver(model) {
  const match = String(model || '').toUpperCase().match(/^([A-Z]+[0-9]+[A-Z0-9]*)(?:\s|\(|$)/);
  if (!match) return null;
  const id = ALIASES[match[1]] || match[1].toLowerCase();
  return id !== BULK_DRIVER && manifest.drivers.some(driver => driver.id === id) ? id : null;
}

function parseAddresses(value = '') {
  if (typeof value !== 'string') throw new Error('Enter device IPv4 addresses separated by commas or spaces.');
  const addresses = [...new Set(value.split(/[\s,;]+/).filter(Boolean))];
  if (addresses.length > 64 || addresses.some(host => isIP(host) !== 4 || host === '0.0.0.0' || host === '255.255.255.255')) {
    throw new Error('Enter up to 64 individual device IPv4 addresses.');
  }
  return addresses;
}

function connection(info, id) {
  const encryption = String(info.mgt_encrypt_schm?.encrypt_type || '').toLowerCase();
  const transport = encryption || AUTH_MODELS[id] || 'tcp';
  if (!['tcp', 'aes', 'klap'].includes(transport)) throw new Error('This firmware uses a local protocol that is not supported yet.');
  if (transport !== 'tcp' && !AUTH_MODELS[id] && !DUAL_MODELS.has(id)) {
    throw new Error('This model’s encrypted firmware needs additional local support.');
  }
  const type = String(info.type || info.mic_type || '');
  const protocol = type.startsWith('IOT.') || transport === 'tcp' ? 'iot' : 'smart';
  if (id === 'kl135' && protocol !== 'iot') throw new Error('This bulb firmware uses a local protocol that is not supported yet.');
  const port = info.mgt_encrypt_schm?.http_port;
  return { transport, protocol, ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}) };
}

function physicalId(info) { return info.deviceId || info.device_id || ''; }
function identity(parentId, childId = '') { return JSON.stringify([String(parentId), String(childId)]); }
function alias(info, fallback) {
  return [info.alias, info.nickname, info.name].find(value => typeof value === 'string' && value.trim()) || fallback;
}

function knownDevices(homey) {
  const keys = new Set();
  for (const driver of Object.values(homey.drivers.getDrivers())) {
    for (const device of driver.getDevices()) {
      const data = device.getData();
      const settings = device.getSettings();
      const parent = settings.deviceId || data.deviceId || data.parentId || data.id;
      const child = data.childId || settings.childId || '';
      if (parent) keys.add(identity(parent, child));
    }
  }
  return keys;
}

class LanScanner {
  constructor({ Client, credentials = null, duration = 8000, concurrency = 4, known = new Set(), onlyModel = null, budgetMs = 25000 }) {
    this.Client = Client || require('tplink-smarthome-api').Client;
    this.credentials = credentials;
    this.duration = duration;
    this.concurrency = concurrency;
    this.known = known;
    this.onlyModel = onlyModel;
    this.budgetMs = budgetMs;
    this.cancelled = false;
    this.rows = new Map();
    this.targets = new Map();
    this.clients = new Set();
  }

  client(options = {}) {
    const client = new this.Client({ logLevel: 'silent', ...(this.credentials ? { credentials: this.credentials } : {}), ...options });
    this.clients.add(client);
    return client;
  }

  stop() {
    this.cancelled = true;
    clearTimeout(this.deadlineTimer);
    if (this.releaseBudget) this.releaseBudget();
    if (this.finish) this.finish();
    for (const client of this.clients) {
      try { client.stopDiscovery(); } catch { /* A direct probe has no discovery socket. */ }
      client.removeAllListeners();
    }
  }

  async probe(host, metadata = null, deadline = Infinity, confirmedLink = null) {
    let info = metadata;
    let id = info && modelDriver(info.model);
    if (info && !id) return { host, model: String(info.model || 'Unknown'), status: 'unsupported', reason: 'This model is not supported yet.' };
    let link = confirmedLink || (info ? connection(info, id) : { transport: 'tcp', protocol: 'iot' });
    if (link.transport !== 'tcp' && !this.credentials) {
      return { host, model: info.model, status: 'account', reason: 'Enter the TP-Link account to verify this device.' };
    }
    const read = async options => {
      if (Date.now() >= deadline) throw new Error('The scan time limit was reached. Try fewer IP addresses.');
      const client = this.client({ defaultSendOptions: { timeout: Math.min(3000, deadline - Date.now()), ...options } });
      return { client, info: await client.getSysInfo(host, options.port) };
    };
    let result;
    const attempts = metadata || !this.credentials ? [link] : [link,
      { transport: 'klap', protocol: 'smart' }, { transport: 'klap', protocol: 'iot' },
      { transport: 'aes', protocol: 'smart' }, { transport: 'aes', protocol: 'iot' }];
    for (let index = 0; index < attempts.length; index++) {
      if (this.cancelled) throw new Error('The scan was cancelled.');
      try {
        result = await read(attempts[index]);
        link = attempts[index];
        break;
      } catch (error) {
        // A rejected account is never retried against another protocol.
        if (isAuthenticationError(error) || index === attempts.length - 1) throw error;
      }
    }
    info = result.info;
    id = modelDriver(info.model);
    if (!id) return { host, model: String(info.model || 'Unknown'), status: 'unsupported', reason: 'This model is not supported yet.' };
    if (this.onlyModel && id !== this.onlyModel) return null;
    const actualLink = connection(info, id);
    if (link.port && link.port !== 80 && !['ks200', 'kl135'].includes(id)) {
      throw new Error('This model’s nonstandard local port needs additional runtime support.');
    }
    if (link.transport !== actualLink.transport || link.protocol !== actualLink.protocol) {
      // Reject an unsupported runtime before saving anything. Authenticated
      // probes may return scheme metadata; keep the successful wire protocol.
      if (link.transport === 'tcp' && actualLink.transport !== 'tcp') throw new Error('Device connection changed. Scan again.');
    }
    const parentId = physicalId(info);
    if (typeof parentId !== 'string' || !parentId) throw new Error('The device did not return a physical device ID.');
    const target = { host, info, id, parentId, ...link };
    let children = [];
    if (id === 'ks240') {
      const plug = result.client.getPlug({ host, sysInfo: info });
      const response = await plug.sendSmartRequests([{ method: 'get_child_device_list' }]);
      children = (response.get_child_device_list?.child_device_list || []).filter(child =>
        ['kasa.switch.outlet.sub-fan', 'kasa.switch.outlet.sub-dimmer'].includes(child.category))
        .map(child => ({ childId: child.device_id, name: child.alias,
          channelType: child.category === 'kasa.switch.outlet.sub-fan' ? 'fan' : 'light' }));
    } else if (MULTI_MODELS.has(id)) {
      const plug = result.client.getPlug({ host, sysInfo: info });
      children = [...plug.children].map(([childId, child]) => ({ childId, name: child.alias }));
    }
    if (MULTI_MODELS.has(id) || id === 'ks240') {
      if (!children.length) throw new Error('The device did not return any controllable outlets or channels.');
    } else children = [{ childId: '' }];
    return children.map((child, index) => {
      if (typeof child.childId !== 'string' || ((MULTI_MODELS.has(id) || id === 'ks240') && !child.childId.trim())) {
        throw new Error('The device returned an invalid outlet ID.');
      }
      const key = identity(parentId, child.childId);
      const row = { key, host, model: info.model, modelDriver: id, name: child.name ||
        `${alias(info, info.model)}${child.childId ? ` ${child.channelType || `Outlet ${index + 1}`}` : ''}`,
      childId: child.childId, channelType: child.channelType, parentId,
      transport: link.transport, protocol: link.protocol,
      ...(link.port ? { port: link.port } : {}),
      status: this.known.has(key) ? 'paired' : 'ready' };
      return { ...row, target };
    });
  }

  async scan(addresses = []) {
    if (this.cancelled) return [];
    this.scanDone = false;
    const deadline = Date.now() + this.budgetMs;
    let expired = false;
    const budget = new Promise(resolve => {
      this.releaseBudget = resolve;
      this.deadlineTimer = setTimeout(() => {
        expired = true;
        if (this.finish) this.finish();
        resolve();
      }, this.budgetMs);
    });
    const seen = new Set();
    const queue = [];
    const pending = new Set();
    let accepting = true;
    const collect = (host, metadata) => {
      if (!accepting || this.cancelled || isIP(host || '') !== 4 || seen.has(host)) return;
      seen.add(host);
      queue.push({ host, metadata });
      drain();
    };
    const save = row => {
      if (this.cancelled || this.scanDone || !row) return;
      const key = row.key || identity(row.host, row.model);
      if (row.target) this.targets.set(key, row);
      const { target, ...safe } = row;
      this.rows.set(key, safe);
    };
    const drain = () => {
      while (!this.cancelled && !expired && pending.size < this.concurrency && queue.length) {
        const { host, metadata } = queue.shift();
        const task = this.probe(host, metadata, deadline).then(rows => {
          for (const row of Array.isArray(rows) ? rows : [rows]) save(row);
        }).catch(error => save({ host, model: metadata?.model || 'Unknown', status: 'error',
          reason: getSafeErrorMessage(error, this.credentials) })).finally(() => {
          pending.delete(task); drain();
        });
        pending.add(task);
      }
    };
    const client = this.client();
    await new Promise(resolve => {
      let timer;
      let finished = false;
      this.finish = () => {
        if (finished) return;
        finished = true;
        accepting = false;
        clearTimeout(timer);
        client.stopDiscovery();
        client.removeAllListeners();
        resolve();
      };
      const candidate = device => collect(device.host, device.sysInfo || device._sysInfo);
      for (const event of ['plug-new', 'plug-online', 'bulb-new', 'bulb-online']) client.on(event, candidate);
      client.on('error', error => save({ host: '', model: 'Network scan', status: 'error',
        reason: getSafeErrorMessage(error, this.credentials) }));
      timer = setTimeout(this.finish, this.duration);
      try {
        client.startDiscovery({ deviceTypes: ['plug', 'bulb'], breakoutChildren: false,
          discoveryInterval: 1500, discoveryTimeout: this.duration, devices: addresses.map(host => ({ host })) });
      } catch (error) {
        save({ host: '', model: 'Network scan', status: 'error', reason: getSafeErrorMessage(error, this.credentials) });
        this.finish();
      }
    });
    // Explicit addresses also get a direct read when UDP discovery is blocked.
    if (!this.cancelled) {
      accepting = true;
      for (const host of addresses) collect(host, null);
      accepting = false;
      while (pending.size || queue.length) {
        if (this.cancelled || expired) break;
        await Promise.race([Promise.allSettled([...pending]), budget]);
      }
    }
    if (expired) save({ host: '', model: 'Scan time limit', status: 'error',
      reason: 'Some devices did not reply in time. Try fewer IP addresses, or check local network access.' });
    clearTimeout(this.deadlineTimer);
    this.scanDone = true;
    return this.cancelled ? [] : [...this.rows.values()].sort((a, b) => a.name?.localeCompare(b.name || '') || a.host.localeCompare(b.host));
  }

  async revalidate(row) {
    const refreshed = await this.probe(row.host, row.target.info, Infinity, {
      transport: row.transport, protocol: row.protocol, ...(row.port ? { port: row.port } : {}),
    });
    const match = Array.isArray(refreshed) && refreshed.find(candidate => candidate.key === row.key && candidate.modelDriver === row.modelDriver);
    if (!match) throw new Error('The selected device or outlet changed. Scan again before adding it.');
    return match;
  }
}

function descriptor(row, credentialSettings = {}) {
  const driver = manifest.drivers.find(item => item.id === row.modelDriver);
  if (!driver) throw new Error('The selected model has no registered driver.');
  const data = { id: row.parentId, modelDriver: row.modelDriver, deviceId: row.parentId,
    transport: row.transport, protocol: row.protocol };
  if (row.port) data.port = row.port;
  if (row.childId) data.childId = row.childId;
  if (row.modelDriver === 'ks240') Object.assign(data, { id: row.childId, parentId: row.parentId, channelType: row.channelType });
  const settings = { settingIPAddress: row.host, deviceId: row.parentId, dynamicIp: true,
    pollingInterval: 10, totalOffset: 0, ...credentialSettings };
  if (row.channelType) Object.assign(settings, { childId: row.childId, channelType: row.channelType });
  return { name: row.name, data, settings, class: row.channelType === 'fan' ? 'fan' : driver.class,
    icon: `/drivers/${row.modelDriver}/assets/icon.svg`, capabilities: [...driver.capabilities],
    ...(driver.capabilitiesOptions ? { capabilitiesOptions: driver.capabilitiesOptions } : {}) };
}

module.exports = { LanScanner, modelDriver, parseAddresses, knownDevices, identity, descriptor, BULK_DRIVER };
