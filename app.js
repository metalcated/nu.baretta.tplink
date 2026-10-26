'use strict';

const Homey = require('homey');
const { isIP } = require('node:net');
const { Client } = require('tplink-smarthome-api');
const hs220Diagnostics = require('./lib/hs220-diagnostics');
const {
  getEp10ClientOptions,
  getDeviceConnectionData,
  getEp10Transport,
  getKs240SysInfo,
  getTpLinkClientOptions,
} = require('./lib/tplink-auth');
const {
  CREDENTIAL_SOURCES,
  GLOBAL_CREDENTIALS_KEY,
  assertValidCredentialPair,
  credentialsMatch,
  getCredentialSource,
  getEffectiveDeviceSettings,
  getManualCredentialTransition,
  getPairedCredentialSettings,
  getSafeErrorMessage,
  hasCompleteCredentials,
  isAuthenticationError,
  isReachabilityError,
  maskUsername,
  normalizeCredentialPair,
  resolveDeviceCredentials,
  resolvePairingCredentials,
} = require('./lib/tplink-credentials');

const AUTHENTICATED_DRIVER_IDS = new Set(['ks225', 's500d', 'ks240']);
const DUAL_TRANSPORT_DRIVER_IDS = new Set(['ep10', 'hs200', 'hs210', 'hs220', 'ks200', 'kl135']);
const MANAGED_DRIVER_IDS = new Set([...AUTHENTICATED_DRIVER_IDS, ...DUAL_TRANSPORT_DRIVER_IDS]);
const CREDENTIAL_VALIDATION_TIMEOUT = 4000;

function getDriverId(driver, fallbackId) {
  if (driver && typeof driver.id === 'string') return driver.id;
  return fallbackId;
}

function getDeviceIpAddress(settings = {}) {
  return typeof settings.settingIPAddress === 'string'
    ? settings.settingIPAddress.trim()
    : '';
}

function createCredentialValidationClient(driverId, device, credentials) {
  const settings = {
    deviceUsername: credentials.username,
    devicePassword: credentials.password,
    credentialSource: CREDENTIAL_SOURCES.OVERRIDE,
  };
  const options =
    DUAL_TRANSPORT_DRIVER_IDS.has(driverId)
      ? getEp10ClientOptions(getDeviceConnectionData(device), settings)
      : getTpLinkClientOptions(driverId.toUpperCase(), settings);

  options.defaultSendOptions.timeout = CREDENTIAL_VALIDATION_TIMEOUT;
  return new Client(options);
}

