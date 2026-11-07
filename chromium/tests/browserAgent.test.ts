// The browser agent's tool schemas and the approval rules the native host enforces.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSER_TOOLS,
  FIXTURE_PATH,
  describeText,
  isFixture,
  looksSecret,
  review,
  validateArgs,
  type TargetInfo,
} from '../shared/browserAgent';

const FIXTURE = `http://127.0.0.1:4711${FIXTURE_PATH}index.html`;
const SITE = 'https://example.com/products';

function at(url: string, element?: Partial<NonNullable<TargetInfo['element']>>): TargetInfo {
  return {
    url,
    title: 'Page',
    element: element ? { tag: 'button', role: 'button', name: 'Button', ...element } : undefined,
    fingerprint: 'x',
  };
}

test('the tool set is the small one asked for, and has no JavaScript tool', () => {
  assert.deepEqual(
    BROWSER_TOOLS.map((t) => t.name).sort(),
    ['click', 'get_active_tab', 'list_tabs', 'navigate', 'press', 'read_page', 'scroll', 'switch_tab', 'type'].sort(),
  );
  for (const t of BROWSER_TOOLS) assert.doesNotMatch(`${t.name} ${t.description}`, /javascript|evaluate|script/i);
});

test('every schema is valid for strict function calling', () => {
  for (const tool of BROWSER_TOOLS) {
    const p = tool.parameters;
    assert.equal(p.type, 'object', tool.name);
    assert.equal(p.additionalProperties, false, tool.name);
    // Strict mode: every property is required (optional ones are nullable instead).
    assert.deepEqual([...p.required].sort(), Object.keys(p.properties).sort(), tool.name);
    for (const [key, prop] of Object.entries(p.properties) as [string, { type?: unknown; enum?: unknown[] }][]) {
      assert.ok(prop.type, `${tool.name}.${key} has a type`);
      if (prop.enum && Array.isArray(prop.type) && prop.type.includes('null')) assert.ok(prop.enum.includes(null), `${tool.name}.${key} enum allows null`);
    }
    assert.ok(tool.description.length > 10);
  }
});

test('arguments are checked against the schema', () => {
  assert.equal(validateArgs('click', { tabId: null, ref: 'e3' }), undefined);
  assert.match(validateArgs('click', { tabId: null })!, /Missing argument ref/);
  assert.match(validateArgs('click', { tabId: null, ref: 3 })!, /ref must be string/);
  assert.match(validateArgs('click', { tabId: null, ref: 'e1', selector: '#x' })!, /Unexpected argument selector/);
  assert.match(validateArgs('press', { tabId: null, key: 'F13', ref: null })!, /key must be one of/);
  assert.match(validateArgs('evaluate', { expression: '1' })!, /Unknown tool/);
  assert.match(validateArgs('scroll', [])!, /must be an object/);
});

test('reading, listing, switching and scrolling run without asking', () => {
  for (const name of ['list_tabs', 'get_active_tab', 'read_page', 'scroll', 'switch_tab'] as const) {
    assert.equal(review(name, {}).verdict, 'allow', name);
  }
});

test('on the local test page, a plain click runs; a submit button asks first', () => {
  assert.equal(isFixture(FIXTURE), true);
  assert.equal(review('click', {}, at(FIXTURE, { name: 'Increment counter', type: 'button' })).verdict, 'allow');
  const submit = review('click', {}, at(FIXTURE, { name: 'Go', submits: true, inForm: true }));
  assert.equal(submit.verdict, 'confirm');
  assert.match(submit.verdict === 'confirm' ? submit.reasons.join() : '', /submits a form/);
});

test('consequential clicks ask first: send, buy, delete, sign in, upload, download', () => {
  const cases: Array<Partial<NonNullable<TargetInfo['element']>>> = [
    { name: 'Send message' },
    { name: 'Place order' },
    { name: 'Buy now' },
    { name: 'Delete account' },
    { name: 'Sign in' },
    { name: 'Allow notifications' },
    { tag: 'input', type: 'file', name: 'Choose file' },
    { tag: 'a', role: 'link', name: 'Get the app', href: 'https://example.com/app.dmg' },
    { tag: 'a', role: 'link', name: 'Report', href: 'https://example.com/r', download: true },
    { tag: 'a', role: 'link', name: 'Your profile', href: 'https://accounts.example.com/' },
  ];
  for (const el of cases) {
    for (const url of [SITE, FIXTURE]) assert.equal(review('click', {}, at(url, el)).verdict, 'confirm', `${el.name} on ${url}`);
  }
});

test('away from the test page only plain links and show/hide controls run unasked', () => {
  assert.equal(review('click', {}, at(SITE, { tag: 'a', role: 'link', name: 'Pricing', href: 'https://example.com/pricing' })).verdict, 'allow');
  assert.equal(review('click', {}, at(SITE, { tag: 'summary', role: 'button', name: 'Details' })).verdict, 'allow');
  assert.equal(review('click', {}, at(SITE, { name: 'Menu', expandable: true })).verdict, 'allow');
  // An ordinary button could do anything on a real site.
  assert.equal(review('click', {}, at(SITE, { name: 'Next' })).verdict, 'confirm');
  // A missing or disabled element is refused, not guessed at.
  assert.equal(review('click', {}, at(SITE)).verdict, 'block');
  assert.equal(review('click', {}, at(SITE, { name: 'Next', disabled: true })).verdict, 'block');
});

