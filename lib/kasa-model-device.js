'use strict';

const Homey = require('homey');
const { isIP } = require('node:net');
const { Client } = require('tplink-smarthome-api');
const { getRecovery } = require('./tplink-recovery');
const { getDeviceConnectionData, isValidTpLinkTransport } = require('./tplink-auth');
const {
  getManualCredentialTransition, getSafeErrorMessage, resolveDeviceCredentials,
} = require('./tplink-credentials');

const REQUEST_TIMEOUT_MS = 4000;
const KELVIN_MIN = 2500;
const KELVIN_MAX = 9000;

function normalized(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return value;
}

function physicalId(info) {
  return info && (info.deviceId || info.device_id);
}

/** Local runtime for the explicitly supported KL135 and KS200 model families. */
class KasaModelDevice extends Homey.Device {
  async onInit() {
    this._closed = false;
    this._generation = 0;
    this._operationTail = Promise.resolve();
    this._pollPromise = null;
    this._connection = null;
    this._lastError = null;
    getRecovery(this).initialize();

    this.registerCapabilityListener('onoff', value => this.onCapabilityOnoff(value));
    if (this.constructor.kind === 'bulb') {
      for (const [capability, handler] of [
        ['dim', 'onCapabilityDim'], ['light_hue', 'onCapabilityHue'],
        ['light_saturation', 'onCapabilitySaturation'],
        ['light_temperature', 'onCapabilityTemperature'], ['light_mode', 'onCapabilityMode'],
      ]) this.registerCapabilityListener(capability, value => this[handler](value));
    } else if (this.hasCapability('ledonoff')) {
      this.registerCapabilityListener('ledonoff', value => this.onCapabilityLedOnoff(value));
    }

    await this.setUnavailable('Waiting for local device status');
    await this.pollStatus();
    this._schedulePoll();
  }

  _globalCredentials() {
    const app = this.homey && this.homey.app;
    return app && typeof app.getGlobalCredentials === 'function' ? app.getGlobalCredentials() : null;
  }

  _safe(error, settings = this.getSettings()) {
    return getSafeErrorMessage(error, settings, this._globalCredentials());
  }

  _current(generation) {
    return !this._closed && generation === this._generation;
  }

  _assertCurrent(generation) {
    if (!this._current(generation)) throw new Error('The device connection changed; try again.');
  }

  _serialize(operation) {
    const result = this._operationTail.then(operation);
    this._operationTail = result.catch(() => {});
    return result;
  }

  _closeConnection() {
    const connection = this._connection;
    this._connection = null;
    if (connection && typeof connection.device.closeConnection === 'function') {
      try { connection.device.closeConnection(); } catch (error) { this.log('Unable to close local connection: ' + this._safe(error)); }
    }
  }

  _validateSettings(settings) {
    if (isIP(settings.settingIPAddress || '') !== 4) throw new Error('Enter a valid device IPv4 address.');
    const interval = settings.pollingInterval === undefined ? 10 : settings.pollingInterval;
    if (!Number.isFinite(interval) || interval < 2 || interval > 60) {
      throw new Error('The polling interval must be between 2 and 60 seconds.');
    }
  }

  _connectionData() {
    const data = getDeviceConnectionData(this);
    const saved = this.getStoreValue('tplinkConnection');
    return saved && saved.host === this.getSettings().settingIPAddress &&
      Number.isInteger(saved.port) && saved.port > 0 && saved.port <= 65535
      ? { ...data, port: saved.port } : data;
  }

  _checkIdentity(info, settings, data = this._connectionData()) {
    const model = String(info && info.model || '').toUpperCase().split('(')[0].trim();
    if (model !== this.constructor.model) throw new Error(`The device at this address is not a ${this.constructor.model}.`);
    const expectedId = settings.deviceId || data.deviceId;
    if (!expectedId || !physicalId(info) || physicalId(info) !== expectedId) {
      throw new Error('The device at this address does not match the paired device.');
    }
  }