class TpLinkApp extends Homey.App {
  async onInit() {
    this._credentialMutation = Promise.resolve();
    this._globalCredentialRefreshVersion = 0;
    this._credentialValidation = { status: 'unverified' };
    if (!this._lanActionsRegistered) {
      const actions = {
        ledOn: device => typeof device.setLedState === 'function'
          ? device.setLedState(device.getSettings().settingIPAddress, device.getData().childId, true)
          : device.ledOn(device.getSettings().settingIPAddress, device.getData().childId),
        ledOff: device => typeof device.setLedState === 'function'
          ? device.setLedState(device.getSettings().settingIPAddress, device.getData().childId, false)
          : device.ledOff(device.getSettings().settingIPAddress, device.getData().childId),
        meter_reset: device => device.meter_reset(device.getSettings().settingIPAddress),
        undo_meter_reset: device => device.undo_meter_reset(device.getSettings().settingIPAddress),
        circadianModeOn: device => device.circadianModeOn(device.getSettings().settingIPAddress),
        circadianModeOff: device => device.circadianModeOff(device.getSettings().settingIPAddress),
        transitionOn: (device, args) => device.onTransition(device.getSettings().settingIPAddress, args.transition * 1000),
        transitionOff: (device, args) => device.offTransition(device.getSettings().settingIPAddress, args.transition * 1000),
        set_brightness: (device, args) => {
          if (!Number.isFinite(args.brightness) || args.brightness < 0 || args.brightness > 100) {
            throw new Error('Enter a brightness from 0 to 100.');
          }
          if (typeof device.setLevel === 'function') return device.setLevel(args.brightness / 100);
          if (typeof device.setBrightness === 'function') return device.setBrightness(device.getSettings().settingIPAddress, args.brightness);
          return device.onCapabilityDim(args.brightness / 100);
        },
      };
      for (const [id, run] of Object.entries(actions)) {
        this.homey.flow.getActionCard(`lan_${id}`).registerRunListener(async args =>
          (await run(args.device, args)) !== false);
      }
      this._lanActionsRegistered = true;
    }
    if (!this._ledActionsRegistered) {
      for (const [cardId, value] of [['ledOn', true], ['ledOff', false]]) {
        this.homey.flow.getActionCard(cardId).registerRunListener(async ({ device }) => {
          const host = device.getSettings().settingIPAddress;
          const childId = device.getData().childId;
          const result = typeof device.setLedState === 'function'
            ? await device.setLedState(host, childId, value)
            : await device[value ? 'ledOn' : 'ledOff'](host, childId);
          return result !== false;
        });
      }
      this._ledActionsRegistered = true;
    }
    if (!this._brightnessActionRegistered) {
      this.homey.flow.getActionCard('set_brightness').registerRunListener(async ({ device, brightness }) => {
        if (typeof brightness !== 'number' || !Number.isFinite(brightness) || brightness < 0 || brightness > 100) {
          throw new Error(this.homey.__('flowErrors.invalidBrightness'));
        }
        // KS240 controls a child channel using a normalized level.
        const result = typeof device.setLevel === 'function'
          ? await device.setLevel(brightness / 100)
          : await device.setBrightness(device.getSettings().settingIPAddress, brightness);
        return result !== false;
      });
      this._brightnessActionRegistered = true;
    }
    this.log('TP-Link credential source management initialized');
  }

  getGlobalCredentials() {
    const stored = this.homey.settings.get(GLOBAL_CREDENTIALS_KEY);
    return hasCompleteCredentials(stored) ? normalizeCredentialPair(stored) : null;
  }

  collectHs220Diagnostics() {
    if (!this._hs220DiagnosticScan) {
      this._hs220DiagnosticScan = hs220Diagnostics.collect(this.getManagedDevices(), this.getGlobalCredentials())
        .then(report => {
          this.log(`HS220 diagnostics: API=${report.apiVersion}, app=${report.appVersion}, scan=${report.scan}`);
          for (const row of report.devices) this.log('HS220 diagnostic device: ' + JSON.stringify(row));
          return report;
        }).finally(() => { this._hs220DiagnosticScan = null; });
    }
    return this._hs220DiagnosticScan;
  }

  resolveDeviceCredentials(settings = {}) {
    return resolveDeviceCredentials(settings, this.getGlobalCredentials());
  }

  getEffectiveDeviceSettings(settings = {}) {
    return getEffectiveDeviceSettings(settings, this.getGlobalCredentials());
  }

  getManualDeviceCredentialTransition(settings = {}) {
    return getManualCredentialTransition(settings, this.getGlobalCredentials());
  }

  resolvePairingCredentials(input = {}) {
    return resolvePairingCredentials(input, this.getGlobalCredentials());
  }

  async finalizePairingCredentials(pairingResolution) {
    if (!pairingResolution || !pairingResolution.credentials) {
      throw new Error('TP-Link pairing credentials were not resolved.');
    }

    return this.withCredentialMutation(async () => {
      const currentGlobal = this.getGlobalCredentials();
      let resolved;

      if (!currentGlobal) {
        this.homey.settings.set(GLOBAL_CREDENTIALS_KEY, {
          username: pairingResolution.credentials.username,
          password: pairingResolution.credentials.password,
        });
        this._globalCredentialRefreshVersion += 1;
        this._credentialValidation = { status: 'unverified' };
        resolved = {
          credentials: pairingResolution.credentials,
          source: CREDENTIAL_SOURCES.GLOBAL,
          seedGlobal: true,
        };
      } else if (credentialsMatch(currentGlobal, pairingResolution.credentials)) {
        resolved = {
          credentials: currentGlobal,
          source: CREDENTIAL_SOURCES.GLOBAL,
          seedGlobal: false,
        };
      } else {
        resolved = {
          credentials: pairingResolution.credentials,
          source: CREDENTIAL_SOURCES.OVERRIDE,
          seedGlobal: false,
        };
      }

      if (resolved.seedGlobal) {
        await this.refreshDevicesUsingGlobalCredentials({
          reason: 'pairing seed',
          force: true,
        });
      }

      return {
        ...resolved,
        settings: getPairedCredentialSettings(resolved),
      };
    });
  }

