'use strict';
const { LanDriver } = require('../../lib/lan-pairing');
module.exports = class Kl135Driver extends LanDriver {
  get modelFilter() { return 'kl135'; }
};