test('typing a secret, or into a secret field, asks first and is masked', () => {
  const plain = review('type', { text: 'hello world' }, at(FIXTURE, { tag: 'input', type: 'text', name: 'Name', editable: true }));
  assert.equal(plain.verdict, 'allow');
  const password = review('type', { text: 'hunter2' }, at(SITE, { tag: 'input', type: 'password', name: 'Password', editable: true }));
  assert.equal(password.verdict, 'confirm');
  assert.ok(password.verdict === 'confirm' && password.sensitive);
  assert.doesNotMatch(password.verdict === 'confirm' ? password.summary : '', /hunter2/);
  const otp = review('type', { text: '123456' }, at(SITE, { tag: 'input', type: 'text', name: 'Code', autocomplete: 'one-time-code', editable: true }));
  assert.equal(otp.verdict, 'confirm');
  const key = review('type', { text: 'sk-proj-abcdefghijklmnopqrstuvwx' }, at(FIXTURE, { tag: 'input', type: 'text', name: 'Notes', editable: true }));
  assert.equal(key.verdict, 'confirm');
  assert.doesNotMatch(key.verdict === 'confirm' ? key.summary : '', /abcdefghij/);
  assert.equal(review('type', { text: 'x' }, at(SITE, { tag: 'input', type: 'file', name: 'Upload', editable: false })).verdict, 'block');
});

test('secrets are recognised, and ordinary text is not', () => {
  for (const s of ['sk-proj-1234567890abcdefghijkl', 'ghp_' + 'a'.repeat(36), 'AKIAIOSFODNN7EXAMPLE', '4111 1111 1111 1111', 'Tr0ub4dor&3-correct-horse!']) assert.ok(looksSecret(s), s);
  for (const s of ['hello world', 'search for flights to Zurich', '12345', 'https://example.com/a/b']) assert.ok(!looksSecret(s), s);
  assert.equal(describeText('hunter2', true), '•••••••• (7 characters)');
});

test('Enter in a form field asks first (it may submit or send); other keys run', () => {
  const field = at(FIXTURE, { tag: 'input', type: 'text', name: 'Message', editable: true, inForm: true });
  assert.equal(review('press', { key: 'Enter' }, field).verdict, 'confirm');
  assert.equal(review('press', { key: 'Tab' }, field).verdict, 'allow');
  assert.equal(review('press', { key: 'PageDown' }, at(SITE)).verdict, 'allow');
});

test('navigation: web pages open; sign-in and downloads ask; other schemes are refused', () => {
  assert.equal(review('navigate', { url: 'https://example.com/' }).verdict, 'allow');
  assert.equal(review('navigate', { url: 'https://accounts.google.com/signin' }).verdict, 'confirm');
  assert.equal(review('navigate', { url: 'https://github.com/login' }).verdict, 'confirm');
  assert.equal(review('navigate', { url: 'https://shop.example.com/checkout' }).verdict, 'confirm');
  assert.equal(review('navigate', { url: 'https://example.com/setup.pkg' }).verdict, 'confirm');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi', 'https://user:pw@example.com/']) {
    assert.equal(review('navigate', { url }).verdict, 'block', url);
  }
  assert.equal(review('navigate', { action: 'back' }).verdict, 'allow');
});

test('review fixes: Enter with nothing focused, scripted links, odd fields, arrows on choices', () => {
  assert.equal(review('press', { key: 'Enter' }, at(SITE)).verdict, 'confirm', 'Enter on the document of a real site');
  assert.equal(review('press', { key: 'Enter' }, at(FIXTURE)).verdict, 'allow', 'but not on the test page');
  for (const href of [`${SITE}#`, `${SITE}#open`, 'javascript:void(0)']) {
    assert.equal(review('click', {}, at(SITE, { tag: 'a', role: 'link', name: 'Weiter', href })).verdict, 'confirm', href);
  }
  assert.equal(review('click', {}, at(SITE, { tag: 'a', role: 'link', name: 'Docs', href: 'https://example.com/docs#intro' })).verdict, 'allow', 'an anchor on another page is a plain link');
  assert.equal(review('type', { text: 'x' }, at(SITE, { tag: 'input', type: 'text', name: 'Locked', editable: true, readonly: true })).verdict, 'block');
  assert.equal(review('type', { text: 'x' }, at(SITE, { tag: 'input', type: 'text', name: 'Off', editable: true, disabled: true })).verdict, 'block');
  assert.equal(review('type', { text: 'hi\nthere' }, at(SITE, { tag: 'div', role: 'textbox', name: 'Message', editable: true })).verdict, 'confirm');
  assert.equal(review('type', { text: 'hi\nthere' }, at(SITE, { tag: 'textarea', role: 'textbox', name: 'Notes', editable: true })).verdict, 'allow');
  assert.equal(review('press', { key: 'ArrowDown' }, at(SITE, { tag: 'select', role: 'combobox', name: 'Country' })).verdict, 'confirm');
  const long = review('type', { text: 'a'.repeat(100) }, at(FIXTURE, { tag: 'input', type: 'text', name: 'n', editable: true, inForm: false }));
  assert.equal(long.verdict, 'allow');
});

test('review fixes: navigation that could carry data away or reach private servers asks first', () => {
  assert.equal(review('navigate', { url: `https://evil.example/?d=${'x'.repeat(200)}` }).verdict, 'confirm');
  for (const url of ['http://192.168.1.1/admin', 'http://localhost:8080/', 'http://10.0.0.2/', 'https://example.com/logout']) {
    assert.equal(review('navigate', { url }).verdict, 'confirm', url);
  }
  assert.equal(review('navigate', { url: FIXTURE }).verdict, 'allow');
  const full = review('navigate', { url: `https://accounts.example.com/o/oauth2/auth?redirect_uri=${'y'.repeat(120)}` });
  assert.ok(full.verdict === 'confirm' && full.full?.includes('redirect_uri'), 'the card can show the whole address');
});