  async getCredentialStatus() {
    const globalCredentials = this.getGlobalCredentials();
    const summary = this.getCredentialDeviceSummary(globalCredentials);

    return {
      configured: Boolean(globalCredentials),
      usernameHint: globalCredentials ? maskUsername(globalCredentials.username) : '',
      devices: summary,
      validation: globalCredentials ? this._credentialValidation : { status: 'unverified' },
    };
  }

  async saveGlobalCredentials(input = {}) {
    const credentials = assertValidCredentialPair(input);

    return this.withCredentialMutation(async () => {
      const validation = await this.validateGlobalCredentials(credentials);
      if (validation.status === 'rejected') {
        throw new Error(
          'The selected TP-Link device rejected these account credentials. The global credentials were not changed.',
        );
      }

      this.homey.settings.set(GLOBAL_CREDENTIALS_KEY, {
        username: credentials.username,
        password: credentials.password,
      });
      this._globalCredentialRefreshVersion += 1;
      this._credentialValidation = { ...validation, checkedAt: new Date().toISOString() };
      const refreshed = await this.refreshDevicesUsingGlobalCredentials({
        reason: 'global credentials updated',
        force: true,
      });

      this.log(`TP-Link global credentials saved (${validation.status})`);
      return {
        saved: true,
        validation,
        refreshed,
        status: await this.getCredentialStatus(),
      };
    });
  }

  async clearGlobalCredentials() {
    return this.withCredentialMutation(async () => {
      this.homey.settings.unset(GLOBAL_CREDENTIALS_KEY);
      this._globalCredentialRefreshVersion += 1;
      this._credentialValidation = { status: 'unverified' };
      const refreshed = await this.refreshDevicesUsingGlobalCredentials({
        reason: 'global credentials cleared',
        force: true,
      });

      this.log('TP-Link global credentials cleared');
      return {
        cleared: true,
        refreshed,
        status: await this.getCredentialStatus(),
      };
    });
  }

  async adoptMatchingLegacyDevices() {
    return this.withCredentialMutation(async () => {
      const globalCredentials = this.getGlobalCredentials();
      if (!globalCredentials) {
        throw new Error(
          'Save complete global TP-Link account credentials before adopting legacy devices.',
        );
      }

      const adopted = [];
      const skipped = [];
      const failed = [];

      for (const entry of this.getManagedDevices()) {
        const settings = entry.device.getSettings();
        const source = getCredentialSource(settings);
        const hasMatchingLocalPair = credentialsMatch(settings, globalCredentials);

        if (source === CREDENTIAL_SOURCES.OVERRIDE || !hasMatchingLocalPair) {
          skipped.push(entry.key);
          continue;
        }

        try {
          // Persist the global source first. Programmatic setSettings does not call
          // onSettings, so refresh the client explicitly after clearing the copy.
          await entry.device.setSettings({
            credentialSource: CREDENTIAL_SOURCES.GLOBAL,
          });
          await entry.device.setSettings({
            deviceUsername: '',
            devicePassword: '',
          });
          if (typeof entry.device.refreshGlobalCredentials === 'function') {
            await entry.device.refreshGlobalCredentials({
              force: true,
              version: this._globalCredentialRefreshVersion,
              reason: 'legacy credentials adopted',
            });
          }
          adopted.push(entry.key);
        } catch (error) {
          failed.push(entry.key);
          this.error(
            `Unable to adopt credentials for ${entry.driverId} device: ${getSafeErrorMessage(
              error,
              globalCredentials,
              settings,
            )}`,
          );
        }
      }

      return {
        adopted,
        skipped,
        failed,
        status: await this.getCredentialStatus(),
      };
    });
  }

