'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));

function settingsFixture(options = {}) {
  const elements = new Map();
  const state = { calls: [], alerts: [], savedTargets: options.targets || '', ...options };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false, attributes: {}, handlers: {},
      classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
    });
    return elements.get(id);
  };
  const context = { window: {
    confirm() { assert.fail('Browser confirmation prompts are forbidden'); },
    alert() { assert.fail('Browser alert prompts are forbidden'); },
    prompt() { assert.fail('Browser input prompts are forbidden'); },
  }, document: { getElementById: id => {
    assert.equal(state.calls[0], 'ready', 'Homey.ready must precede settings work');
    return element(id);
  } } };
  vm.runInNewContext(script, context);
  const Homey = {
    ready() { state.calls.push('ready'); },
    __(key) { return key; },
    alert(message, type) { state.alerts.push({ message, type }); },
    api(method, url, body, callback) {
      state.calls.push({ method, url, body: method === 'GET' ? undefined : body });
      const done = method === 'GET' ? body : callback;
      if (url === '/credentials/status') return done(state.credentialError || null, { configured: true, validation: { status: 'validated' } });
      if (url === '/discovery/settings') {
        if (method === 'GET') {
          if (state.deferLoad) { state.finishLoad = () => done(state.loadError || null, { targets: state.savedTargets }); return; }
          return done(state.loadError || null, { targets: state.savedTargets });
        }
        if (state.deferSave) { state.finishSave = () => done(state.saveError || null, { targets: body.targets }); return; }
        if (state.saveError) return done(state.saveError);
        state.savedTargets = state.canonicalTargets === undefined ? body.targets : state.canonicalTargets;
        return done(null, { targets: state.savedTargets });
      }
      if (url === '/credentials/clear') return done(null, { status: { configured: false, validation: {} } });
      return done(null, {});
    },
  };
  context.window.onHomeyReady(Homey);
  return { state, element, context };
}

test('discovery networks load independently after Homey.ready even if credential status fails', async () => {
  const { state, element } = settingsFixture({ targets: '192.168.181.0/24', credentialError: new Error('Credentials status unavailable') });
  await flush();
  assert.equal(state.calls[0], 'ready');
  assert(state.calls.some(call => call.url === '/credentials/status'));
  assert(state.calls.some(call => call.url === '/discovery/settings' && call.method === 'GET'));
  assert.equal(element('discovery-targets').value, '192.168.181.0/24');
  assert.match(element('discovery-status').textContent, /Saved discovery networks/);
  assert.equal(element('credential-status').textContent, 'Credentials status unavailable');
  assert.equal(element('discovery-save').disabled, false);
  assert.equal(state.alerts.length, 0);
});

test('editing discovery networks marks them unsaved and only the explicit save action persists them', async () => {
  const { state, element } = settingsFixture({ targets: '192.168.181.0/24' });
  await flush();
  const callsBefore = state.calls.length;
  element('discovery-targets').value = ' 192.168.181.0/24\n192.168.80.50 ';
  element('discovery-targets').handlers.input();
  assert.equal(state.calls.length, callsBefore);
  assert.match(element('discovery-status').textContent, /Unsaved changes/);
  await element('discovery-save').handlers.click();
  assert.equal(state.calls.at(-1).method, 'POST');
  assert.equal(state.calls.at(-1).url, '/discovery/settings');
  assert.equal(state.calls.at(-1).body.targets, '192.168.181.0/24\n192.168.80.50');
  assert.equal(element('discovery-targets').value, '192.168.181.0/24\n192.168.80.50');
  assert.equal(element('discovery-status').textContent, 'Discovery networks saved.');
  element('discovery-targets').value = '192.168.181.0/24';
  element('discovery-targets').handlers.input();
  assert.match(element('discovery-status').textContent, /Unsaved changes/);
});

test('the settings view accepts canonical saved targets returned by the backend', async () => {
  const { state, element } = settingsFixture({ canonicalTargets: '192.168.181.0/24' });
  await flush();
  element('discovery-targets').value = '192.168.181.5/24';
  element('discovery-targets').handlers.input();
  await element('discovery-save').handlers.click();
  assert.equal(state.calls.at(-1).body.targets, '192.168.181.5/24');
  assert.equal(element('discovery-targets').value, '192.168.181.0/24');
  assert.equal(element('discovery-status').textContent, 'Discovery networks saved.');
});

