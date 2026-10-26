'use strict';
const Homey = require('homey');
module.exports = class UnsupportedLanDevice extends Homey.Device {
  async onInit() { await this.setUnavailable('The saved device model is not supported.'); }
};