  async testGlobalCredentials(input = {}) {
    const ipAddress = typeof input.ip === 'string' ? input.ip.trim() : '';
    if (input.ip !== undefined &&
        (typeof input.ip !== 'string' || (ipAddress && isIP(ipAddress) !== 4))) {
      throw new Error('Enter a valid device IPv4 address.');
    }
    return this.withCredentialMutation(async () => {
      const credentials = this.getGlobalCredentials();
      if (!credentials) throw new Error('Save the TP-Link account before testing it.');
      const validation = await this.validateGlobalCredentials(credentials, ipAddress);
      this._credentialValidation = { ...validation, checkedAt: new Date().toISOString() };
      this.log(`TP-Link saved credential test: ${validation.status}`);
      return { validation: this._credentialValidation, status: await this.getCredentialStatus() };
    });
  }

  async validateGlobalCredentials(credentials, targetIp = '') {
    const candidates = [];
    const seenTargets = new Set();
    this.getManagedDevices().forEach(entry => {
      if (targetIp) return;
      if (!this.isEligibleValidationDevice(entry, credentials)) return;

      const settings = entry.device.getSettings();
      const ipAddress = getDeviceIpAddress(settings);
      // KS240 child channels share one authenticated parent target. More
      // generally, avoid retrying the same model/IP pair during one save.
      const targetKey = `${entry.driverId}:${ipAddress}`;
      if (seenTargets.has(targetKey)) return;
      seenTargets.add(targetKey);
      candidates.push({ entry, settings, ipAddress });
    });

    if (targetIp) {
      candidates.push({
        entry: { driverId: 'ks240', device: { getData: () => ({}) } },
        ipAddress: targetIp,
      });
    }

    if (candidates.length === 0) {
      return {
        status: 'unverified',
        reason: 'No eligible paired authenticated device is available for local validation.',
      };
    }

    let sawReachabilityError = false;
    for (const candidate of candidates) {
      try {
        const client = createCredentialValidationClient(
          candidate.entry.driverId,
          candidate.entry.device,
          credentials,
        );
        const sysInfo = candidate.entry.driverId === 'ks240'
          ? await getKs240SysInfo(client, candidate.ipAddress)
          : await client.getSysInfo(candidate.ipAddress);
        if (targetIp && (!sysInfo || !sysInfo.model)) {
          throw new Error('The target did not return TP-Link device information.');
        }
        return {
          status: 'validated',
          reason: 'Local connection succeeded using the saved account settings. This does not test TP-Link cloud login.',
        };
      } catch (error) {
        if (isAuthenticationError(error) && !isReachabilityError(error)) {
          return {
            status: 'rejected',
            reason: 'The TP-Link device rejected local authentication. Check the device owner account, exact email spelling and password. A KLAP challenge mismatch can also indicate incompatible firmware.',
            error: getSafeErrorMessage(error, credentials),
          };
        }

        if (isReachabilityError(error)) sawReachabilityError = true;
        this.log(
          `TP-Link global credential validation was inconclusive for ${candidate.entry.driverId}: ${getSafeErrorMessage(
            error,
            credentials,
          )}`,
        );
      }
    }

    return {
      status: 'unverified',
      reason: sawReachabilityError
        ? 'The selected TP-Link devices were offline or timed out.'
        : 'The selected TP-Link devices could not provide conclusive local validation.',
    };
  }

  getManagedDevices() {
    if (!this.homey.drivers || typeof this.homey.drivers.getDrivers !== 'function') {
      return [];
    }

    const drivers = this.homey.drivers.getDrivers();
    const entries = [];
    Object.entries(drivers).forEach(([fallbackId, driver]) => {
      const sourceDriverId = getDriverId(driver, fallbackId);
      if ((!MANAGED_DRIVER_IDS.has(sourceDriverId) && sourceDriverId !== 'kasa') || !driver) return;

      let devices = [];
      try {
        devices = driver.getDevices();
      } catch (error) {
        this.error(`Unable to list ${sourceDriverId} devices: ${getSafeErrorMessage(error)}`);
      }

      devices.forEach((device, index) => {
        const data = device.getData ? getDeviceConnectionData(device) : {};
        const driverId = sourceDriverId === 'kasa' ? data.modelDriver : sourceDriverId;
        if (!MANAGED_DRIVER_IDS.has(driverId)) return;
        entries.push({
          driverId,
          device,
          key: sourceDriverId === 'kasa'
            ? `${sourceDriverId}:${driverId}:${data.id || index}:${data.childId || ''}`
            : `${driverId}:${data.id || index}`,
        });
      });
    });
    return entries;
  }

