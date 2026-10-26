'use strict';
const { LanDriver } = require('../../lib/lan-pairing');
module.exports = class Ks200Driver extends LanDriver {
  get modelFilter() { return 'ks200'; }
};
