'use strict';

const KasaModelDevice = require('../../lib/kasa-model-device');

class Ks200Device extends KasaModelDevice {
  static model = 'KS200';
  static kind = 'plug';
}

module.exports = Ks200Device;
