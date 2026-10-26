'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseTargets } = require('../lib/lan-targets');

test('discovery targets are optional and blank input does not imply a network', () => {
  const expected = { addresses: [], networks: [], discoveryHosts: [], normalized: '' };
  assert.deepEqual(parseTargets(), expected);
  assert.deepEqual(parseTargets('  , ; \n\t '), expected);
  assert.deepEqual(parseTargets('192.168.181.102').networks, [], 'An IP never supplies an inferred /24');
});

test('individual IPs retain direct-target identity and familiar separators', () => {
  const targets = parseTargets('192.168.181.102,192.168.181.104; 192.168.181.102\n192.0.2.1');
  assert.deepEqual(targets.addresses, ['192.168.181.102', '192.168.181.104', '192.0.2.1']);
  assert.deepEqual(targets.discoveryHosts, targets.addresses);
  assert.deepEqual(targets.networks, []);
  assert.equal(targets.normalized, '192.168.181.102, 192.168.181.104, 192.0.2.1');
  assert.deepEqual(parseTargets('127.0.0.1').addresses, ['127.0.0.1'], 'Explicit-IP behavior remains compatible with loopback protocol fixtures');
});

test('a /24 expands only usable hosts and canonicalizes the provided network', () => {
  const targets = parseTargets('192.168.181.102/24');
  assert.deepEqual(targets.addresses, []);
  assert.deepEqual(targets.networks, ['192.168.181.0/24']);
  assert.equal(targets.discoveryHosts.length, 254);
  assert.equal(targets.discoveryHosts[0], '192.168.181.1');
  assert.equal(targets.discoveryHosts.at(-1), '192.168.181.254');
  assert.equal(targets.discoveryHosts.includes('192.168.181.0'), false);
  assert.equal(targets.discoveryHosts.includes('192.168.181.255'), false);
  assert.equal(targets.normalized, '192.168.181.0/24');
});

test('private RFC1918 ranges and /22 network boundaries use unsigned IPv4 arithmetic', () => {
  for (const [input, network, first, last] of [
    ['10.254.7.200/22', '10.254.4.0/22', '10.254.4.1', '10.254.7.254'],
    ['172.16.3.254/22', '172.16.0.0/22', '172.16.0.1', '172.16.3.254'],
    ['172.31.255.254/22', '172.31.252.0/22', '172.31.252.1', '172.31.255.254'],
    ['192.168.255.254/22', '192.168.252.0/22', '192.168.252.1', '192.168.255.254'],
  ]) {
    const targets = parseTargets(input);
    assert.equal(targets.networks[0], network);
    assert.equal(targets.discoveryHosts.length, 1022);
    assert.equal(targets.discoveryHosts[0], first);
    assert.equal(targets.discoveryHosts.at(-1), last);
  }
});

test('/30 omits network and broadcast while /31 and /32 keep every host', () => {
  assert.deepEqual(parseTargets('192.168.1.3/30').discoveryHosts, ['192.168.1.1', '192.168.1.2']);
  assert.deepEqual(parseTargets('192.168.1.3/31').discoveryHosts, ['192.168.1.2', '192.168.1.3']);
  assert.deepEqual(parseTargets('192.168.1.3/32').discoveryHosts, ['192.168.1.3']);
});

test('overlapping networks and repeated entries generate one UDP target per host', () => {
  const targets = parseTargets('192.168.181.102,192.168.181.0/24,192.168.181.129/25,192.168.181.55/24,192.168.181.102/32');
  assert.deepEqual(targets.addresses, ['192.168.181.102']);
  assert.deepEqual(targets.networks, ['192.168.181.0/24', '192.168.181.128/25', '192.168.181.102/32']);
  assert.equal(targets.discoveryHosts.length, 254);
  assert.equal(new Set(targets.discoveryHosts).size, targets.discoveryHosts.length);
  assert.equal(targets.discoveryHosts[0], '192.168.181.102', 'Explicit targets retain first priority');
  assert.equal(targets.normalized, '192.168.181.102, 192.168.181.0/24, 192.168.181.128/25, 192.168.181.102/32');
});

test('explicit IPs inside a configured network remain eligible for direct verification', () => {
  const targets = parseTargets('192.168.181.0/24,192.168.181.102');
  assert.deepEqual(targets.addresses, ['192.168.181.102']);
  assert.equal(targets.discoveryHosts.length, 254);
});

test('narrow CIDRs can deliberately name hosts excluded by a wider network', () => {
  const targets = parseTargets('192.168.181.0/24,192.168.181.0/32,192.168.181.254/31');
  assert.equal(targets.discoveryHosts.length, 256);
  assert.equal(targets.discoveryHosts.includes('192.168.181.0'), true);
  assert.equal(targets.discoveryHosts.includes('192.168.181.255'), true);
});

test('up to 1024 unique discovery hosts are allowed across explicit IPs and all networks', () => {
  const permitted = parseTargets('192.168.0.0/22,10.0.0.1,10.0.0.2');
  assert.equal(permitted.discoveryHosts.length, 1024);
  assert.throws(() => parseTargets('192.168.0.0/22,10.0.0.1,10.0.0.2,10.0.0.3'), /1024 unique/);
  assert.throws(() => parseTargets('192.168.0.0/22,192.168.4.0/30,10.0.0.1'), /1024 unique/);
  assert.equal(parseTargets('192.168.0.0/22,192.168.0.10/24').discoveryHosts.length, 1022);
});

test('network and individual-address entry limits are enforced after duplicate canonicalization', () => {
  const networks = Array.from({ length: 8 }, (_, i) => `10.0.${i}.1/32`);
  assert.equal(parseTargets(networks.join(',')).networks.length, 8);
  assert.throws(() => parseTargets([...networks, '10.0.9.1/32'].join(',')), /no more than 8/);
  assert.equal(parseTargets(Array(20).fill('192.168.181.52/24').join(',')).networks.length, 1);
  const addresses = Array.from({ length: 64 }, (_, i) => `192.168.181.${i + 1}`);
  assert.equal(parseTargets(addresses.join(',')).addresses.length, 64);
  assert.throws(() => parseTargets([...addresses, '192.168.181.65'].join(',')), /no more than 64/);
});

test('public, shared, link-local, loopback, and multicast networks are rejected', () => {
  for (const input of ['8.8.8.8/32', '192.0.2.0/24', '100.64.0.0/22', '169.254.1.0/24',
    '127.0.0.1/32', '0.0.0.0/32', '224.0.0.0/24', '255.255.255.255/32',
    '172.15.255.255/22', '172.32.0.0/22', '192.169.0.0/22', '11.0.0.0/22']) {
    assert.throws(() => parseTargets(input), /private IPv4 networks/, input);
  }
});

test('malformed inputs and network prefixes outside the permitted range fail clearly', () => {
  for (const input of [null, {}, [], 42, 'x'.repeat(4097)]) {
    assert.throws(() => parseTargets(input), /IPv4 addresses|IPv4 networks/);
  }
  for (const input of ['192.168.181.1/21', '10.0.0.1/8', '192.168.181.1/33']) {
    assert.throws(() => parseTargets(input), /\/22 to \/32/);
  }
  for (const input of ['192.168.181.1/', '192.168.181.1/a', '192.168.181.1/024', '192.168.181.1/24/25',
    '192.168.181.999/24', '192.168.181.001/24', 'fe80::1/32', 'router.example/24',
    '192.168.181.0-192.168.181.255', '0.0.0.0', '255.255.255.255']) {
    assert.throws(() => parseTargets(input), /IPv4/, input);
  }
});