test('discovery clearing is explicit and saves an empty target list without changing credentials', async () => {
  const { state, element } = settingsFixture({ targets: '192.168.181.0/24' });
  await flush();
  element('username').value = 'unchanged@example.test';
  element('password').value = 'unsaved-password';
  await element('discovery-clear').handlers.click();
  assert.equal(state.calls.at(-1).url, '/discovery/settings');
  assert.equal(state.calls.at(-1).body.targets, '');
  assert.equal(element('discovery-targets').value, '');
  assert.match(element('discovery-status').textContent, /cleared.*Automatic discovery/);
  assert.equal(element('username').value, 'unchanged@example.test');
  assert.equal(element('password').value, 'unsaved-password');
  assert.equal(element('credential-validation').attributes['data-state'], 'validated');
});

for (const action of ['discovery-save', 'discovery-clear']) {
  test(`${action} failure keeps current edits and reports the error through Homey's modal`, async () => {
    const { state, element } = settingsFixture({ targets: '192.168.181.0/24' });
    await flush();
    element('discovery-targets').value = '192.168.0.0/8';
    element('discovery-targets').handlers.input();
    state.saveError = new Error('Choose a smaller private network.');
    await element(action).handlers.click();
    assert.equal(element('discovery-targets').value, '192.168.0.0/8');
    assert.equal(state.savedTargets, '192.168.181.0/24');
    assert.match(element('discovery-status').textContent, /not saved/);
    assert.deepEqual(state.alerts, [{ message: 'Choose a smaller private network.', type: 'error' }]);
    assert.equal(element('discovery-save').disabled, false);
    assert.equal(element('discovery-clear').disabled, false);
  });
}

test('discovery load failure does not block credential controls or a later explicit save', async () => {
  const { state, element } = settingsFixture({ loadError: new Error('Discovery settings unavailable') });
  await flush();
  assert.deepEqual(state.alerts, [{ message: 'Discovery settings unavailable', type: 'error' }]);
  assert.match(element('discovery-status').textContent, /Unable to load/);
  assert.equal(element('save').disabled, false);
  assert.equal(element('test').disabled, false);
  assert.equal(element('credential-validation').attributes['data-state'], 'validated');
  element('discovery-targets').value = '192.168.181.0/24';
  element('discovery-targets').handlers.input();
  await element('discovery-save').handlers.click();
  assert.equal(element('discovery-status').textContent, 'Discovery networks saved.');
});

test('a late discovery load does not overwrite addresses already entered by the user', async () => {
  const { state, element } = settingsFixture({ targets: '192.168.181.0/24', deferLoad: true });
  element('discovery-targets').value = '192.168.80.50';
  element('discovery-targets').handlers.input();
  state.finishLoad();
  await flush();
  assert.equal(element('discovery-targets').value, '192.168.80.50');
  assert.match(element('discovery-status').textContent, /Unsaved changes/);
});

test('duplicate saves are bounded and a late save result leaves newer edits unsaved', async () => {
  const { state, element } = settingsFixture({ targets: '192.168.181.0/24', deferSave: true });
  await flush();
  const pending = element('discovery-save').handlers.click();
  await element('discovery-save').handlers.click();
  assert.equal(state.calls.filter(call => call.method === 'POST' && call.url === '/discovery/settings').length, 1);
  assert.equal(element('discovery-save').disabled, true);
  element('discovery-targets').value = '192.168.80.50';
  element('discovery-targets').handlers.input();
  state.finishSave();
  await pending;
  assert.equal(element('discovery-targets').value, '192.168.80.50');
  assert.match(element('discovery-status').textContent, /Unsaved changes/);
  assert.equal(element('discovery-save').disabled, false);
});

test('credential-clear cancellation and Escape use an in-page dialog without changing credentials', async () => {
  const { state, element } = settingsFixture();
  await flush();
  element('username').value = 'unchanged@example.test';
  element('password').value = 'unsaved-password';
  for (const cancel of [() => element('credential-clear-cancel').handlers.click(),
    () => element('credential-clear-dialog').handlers.cancel({ preventDefault() {} })]) {
    const pending = element('clear').handlers.click();
    assert.equal(element('credential-clear-dialog').open, true);
    cancel();
    await pending;
    assert.equal(element('credential-clear-dialog').open, false);
    assert.equal(element('username').value, 'unchanged@example.test');
    assert.equal(element('password').value, 'unsaved-password');
  }
  assert.equal(state.calls.filter(call => call.url === '/credentials/clear').length, 0);
  assert.doesNotMatch(script, /window\.(?:confirm|prompt|alert)\s*\(/);
  assert.doesNotMatch(script, /localStorage/);
});
