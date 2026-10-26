'use strict';

const { isIP } = require('node:net');

const MAX_ADDRESSES = 64;
const MAX_NETWORKS = 8;
const MAX_DISCOVERY_HOSTS = 1024;
const MIN_NETWORK_PREFIX = 22;
const MAX_INPUT_LENGTH = 4096;

function integerAddress(address) {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function dottedAddress(value) {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

function privateAddress(value) {
  return (value >= 0x0a000000 && value <= 0x0affffff) ||
    (value >= 0xac100000 && value <= 0xac1fffff) ||
    (value >= 0xc0a80000 && value <= 0xc0a8ffff);
}

function parseNetwork(value) {
  const parts = value.split('/');
  if (parts.length !== 2 || isIP(parts[0]) !== 4 || !/^\d{1,2}$/.test(parts[1])) {
    throw new Error('Enter networks as private IPv4 CIDRs, such as 192.168.1.0/24.');
  }
  const prefix = Number(parts[1]);
  if (prefix < MIN_NETWORK_PREFIX || prefix > 32) {
    throw new Error('Use private IPv4 networks with a prefix from /22 to /32.');
  }
  const size = 2 ** (32 - prefix);
  const address = integerAddress(parts[0]);
  const first = Math.floor(address / size) * size;
  const last = first + size - 1;
  if (!privateAddress(first) || !privateAddress(last)) {
    throw new Error('Network discovery is limited to private IPv4 networks: 10.x.x.x, 172.16–31.x.x, or 192.168.x.x.');
  }
  // /31 point-to-point networks have two usable addresses; /32 names one host.
  const usableFirst = prefix <= 30 ? first + 1 : first;
  const usableLast = prefix <= 30 ? last - 1 : last;
  return { cidr: `${dottedAddress(first)}/${prefix}`, usableFirst, usableLast };
}

/**
 * Parse only explicitly supplied discovery targets. CIDRs expand to a bounded
 * UDP target list; callers must not turn these hosts into a TCP/HTTP sweep.
 * Individual addresses stay separate for deliberate direct-IP verification.
 */
function parseTargets(value = '') {
  if (typeof value !== 'string' || value.length > MAX_INPUT_LENGTH) {
    throw new Error('Enter device IPv4 addresses or private IPv4 networks.');
  }
  const addresses = new Set();
  const networks = new Map();
  const normalized = [];
  for (const entry of value.split(/[\s,;]+/).filter(Boolean)) {
    if (entry.includes('/')) {
      const network = parseNetwork(entry);
      if (!networks.has(network.cidr)) {
        networks.set(network.cidr, network);
        normalized.push(network.cidr);
      }
      if (networks.size > MAX_NETWORKS) throw new Error('Enter no more than 8 private IPv4 networks.');
    } else {
      if (isIP(entry) !== 4 || entry === '0.0.0.0' || entry === '255.255.255.255') {
        throw new Error('Enter individual device IPv4 addresses or private IPv4 CIDRs.');
      }
      if (!addresses.has(entry)) {
        addresses.add(entry);
        normalized.push(entry);
      }
      if (addresses.size > MAX_ADDRESSES) throw new Error('Enter no more than 64 individual device IPv4 addresses.');
    }
  }

  const discoveryHosts = new Set(addresses);
  for (const network of networks.values()) {
    for (let host = network.usableFirst; host <= network.usableLast; host++) {
      discoveryHosts.add(dottedAddress(host));
      if (discoveryHosts.size > MAX_DISCOVERY_HOSTS) {
        throw new Error('Discovery is limited to 1024 unique device addresses. Use fewer or smaller networks.');
      }
    }
  }

  return {
    addresses: [...addresses],
    networks: [...networks.keys()],
    discoveryHosts: [...discoveryHosts],
    normalized: normalized.join(', '),
  };
}

module.exports = { parseTargets };
