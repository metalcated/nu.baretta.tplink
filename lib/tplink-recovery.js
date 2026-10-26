'use strict';

const { isIP } = require('node:net');
const { getSafeErrorMessage, isAuthenticationError, isReachabilityError } = require('./tplink-credentials');
const { parseTargets } = require('./lan-targets');

const RETRY_MS = 60000;
const DISCOVERY_MS = 5000;
const CONNECTION_SETTINGS = new Set([
  'settingIPAddress', 'dynamicIp', 'deviceUsername', 'devicePassword', 'credentialSource',
]);

class TpLinkRecovery {
  constructor(device) {
    this.device = device;
    this.generation = 0;
    this.deleted = false;
    this.pendingPoll = null;
    this.pendingSave = null;
    this.scan = null;
    this.lastDiscoveryAt = null;
    this.loggedValues = new Map();
    this.pollError = null;
  }

  globalCredentials() {
    const app = this.device.homey && this.device.homey.app;
    return app && typeof app.getGlobalCredentials === 'function' ? app.getGlobalCredentials() : null;
  }

  logError(context, error, settings, credentials) {
    this.device.log(context + ': ' + getSafeErrorMessage(
      error, settings, credentials, this.device.getSettings(), this.globalCredentials(),
    ));
  }

  initialize() {
    this.cancel();
    this.deleted = false;
    this.loggedValues.clear();
    this.pollError = null;
  }

  logChanged(key, value, message) {
    if (this.loggedValues.has(key) && Object.is(this.loggedValues.get(key), value)) return;
    this.loggedValues.set(key, value);
    this.device.log(message);
  }

  cancel() {
    this.generation++;
    this.stopDiscovery();
    this.device.unreachableCount = 0;
    this.device.discoverCount = 0;
    this.lastDiscoveryAt = null;
  }

  destroy() {
    this.deleted = true;
    this.cancel();
  }

  async settingsChanged(changedKeys = []) {
    if (!changedKeys.some(key => CONNECTION_SETTINGS.has(key))) return;
    this.cancel();
    // Finish a previously issued IP write before Homey commits the user's settings.
    if (this.pendingSave) await this.pendingSave.catch(() => {});
  }

  beginPoll() {
    if (this.deleted || this.pendingPoll) return null;
    const poll = {
      generation: this.generation,
      ip: this.device.getSettings().settingIPAddress,
      client: this.device.client,
      responded: false,
    };
    this.pendingPoll = poll;
    return poll;
  }

  isCurrent(poll) {
    return !this.deleted && poll.generation === this.generation &&
      poll.ip === this.device.getSettings().settingIPAddress && poll.client === this.device.client;
  }

  responded(poll) {
    if (!this.isCurrent(poll)) return false;
    poll.responded = true;
    return true;
  }

  endPoll(poll) {
    if (this.pendingPoll === poll) this.pendingPoll = null;
  }

  async succeeded(poll) {
    if (!this.isCurrent(poll)) return;
    if (this.pollError !== null) {
      this.device.log('Device communication restored');
      this.pollError = null;
    }
    this.device.unreachableCount = 0;
    this.device.discoverCount = 0;
    this.lastDiscoveryAt = null;
    this.stopDiscovery();
    if (!this.device.getAvailable()) {
      try {
        await this.device.setAvailable();
      } catch (error) {
        this.logError('Unable to restore device availability', error);
      }
    }
  }

  async failed(poll, error) {
    // The optional token preserves legacy handleErrors() callers.
    poll = poll || { generation: this.generation, ip: this.device.getSettings().settingIPAddress,
      client: this.device.client, responded: false };
    if (!this.isCurrent(poll)) return;
    const message = getSafeErrorMessage(error, this.device.getSettings(), this.globalCredentials());
    if (message !== this.pollError) {
      this.device.log('Status polling failed: ' + message);
      this.pollError = message;
    }
    const networkError = { message: `${error && error.code || ''} ${error && error.message || ''}` };
    if (poll.responded || isAuthenticationError(error) || !isReachabilityError(networkError)) return;
    const transportRecovery = typeof this.device.canRecoverTransport === 'function' &&
      this.device.canRecoverTransport(error);
    this.device.unreachableCount = (this.device.unreachableCount || 0) + 1;
    if ((!this.device.getSettings().dynamicIp && !transportRecovery) || this.device.unreachableCount < 3 || this.scan ||
        (this.lastDiscoveryAt !== null && Date.now() - this.lastDiscoveryAt < RETRY_MS)) return;
    this.lastDiscoveryAt = Date.now();
    try {
      await this.device.setUnavailable('Device offline');
    } catch (availabilityError) {
      this.logError('Unable to mark device unavailable', availabilityError);
    }
    if (!this.isCurrent(poll) || (!this.device.getSettings().dynamicIp && !transportRecovery)) return;
    this.device.discoverCount = (this.device.discoverCount || 0) + 1;
    this.device.log(transportRecovery ? 'Legacy connection refused, detecting device transport' : 'Unreachable, starting IP discovery');
    try {
      await this.device.discover({ transportRecovery });
    } catch (discoveryError) {
      this.logError('Unable to start IP discovery', discoveryError);
    }
  }