  async _createConnection(settings, generation) {
    this._validateSettings(settings);
    const data = this._connectionData();
    const transport = data.transport || 'tcp';
    if (!isValidTpLinkTransport(transport)) throw new Error('This device uses an unsupported local transport.');
    if (this.constructor.kind === 'bulb' && data.protocol === 'smart') {
      throw new Error('This KL135 firmware uses an unsupported local bulb protocol.');
    }
    const resolution = resolveDeviceCredentials(settings, this._globalCredentials());
    this._usingGlobalCredentials = resolution.source === 'global' || resolution.usesGlobalCredentials;
    if (transport !== 'tcp' && !resolution.credentials) {
      throw new Error('Configure a complete TP-Link account for this authenticated device.');
    }
    const options = {
      logLevel: 'silent',
      defaultSendOptions: { transport, timeout: REQUEST_TIMEOUT_MS,
        ...(['iot', 'smart'].includes(data.protocol) ? { protocol: data.protocol } : {}) },
      ...(transport !== 'tcp' ? { credentials: resolution.credentials } : {}),
    };
    const client = new Client(options);
    client.on('error', error => {
      if (this._current(generation)) this.log('Local connection failed: ' + this._safe(error, settings));
    });
    this.client = client;
    const info = await client.getSysInfo(settings.settingIPAddress, data.port);
    this._assertCurrent(generation);
    this._checkIdentity(info, settings, data);
    const deviceOptions = { host: settings.settingIPAddress, sysInfo: info,
      ...(Number.isInteger(data.port) ? { port: data.port } : {}) };
    const device = this.constructor.kind === 'bulb' ? client.getBulb(deviceOptions) : client.getPlug(deviceOptions);
    return { client, device, host: settings.settingIPAddress, info };
  }

  async _ensureConnection(generation) {
    const settings = this.getSettings();
    if (this._connection && this._connection.host === settings.settingIPAddress) return this._connection;
    this._closeConnection();
    const connection = await this._createConnection(settings, generation);
    this._assertCurrent(generation);
    this._connection = connection;
    return connection;
  }

  async _setValue(capability, value, generation) {
    this._assertCurrent(generation);
    if (!this.hasCapability(capability) || Object.is(this.getCapabilityValue(capability), value)) return;
    await this.setCapabilityValue(capability, value);
    this._assertCurrent(generation);
  }

