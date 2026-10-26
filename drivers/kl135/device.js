'use strict';

const KasaModelDevice = require('../../lib/kasa-model-device');

class Kl135Device extends KasaModelDevice {
  static model = 'KL135';
  static kind = 'bulb';
}

module.exports = Kl135Device;