  stopDiscovery() {
    const state = this.scan;
    if (!state) return;
    this.scan = null;
    clearTimeout(state.timer);
    try {
      state.client.stopDiscovery();
    } catch (error) {
      this.logError('Unable to stop IP discovery', error, state.settings, state.credentials);
    }
    state.client.removeAllListeners();
  }

  discover({ createClient, type = 'plug', resolveCandidate, allowFixedIp = false }) {
    const settings = this.device.getSettings();
    if (this.deleted || this.scan || (!settings.dynamicIp && !allowFixedIp)) return;
    this.lastDiscoveryAt = Date.now();
    if (!settings.deviceId) {
      this.device.log('IP discovery skipped: device ID missing; restore the IP address manually first');
      return;
    }
    const credentials = this.globalCredentials();
    let discoveryHosts = [];
    if (settings.dynamicIp) {
      const app = this.device.homey && this.device.homey.app;
      try {
        if (app && typeof app.getDiscoverySettings === 'function') {
          discoveryHosts = parseTargets(app.getDiscoverySettings()?.targets || '').discoveryHosts;
        }
      } catch (error) {
        this.logError('Unable to read saved discovery networks', error, settings, credentials);
      }
    }
    let client;
    try {
      client = createClient(settings);
    } catch (error) {
      this.logError('Unable to create discovery client', error, settings, credentials);
      return;
    }
    const state = { client, settings, credentials, generation: this.generation,
      timer: null, saving: false, pending: new Set(), attempted: new Set() };
    this.scan = state;
    const current = () => {
      const latest = this.device.getSettings();
      return this.scan === state && !this.deleted && this.generation === state.generation &&
        (latest.dynamicIp || allowFixedIp) && latest.settingIPAddress === settings.settingIPAddress &&
        latest.deviceId === settings.deviceId;
    };
    const onDevice = async discovered => {
      if (!current() || state.saving || !discovered || !isIP(discovered.host || '')) return;
      if (!settings.dynamicIp && discovered.host !== settings.settingIPAddress) return;
      if (allowFixedIp && state.attempted.has(discovered.host)) return;
      state.attempted.add(discovered.host);
      const key = discovered.deviceId || discovered.host;
      if (state.pending.has(key)) return;
      state.pending.add(key);
      try {
        let candidate;
        if (resolveCandidate) {
          candidate = await resolveCandidate(discovered, settings);
        } else {
          const discoveryId = discovered.deviceId;
          const transport = discovered.defaultSendOptions && discovered.defaultSendOptions.transport;
          const info = ['aes', 'klap'].includes(transport) ? await discovered.getSysInfo() : null;
          candidate = {
            deviceId: discoveryId === settings.deviceId ? discoveryId : info && info.deviceId || discoveryId,
            host: discovered.host,
          };
        }
        if (!current() || state.saving || !candidate || candidate.deviceId !== settings.deviceId ||
            !isIP(candidate.host || '')) return;
        state.saving = true;
        const stillCurrent = () => this.scan === state && !this.deleted && this.generation === state.generation &&
          this.device.getSettings().settingIPAddress === candidate.host;
        const save = (async () => {
          await this.device.setSettings({ settingIPAddress: candidate.host });
          if (stillCurrent() && candidate.afterSave) await candidate.afterSave(stillCurrent);
        })();
        this.pendingSave = save;
        try {
          await save;
        } finally {
          if (this.pendingSave === save) this.pendingSave = null;
        }
        if (this.scan !== state || this.deleted || this.generation !== state.generation ||
            this.device.getSettings().settingIPAddress !== candidate.host) return;
        this.device.unreachableCount = 0;
        this.device.discoverCount = 0;
        this.device.log('Rediscovered device at ' + candidate.host + '; awaiting successful status poll');
      } catch (error) {
        this.logError('IP discovery candidate failed', error, settings, credentials);
      } finally {
        state.pending.delete(key);
        if (state.saving && this.scan === state) this.stopDiscovery();
      }
    };
    const onError = error => {
      this.logError('IP discovery failed', error, settings, credentials);
      if (this.scan === state) this.stopDiscovery();
    };
    client.on(type + '-new', onDevice);
    client.on(type + '-online', onDevice);
    client.on('error', onError);
    state.timer = setTimeout(() => {
      if (this.scan !== state) return;
      this.device.log('IP discovery timed out; will retry after the cooldown');
      this.stopDiscovery();
    }, DISCOVERY_MS);
    try {
      // A saved network already expands to many hosts. Send one directed UDP
      // round per attempt; the existing five-second window still receives replies.
      client.startDiscovery({ deviceTypes: [type],
        discoveryInterval: settings.dynamicIp && discoveryHosts.length ? DISCOVERY_MS + 1000 : 1000,
        discoveryTimeout: DISCOVERY_MS, breakoutChildren: false,
        ...(settings.dynamicIp && discoveryHosts.length ? { devices: discoveryHosts.map(host => ({ host })) } : {}),
        ...(!settings.dynamicIp ? { broadcast: settings.settingIPAddress, devices: [{ host: settings.settingIPAddress }] } : {}),
      });
    } catch (error) {
      onError(error);
    }
  }
}

function getRecovery(device) {
  if (!device._ipRecovery) device._ipRecovery = new TpLinkRecovery(device);
  return device._ipRecovery;
}

module.exports = { getRecovery };