  async _applyBulbState(state, generation) {
    if (!state || ![0, 1].includes(state.on_off)) throw new Error('The bulb returned an incomplete light state.');
    const values = { ...(state.dft_on_state || {}), ...state };
    await this._setValue('onoff', state.on_off === 1, generation);
    if (Number.isFinite(values.brightness) && values.brightness >= 0 && values.brightness <= 100) {
      await this._setValue('dim', values.brightness / 100, generation);
    }
    if (Number.isFinite(values.hue) && values.hue >= 0 && values.hue <= 360) {
      await this._setValue('light_hue', values.hue / 360, generation);
    }
    if (Number.isFinite(values.saturation) && values.saturation >= 0 && values.saturation <= 100) {
      await this._setValue('light_saturation', values.saturation / 100, generation);
    }
    if (Number.isFinite(values.color_temp) && values.color_temp > 0) {
      this._lastKelvin = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, values.color_temp));
      await this._setValue('light_temperature', (KELVIN_MAX - this._lastKelvin) / (KELVIN_MAX - KELVIN_MIN), generation);
      await this._setValue('light_mode', 'temperature', generation);
    } else if (values.color_temp === 0) {
      await this._setValue('light_mode', 'color', generation);
    }
  }

  async _refresh(connection, generation, poll) {
    const info = await connection.device.getSysInfo();
    this._assertCurrent(generation);
    this._checkIdentity(info, this.getSettings());
    if (poll) getRecovery(this).responded(poll);
    if (this.constructor.kind === 'bulb') {
      const lightState = await connection.device.lighting.getLightState();
      this._assertCurrent(generation);
      await this._applyBulbState(lightState, generation);
      if (this.hasCapability('measure_power')) {
        try {
          const realtime = await connection.device.emeter.getRealtime();
          this._assertCurrent(generation);
          const power = Number.isFinite(realtime.power) ? realtime.power : realtime.power_mw / 1000;
          if (!Number.isFinite(power) || power < 0) throw new Error('The bulb returned no valid power measurement.');
          await this._setValue('measure_power', power, generation);
        } catch (error) {
          this._assertCurrent(generation);
          getRecovery(this).logChanged('powerError', this._safe(error), 'Power measurement failed: ' + this._safe(error));
        }
      }
    } else {
      const relay = info.relay_state;
      const onoff = [0, 1].includes(relay) ? relay === 1 : typeof info.device_on === 'boolean' ? info.device_on : null;
      if (onoff === null) throw new Error('The switch returned an incomplete relay state.');
      await this._setValue('onoff', onoff, generation);
      if ([0, 1].includes(info.led_off)) await this._setValue('ledonoff', info.led_off === 0, generation);
    }
    this._assertCurrent(generation);
    this._lastError = null;
    if (poll) await getRecovery(this).succeeded(poll);
    else if (!this.getAvailable()) await this.setAvailable();
  }

  async _failed(error, generation, poll) {
    if (!this._current(generation)) return;
    const message = this._safe(error);
    if (message !== this._lastError) this.log('Local status failed: ' + message);
    this._lastError = message;
    await this.setUnavailable(message);
    if (!this._current(generation)) return;
    await getRecovery(this).failed(poll, error);
    this._closeConnection();
  }

  pollStatus() {
    if (this._closed) return Promise.resolve(false);
    if (this._pollPromise) return this._pollPromise;
    const generation = this._generation;
    const pending = this._serialize(async () => {
      let poll;
      try {
        this._assertCurrent(generation);
        const connection = await this._ensureConnection(generation);
        poll = getRecovery(this).beginPoll();
        await this._refresh(connection, generation, poll);
        return true;
      } catch (error) {
        await this._failed(error, generation, poll);
        return false;
      } finally {
        if (poll) getRecovery(this).endPoll(poll);
      }
    });
    this._pollPromise = pending;
    void pending.finally(() => { if (this._pollPromise === pending) this._pollPromise = null; }).catch(() => {});
    return pending;
  }

  _schedulePoll() {
    clearTimeout(this._pollTimer);
    if (this._closed) return;
    const interval = this.getSettings().pollingInterval;
    const delay = Number.isFinite(interval) && interval >= 2 && interval <= 60 ? interval * 1000 : 10000;
    this._pollTimer = setTimeout(() => {
      void this.pollStatus().catch(error => this.log('Status refresh failed: ' + this._safe(error)))
        .finally(() => this._schedulePoll());
    }, delay);
  }

  _command(send) {
    const generation = this._generation;
    return this._serialize(async () => {
      try {
        this._assertCurrent(generation);
        const connection = await this._ensureConnection(generation);
        const info = await connection.device.getSysInfo();
        this._assertCurrent(generation);
        this._checkIdentity(info, this.getSettings());
        await send(connection.device);
        this._assertCurrent(generation);
        // Read back the reported state; an acknowledgement does not set Homey's values.
        await this._refresh(connection, generation);
        return true;
      } catch (error) {
        await this._failed(error, generation);
        throw new Error(this._safe(error));
      }
    });
  }

  onCapabilityOnoff(value) {
    if (typeof value !== 'boolean') return Promise.reject(new Error('On/off must be a boolean.'));
    return this._command(device => device.setPowerState(value));
  }

  onCapabilityLedOnoff(value) {
    if (typeof value !== 'boolean') return Promise.reject(new Error('LED state must be a boolean.'));
    return this._command(device => device.setLedState(value));
  }

  onCapabilityDim(value) {
    normalized(value, 'Brightness');
    return this._command(device => device.lighting.setLightState(value === 0 ? { on_off: 0 }
      : { brightness: Math.max(1, Math.round(value * 100)), on_off: 1 }));
  }

  onCapabilityHue(value) {
    normalized(value, 'Hue');
    return this._command(device => device.lighting.setLightState({ hue: Math.round(value * 360), color_temp: 0, mode: 'normal' }));
  }

  onCapabilitySaturation(value) {
    normalized(value, 'Saturation');
    return this._command(device => device.lighting.setLightState({ saturation: Math.round(value * 100), color_temp: 0, mode: 'normal' }));
  }

  onCapabilityTemperature(value) {
    normalized(value, 'Colour temperature');
    return this._command(device => device.lighting.setLightState({ color_temp: Math.round(KELVIN_MAX - value * (KELVIN_MAX - KELVIN_MIN)), mode: 'normal' }));
  }

  onCapabilityMode(value) {
    if (!['color', 'temperature'].includes(value)) return Promise.reject(new Error('Choose colour or temperature mode.'));
    return this._command(device => device.lighting.setLightState({ color_temp: value === 'color' ? 0 : this._lastKelvin || 4000, mode: 'normal' }));
  }

  powerOn() { return this.onCapabilityOnoff(true); }
  powerOff() { return this.onCapabilityOnoff(false); }
  ledOn() { return this.onCapabilityLedOnoff(true); }
  ledOff() { return this.onCapabilityLedOnoff(false); }
  setLedState(host, childId, value) { return this.onCapabilityLedOnoff(value); }
  setBrightness(host, brightness) { return this.onCapabilityDim(brightness / 100); }
  circadianModeOn() { return this._command(device => device.lighting.setLightState({ mode: 'circadian' })); }
  circadianModeOff() { return this._command(device => device.lighting.setLightState({ mode: 'normal' })); }
  onTransition(host, transition) { return this._transition(true, transition); }
  offTransition(host, transition) { return this._transition(false, transition); }

  _transition(value, transition) {
    if (!Number.isFinite(transition) || transition < 0 || transition > 3600000) {
      return Promise.reject(new Error('The transition must be between 0 and 3600000 milliseconds.'));
    }
    return this._command(device => device.lighting.setLightState({ on_off: value ? 1 : 0, transition_period: transition }));
  }

  async onSettings({ oldSettings = {}, newSettings = {}, changedKeys = [] }) {
    const candidate = { ...this.getSettings(), ...oldSettings, ...newSettings };
    this._validateSettings(candidate);
    const credentialsChanged = changedKeys.some(key => ['deviceUsername', 'devicePassword'].includes(key));
    let transition;
    if (credentialsChanged) {
      transition = getManualCredentialTransition(candidate, this._globalCredentials());
      Object.assign(candidate, transition.settings);
    }
    const generation = ++this._generation;
    clearTimeout(this._pollTimer);
    await getRecovery(this).settingsChanged(changedKeys);
    const connectionChanged = changedKeys.some(key =>
      ['settingIPAddress', 'deviceUsername', 'devicePassword', 'credentialSource'].includes(key));
    try {
      // Polling and recovery preferences can be changed even while a device is offline.
      if (!connectionChanged) return true;
      this._closeConnection();
      await this._serialize(async () => {
        this._assertCurrent(generation);
        const validated = await this._createConnection(candidate, generation);
        this._assertCurrent(generation);
        if (transition) await this.setSettings(transition.settings);
        this._assertCurrent(generation);
        this._connection = validated;
      });
      return true;
    } catch (error) {
      this._closeConnection();
      throw new Error(this._safe(error, candidate));
    } finally {
      this._schedulePoll();
    }
  }

  async refreshGlobalCredentials() {
    const resolution = resolveDeviceCredentials(this.getSettings(), this._globalCredentials());
    if (this._closed || !(resolution.source === 'global' || resolution.usesGlobalCredentials || this._usingGlobalCredentials)) return false;
    const generation = ++this._generation;
    getRecovery(this).cancel();
    this._closeConnection();
    if (this._pollPromise) await this._pollPromise.catch(() => {});
    if (!this._current(generation)) return false;
    return this.pollStatus();
  }

  discover() {
    return getRecovery(this).discover({
      type: this.constructor.kind,
      createClient: settings => {
        const credentials = resolveDeviceCredentials(settings, this._globalCredentials()).credentials;
        return new Client({ logLevel: 'silent', defaultSendOptions: { timeout: REQUEST_TIMEOUT_MS }, ...(credentials ? { credentials } : {}) });
      },
      resolveCandidate: async (candidate, settings) => {
        const info = await candidate.getSysInfo();
        this._checkIdentity(info, settings);
        const transport = candidate.defaultSendOptions && candidate.defaultSendOptions.transport || 'tcp';
        if (!isValidTpLinkTransport(transport)) return null;
        const protocol = String(info.type || info.mic_type || '').startsWith('SMART.') ? 'smart' : 'iot';
        if (this.constructor.kind === 'bulb' && protocol === 'smart') return null;
        return { deviceId: physicalId(info), host: candidate.host,
          afterSave: async current => {
            const port = candidate.port;
            const profile = { host: candidate.host, transport, protocol,
              ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}) };
            await this.setStoreValue('tplinkConnection', profile);
            if (current()) {
              this._generation++;
              this._closeConnection();
            }
          } };
      },
    });
  }

  onDeleted() {
    this._closed = true;
    this._generation++;
    clearTimeout(this._pollTimer);
    getRecovery(this).destroy();
    this._closeConnection();
  }

  onUninit() { this.onDeleted(); }
}

module.exports = KasaModelDevice;