  getCredentialDeviceSummary(globalCredentials = this.getGlobalCredentials()) {
    const summary = {
      global: 0,
      override: 0,
      legacy: 0,
      unavailable: 0,
    };

    this.getManagedDevices().forEach(entry => {
      // A persisted TCP transport is a confirmed credential-free device. Do not
      // present it in the account-source summary, even if old settings contain
      // a stale source marker.
      if (
        DUAL_TRANSPORT_DRIVER_IDS.has(entry.driverId) &&
        getDeviceConnectionData(entry.device).transport === 'tcp'
      ) {
        return;
      }
      const settings = entry.device.getSettings();
      const resolved = resolveDeviceCredentials(settings, globalCredentials);
      if (!resolved.credentials) {
        summary.unavailable += 1;
      } else if (resolved.source === CREDENTIAL_SOURCES.GLOBAL) {
        summary.global += 1;
      } else if (resolved.source === CREDENTIAL_SOURCES.OVERRIDE) {
        summary.override += 1;
      } else {
        summary.legacy += 1;
      }
    });
    return summary;
  }

  isEligibleValidationDevice(entry, credentials) {
    const settings = entry.device.getSettings();
    const ipAddress = getDeviceIpAddress(settings);
    if (!ipAddress) return false;

    const source = getCredentialSource(settings);
    if (source === CREDENTIAL_SOURCES.OVERRIDE) return false;
    if (!source && hasCompleteCredentials(settings) && !credentialsMatch(settings, credentials)) {
      return false;
    }

    if (AUTHENTICATED_DRIVER_IDS.has(entry.driverId)) return true;
    if (!DUAL_TRANSPORT_DRIVER_IDS.has(entry.driverId)) return false;

    const data = getDeviceConnectionData(entry.device);
    return getEp10Transport(data, settings, credentials) !== 'tcp';
  }

  shouldRefreshGlobalCredentials(entry) {
    const settings = entry.device.getSettings();
    const source = getCredentialSource(settings);
    if (source === CREDENTIAL_SOURCES.OVERRIDE) return false;

    // Unmarked devices with their own complete legacy pair keep that pair until
    // the user explicitly adopts them. Pre-transport, credential-empty dual-transport devices
    // also remain TCP and must not be refreshed with a new global account.
    if (!source && hasCompleteCredentials(settings)) return false;

    if (!DUAL_TRANSPORT_DRIVER_IDS.has(entry.driverId)) return true;
    const data = getDeviceConnectionData(entry.device);
    // A source marker keeps this pre-transport device linked to the global
    // account. On a global clear it must still refresh so its in-memory KLAP
    // client is replaced by the resulting TCP fallback.
    if (source === CREDENTIAL_SOURCES.GLOBAL && data.transport !== 'tcp') {
      return true;
    }
    return getEp10Transport(data, settings, this.getGlobalCredentials()) !== 'tcp';
  }

  async refreshDevicesUsingGlobalCredentials({ reason, force } = {}) {
    const version = this._globalCredentialRefreshVersion;
    const entries = this.getManagedDevices().filter(entry =>
      this.shouldRefreshGlobalCredentials(entry),
    );
    const results = await Promise.allSettled(
      entries.map(async entry => {
        if (typeof entry.device.refreshGlobalCredentials !== 'function') {
          return false;
        }
        return entry.device.refreshGlobalCredentials({ reason, force, version });
      }),
    );

    return {
      attempted: entries.length,
      refreshed: results.filter(result => result.status === 'fulfilled' && result.value)
        .length,
      failed: results.filter(
        result => result.status !== 'fulfilled' || result.value !== true,
      ).length,
    };
  }

  async withCredentialMutation(operation) {
    const previous = this._credentialMutation || Promise.resolve();
    let release;
    this._credentialMutation = new Promise(resolve => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

module.exports = TpLinkApp;
