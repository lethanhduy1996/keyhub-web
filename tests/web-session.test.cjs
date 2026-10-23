'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const STORE_KEY = 'keyhub_remember_refresh_v1';
const URL_KEY = 'keyhub_api_url_v1';
const API_URL = 'https://api.example.com/api/v1';

function harness(initial = new Map()) {
  const saved = new Map(initial);
  if (!saved.has(URL_KEY)) saved.set(URL_KEY, API_URL);
  const elements = new Map();
  const app = {
    innerHTML: '',
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }
  };
  const toast = {textContent: '', className: ''};
  elements.set('app', app);
  elements.set('toast', toast);
  const requests = [];

  const license = (prefix, note, active) => ({
    id: prefix, prefix, note, owner_email: 'admin@example.com',
    created_at: 1700000000,
    expires_at: active ? 4100000000 : 1000000000,
    revoked_at: active ? null : 1000000000,
    device_limit: 1, device_count: 0, is_active: active
  });
  const values = {
    '/auth/login': {access_token: 'access-from-login', refresh_token: 'refresh-from-login'},
    '/auth/refresh': {access_token: 'access-from-restore', refresh_token: 'rotated-refresh'},
    '/me': {email: 'admin@example.com', is_admin: true, created_at: 1700000000},
    '/keys': [license('AABBCCDDEEFF', 'Testing device', true),
              license('001122334455', 'Old license', false)],
    '/api-keys': [],
    '/keys/check': {
      valid:true, expires_at:1792540800, device_code:null
    },
    '/health': {status: 'ok'},
    '/auth/logout': {message: 'Signed out'},
  };
  const sandbox = {
    crypto: {randomUUID: () => '3ba7b771-2918-4841-9ce8-99a2f59e981b'},
    document: {
      getElementById(id) {
        if (id === 'license-results' && !app.innerHTML.includes('id="license-results"')) return null;
        if (id === 'license-count' && !app.innerHTML.includes('id="license-count"')) return null;
        if (!elements.has(id)) elements.set(id, {innerHTML: '', textContent: ''});
        return elements.get(id);
      },
    },
    localStorage: {
      getItem: key => saved.has(key) ? saved.get(key) : null,
      setItem: (key,value) => saved.set(key, String(value)),
      removeItem: key => saved.delete(key)
    },
    fetch: async (url, init = {}) => {
      const relative = new URL(url).pathname.replace('/api/v1', '');
      requests.push({relative, init});
      const result = values[relative];
      if (!result) return {ok: false, status: 404, json: async () => ({detail: 'Missing route'})};
      return {ok: true, status: 200, json: async () => result};
    },
    navigator: {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    URL,
    FormData: class {
      constructor(form) {this.fields = Object.entries(form.fields || {});}
      [Symbol.iterator]() {return this.fields[Symbol.iterator]();}
    },
  };
  vm.runInNewContext(script, sandbox, {timeout: 2000});
  return {app, saved, requests, elements};
}

function form(fields, formName = 'login') {
  const names = new Set();
  const button = {
    disabled: false, isConnected: true, textContent:'Kích hoạt',
    classList: {add: cls => names.add(cls),
                remove: cls => names.delete(cls),
                contains: cls => names.has(cls)},
  };
  return {
    dataset: {form: formName}, fields, button,
    matches: selector => selector === 'form[data-form]',
    querySelector: () => button,
    setAttribute(){}, removeAttribute(){}
  };
}

async function flush() {
  for (let i=0;i<40;i++) await Promise.resolve();
}

test('remember opt-in stores rotated refresh token, never password', async () => {
  const h = harness();
  await h.app.handlers.submit({
    target: form({email:'admin@example.com',password:'keep-this-private',remember:'on'}),
    preventDefault(){}
  });
  assert.equal(h.saved.get(STORE_KEY), 'refresh-from-login');
  assert.ok(h.app.innerHTML.includes('Tổng quan'));
  assert.ok(![...h.saved.values()].some(s => s.includes('keep-this-private')));
  const reopen = harness(h.saved);
  await flush();
  assert.ok(reopen.requests.some(r=>r.relative==='/auth/refresh'));
  assert.equal(reopen.saved.get(STORE_KEY),'rotated-refresh');
  assert.ok(reopen.app.innerHTML.includes('Tổng quan'));
});

test('not remembering leaves no browser refresh token', async () => {
  const h = harness();
  await h.app.handlers.submit({
    target: form({email:'admin@example.com',password:'private-password'}),
    preventDefault(){}
  });
  assert.equal(h.saved.has(STORE_KEY), false);
});

test('license filter updates only result rows and keeps query field focused', async () => {
  const h = harness();
  await h.app.handlers.submit({
    target: form({email:'admin@example.com',password:'private-password'}),
    preventDefault(){}
  });
  await h.app.handlers.click({
    target: {closest: () => ({dataset:{action:'tab',tab:'keys'}})}
  });
  const fullHTML = h.app.innerHTML;
  assert.ok(fullHTML.includes('AABBCCDDEEFF'));
  assert.ok(fullHTML.includes('001122334455'));

  h.app.handlers.input({
    target: {value: 'old', matches: selector => selector === '[data-filter="license-query"]'}
  });
  const results = h.elements.get('license-results').innerHTML;
  assert.ok(results.includes('001122334455'));
  assert.ok(!results.includes('AABBCCDDEEFF'));
  assert.equal(h.app.innerHTML,fullHTML);

  h.app.handlers.change({
    target: {value:'active',matches: selector => selector === '[data-filter="license-status"]'}
  });
  assert.ok(h.elements.get('license-results').innerHTML.includes('Không tìm thấy'));
});

test('logout clears saved session token', async () => {
  const h = harness();
  await h.app.handlers.submit({
    target: form({email:'admin@example.com',password:'private-password',remember:'on'}),
    preventDefault(){}
  });
  assert.ok(h.saved.has(STORE_KEY));
  await h.app.handlers.click({
    target: {closest: () => ({dataset:{action:'logout'}})}
  });
  assert.equal(h.saved.has(STORE_KEY),false);
  assert.ok(h.app.innerHTML.includes('Đăng nhập KeyHub'));
});


test('web License check shows spinner and expiry without enrolling an IPA device', async () => {
  const h = harness();
  await h.app.handlers.submit({
    target: form({email:'admin@example.com', password:'private-password'}),
    preventDefault(){}
  });
  await h.app.handlers.click({
    target: {closest: () => ({dataset:{action:'tab',tab:'activate'}})}
  });
  const fields = form({key:'duyle-ABCDEF123456-lotsOfRandomLicenseCharacters'},'activate');
  const submit = h.app.handlers.submit({target:fields,preventDefault(){}});
  assert.equal(fields.button.disabled,true);
  assert.equal(fields.button.classList.contains('is-loading'),true);
  assert.ok(fields.button.textContent.includes('Đang kiểm tra'));
  await submit;
  assert.equal(fields.button.classList.contains('is-loading'),false);
  assert.equal(fields.button.disabled,false);
  assert.ok(h.app.innerHTML.includes('License còn hiệu lực'));
  assert.ok(h.app.innerHTML.includes('Hết hạn:'));
  const checks = h.requests.filter(r=>r.relative==='/keys/check');
  assert.equal(checks.length,1);
  assert.equal(checks[0].init.method,'POST');
  assert.ok(!checks[0].init.body.includes('device_id'));
  assert.ok(!checks[0].init.body.includes('Safari'));
  assert.equal(h.requests.some(r=>r.relative==='/keys/activate'),false);
  assert.equal(h.saved.has('keyhub_device_id_v1'),false);
});
