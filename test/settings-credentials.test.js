'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('settings calls ready first, shows green only for a successful local test, and clears stale feedback', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  const translations = require('../locales/en.json').settings;
  const elements = new Map();
  const calls = [];
  let current = { configured: true, validation: { status: 'unverified' } };
  let diagnosticFailure = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false, attributes: {}, handlers: {},
      classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() {},
    });
    return elements.get(id);
  };
  const context = { window: {}, document: { getElementById: id => {
    assert.equal(calls[0], 'ready');
    return element(id);
  } } };
  vm.runInNewContext(script, context);
  const Homey = {
    ready() { calls.push('ready'); },
    __(key, values = {}) {
      let text = key.replace('settings.', '').split('.').reduce((value, part) => value[part], translations);
      assert.equal(typeof text, 'string', key);
      for (const [name, value] of Object.entries(values)) text = text.replace('__' + name + '__', value);
      return text;
    },
    api(method, url, body, callback) {
      calls.push({ method, url, body });
      if (url === '/discovery/settings') return body(null, { targets: '' });
      if (url === '/diagnostics/hs220') {
        assert.equal(element('diagnostics').disabled, true);
        return callback(diagnosticFailure ? new Error('test failure') : null, { scan: 'finished', devices: [] });
      }
      if (method === 'GET') body(null, current);
      else callback(null, { status: current, validation: current.validation });
    },
    alert() { assert.fail('Homey.alert opens a browser prompt in the web client'); },
    confirm() { assert.fail('Browser confirmation prompts are forbidden'); },
    prompt() { assert.fail('Browser input prompts are forbidden'); },
  };
  context.window.onHomeyReady(Homey);
  await new Promise(resolve => setImmediate(resolve));
  const status = element('credential-validation');
  assert.equal(status.attributes['data-state'], 'unverified');
  assert.equal(status.textContent.includes('\u2713'), false);
  assert.equal(element('account-editor').open, false);
  element('test-ip').value = '192.168.10.103';
  current = { configured: true, validation: { status: 'validated', checkedAt: '2026-09-13T16:00:00.000Z' } };
  await element('test').handlers.click();
  assert.equal(status.attributes['data-state'], 'validated');
  assert.match(status.textContent, /^\u2713 Local connection succeeded/);
  assert.match(status.textContent, /Last tested:/);
  assert.equal(calls.at(-1).body.ip, '192.168.10.103');
  assert.equal(element('test').disabled, false);

  element('password').value = 'unsaved-password';
  const previousCalls = calls.length;
  await element('test').handlers.click();
  assert.equal(calls.length, previousCalls);
  assert.equal(element('settings-error-dialog').open, true);
  assert.equal(element('settings-error-message').textContent, translations.credentials.saveBeforeTest);
  element('settings-error-close').handlers.click();
  assert.equal(element('settings-error-dialog').open, false);
  element('password').value = '';

  current = { configured: true, validation: { status: 'rejected', error: 'KLAP challenge mismatch' } };
  await element('test').handlers.click();
  assert.equal(status.attributes['data-state'], 'rejected');
  assert.match(status.textContent, /KLAP challenge mismatch/);
  assert.equal(status.textContent.includes('\u2713'), false);

  current = { configured: true, validation: { status: 'unverified' } };
  element('username').value = 'new@example.com';
  element('password').value = 'new-password';
  await element('save').handlers.click();
  assert.equal(status.attributes['data-state'], 'unverified');
  assert.equal(element('password').value, '');
  assert.equal(element('account-editor').open, false);

  current = { configured: false, validation: { status: 'unverified' } };
  context.window.confirm = () => assert.fail('Browser confirmation prompts are forbidden');
  let clearPending = element('clear').handlers.click();
  assert.equal(element('credential-clear-dialog').open, true);
  assert.notEqual(calls.at(-1).url, '/credentials/clear');
  element('credential-clear-cancel').handlers.click();
  await clearPending;
  assert.notEqual(calls.at(-1).url, '/credentials/clear');
  clearPending = element('clear').handlers.click();
  element('credential-clear-confirm').handlers.click();
  await clearPending;
  assert.equal(element('credential-clear-dialog').open, false);
  assert.equal(calls.at(-1).url, '/credentials/clear');
  assert.equal(status.hidden, true);
  assert.equal(element('account-editor').open, true);

  await element('diagnostics').handlers.click();
  assert.equal(element('diagnostics').disabled, false);
  assert.equal(element('diagnostics-report').hidden, false);
  assert.equal(JSON.parse(element('diagnostics-report').value).scan, 'finished');
  assert.match(element('diagnostics-status').textContent, /Report ready/);
  assert.deepEqual(Object.keys(calls.at(-1).body), []);
  diagnosticFailure = true;
  await element('diagnostics').handlers.click();
  assert.equal(element('diagnostics').disabled, false);
  assert.equal(element('diagnostics-report').hidden, true);
  assert.equal(element('diagnostics-report').value, '');
  assert.match(element('diagnostics-status').textContent, /Unable to collect/);
});
