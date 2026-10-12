import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Connection, Selection } from '../../packages/protocol/src/providers.js';

// Execute the actual lab source in a small DOM/HTTP fixture. No browser, daemon,
// provider process, login or inference is started; Node's built-in strip avoids a build.
class LabElement {
  tagName: string;
  children: LabElement[] = [];
  className = '';
  disabled = false;
  private text = '';
  private selected = '';
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  get childElementCount() { return this.children.length; }
  get value() { return this.selected; }
  set value(value: string) { this.selected = this.tagName === 'SELECT' && !this.children.some(child => child.value === value) ? '' : value; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(' '); }
  set textContent(value: string) { this.text = value; this.children = []; }
  set innerHTML(_value: string) { throw new Error('Untrusted HTML insertion'); }
  set outerHTML(_value: string) { throw new Error('Untrusted HTML replacement'); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: LabElement[]) {
    const first = !this.children.length;
    this.children.push(...nodes);
    if (this.tagName === 'SELECT' && first) this.selected = nodes[0]?.value ?? '';
  }
  replaceChildren(...nodes: LabElement[]) { this.text = ''; this.selected = ''; this.children = []; this.append(...nodes); }
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  dispatch(type: string) {
    const event = new Event(type, { cancelable: true });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}
const TOKEN = 'a'.repeat(64);
const turn = () => new Promise<void>(done => setImmediate(done));
function connection(patch: Partial<Connection> = {}): Connection {
  return { provider: 'codex', installed: true, version: 'fixture-only', auth: 'subscription', plan: null,
    models: [{ id: 'exact-fixture-model', label: 'Fixture model', efforts: ['low', 'ultra'], defaultEffort: 'low', source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: [] }],
    features: [{ id: 'coding', label: 'Coding', state: 'native-handoff', route: 'native-client', reason: 'Fixture route; use the native client.' }],
    warnings: [], observedAt: '2026-10-12T00:00:00Z', revision: 'exact-fixture-revision', ...patch };
}
async function fixture(options: { token?: string; connections?: Connection[]; selection?: Selection | null; holdProbe?: Promise<void> } = {}) {
  const html = await readFile(resolve('apps/desktop/public/index.html'), 'utf8');
  const source = await readFile(resolve('apps/desktop/src/lab.ts'), 'utf8');
  const elements = new Map<string, LabElement>();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2]!, new LabElement(match[1]!));
  const get = (id: string) => { const element = elements.get(id); assert.ok(element, 'Actual markup includes ' + id); return element; };
  const addOption = (id: string, value: string, text: string) => { const node = new LabElement('option'); node.value = value; node.textContent = text; get(id).append(node); };
  addOption('provider', 'codex', 'Codex'); addOption('provider', 'claude', 'Claude Code');
  addOption('model', '', 'Refresh to discover models'); addOption('effort', '', 'Choose a model first');
  get('model').disabled = get('effort').disabled = get('save').disabled = true;
  const storage = new Map<string, string>();
  const calls: { path: string; method: string; body: Record<string, string> | undefined; authorization: string | undefined }[] = [];
  let saved = options.selection ?? null, replaced = '';
  const state = () => ({ connections: options.connections ?? [], selection: saved, busy: false, warnings: [], inferenceRuns: 0 });
  runInNewContext(stripTypeScriptTypes(source), {
    document: { getElementById: get, createElement: (tag: string) => new LabElement(tag) },
    location: { hash: options.token === '' ? '' : '#' + (options.token ?? TOKEN), pathname: '/' },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    history: { replaceState: (_state: unknown, _title: string, path: string) => { replaced = path; } },
    fetch: async (path: string, input: { method: string; body?: string; headers: Record<string, string> }) => {
      const body = input.body ? JSON.parse(input.body) as Record<string, string> : undefined;
      calls.push({ path, method: input.method, body, authorization: input.headers.Authorization });
      assert.ok(['/v1/state', '/v1/probe', '/v1/selection'].includes(path), 'Only existing metadata/preference routes are called');
      if (path === '/v1/probe') await options.holdProbe;
      if (path === '/v1/selection') {
        assert.ok(body);
        saved = { provider: body.provider as Selection['provider'], model: body.model!, effort: body.effort as Selection['effort'], connectionRevision: body.connectionRevision!, savedAt: 'fixture-time', applied: false };
      }
      return { ok: true, json: async () => path === '/v1/selection' ? { selection: saved } : state() };
    }
  }, { filename: 'lab-ui-fixture.js' });
  await turn();
  return { get, calls, storage, replaced, saved: () => saved };
}

test('lab markup exposes named controls, resolvable help and local navigation under self-only CSP', async () => {
  const html = await readFile(resolve('apps/desktop/public/index.html'), 'utf8');
  const css = await readFile(resolve('apps/desktop/public/lab.css'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!);
  assert.equal(ids.length, new Set(ids).size, 'Unique IDs');
  for (const id of ['provider', 'model', 'effort']) assert.match(html, new RegExp('<label for="' + id + '">[^<]+</label>'));
  for (const match of html.matchAll(/\baria-(?:labelledby|describedby)="([^"]+)"/g)) for (const id of match[1]!.split(/\s+/)) assert.ok(ids.includes(id), 'Help target exists: ' + id);
  for (const match of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(match[1]!));
  assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\bstyle=|\bon(?:click|load|error)=/i);
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) assert.match(match[1]!, /^(?:\/(?!\/)|#)/, 'Local asset or in-page destination');
  assert.doesNotMatch(css, /@import|https?:|data:/i);
  assert.match(css, /background-color:\s*#100c0c/); // The optional brand image has an independent opaque fallback.
  assert.match(css, /url\('\/brand\/arcane-ridges\.png'\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

test('missing local session makes no network call and offers launcher guidance', async () => {
  const f = await fixture({ token: '' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.get('refresh').disabled, true); assert.equal(f.get('save').disabled, true);
  assert.match(f.get('status').textContent, /Arcane Settings.*local session/);
  assert.equal(f.replaced, '/'); assert.equal(f.storage.size, 0);
  f.get('provider').value = 'claude'; f.get('provider').dispatch('change');
  assert.equal(f.get('login-command').textContent, 'claude auth login');
  assert.equal(f.calls.length, 0);
});

test('metadata-only empty fixture creates no connection, model or feature availability', async () => {
  const f = await fixture();
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/state', '/v1/probe']);
  assert.match(f.get('connections').textContent, /No provider metadata reported/);
  assert.match(f.get('features').textContent, /No feature metadata reported/);
  assert.deepEqual(f.get('model').children.map(child => child.value), ['']);
  assert.equal(f.get('model').disabled, true); assert.equal(f.get('effort').disabled, true); assert.equal(f.get('save').disabled, true);
  assert.equal(f.get('status').attributes.get('aria-busy'), 'false');
});

test('reported model/effort requires explicit selection and preserves the exact existing save payload', async () => {
  const f = await fixture({ connections: [connection()] });
  assert.equal(f.get('model').value, ''); assert.equal(f.get('effort').value, ''); assert.equal(f.get('save').disabled, true);
  assert.match(f.get('connections').textContent, /Subscription sign-in reported/);
  assert.match(f.get('connections').textContent, /Reported plan: not reported/);
  assert.match(f.get('features').textContent, /Use native client/);
  f.get('model').value = 'exact-fixture-model'; f.get('model').dispatch('change');
  assert.equal(f.get('effort').value, '', 'Reported default effort is not silently chosen');
  assert.equal(f.get('save').disabled, true);
  f.get('effort').value = 'ultra'; f.get('effort').dispatch('change'); assert.equal(f.get('save').disabled, false);
  assert.equal(f.get('selection').dispatch('submit').defaultPrevented, true); await turn();
  const request = f.calls.find(call => call.path === '/v1/selection'); assert.ok(request);
  assert.deepEqual(request.body, { provider: 'codex', model: 'exact-fixture-model', effort: 'ultra', connectionRevision: 'exact-fixture-revision' });
  assert.equal(request.authorization, 'Bearer ' + TOKEN); assert.equal(request.method, 'POST');
  assert.equal(f.saved()?.applied, false); assert.match(f.get('saved').textContent, /not applied to a task/);
  assert.equal(f.storage.get('arcane-lab-session'), TOKEN); assert.equal(f.replaced, '/');
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/state', '/v1/probe', '/v1/selection']);
});

test('missing installation and signed-out/API metadata explain why saving is unavailable', async () => {
  const cases: [Partial<Connection>, RegExp][] = [
    [{ installed: false, models: [] }, /Install this provider CLI/],
    [{ auth: 'signed-out' }, /reported subscription sign-in/],
    [{ auth: 'api-or-cloud' }, /API \/ cloud sign-in is separate/],
    [{ models: [] }, /No models were reported/]
  ];
  for (const [patch, message] of cases) {
    const f = await fixture({ connections: [connection(patch)] });
    f.get('model').value = 'exact-fixture-model'; f.get('model').dispatch('change');
    f.get('effort').value = 'ultra'; f.get('effort').dispatch('change');
    assert.equal(f.get('save').disabled, true); assert.match(f.get('selection-help').textContent, message);
    f.get('selection').dispatch('submit'); await turn();
    assert.equal(f.calls.some(call => call.path === '/v1/selection'), false);
  }
});

test('Claude keeps reported aliases and effort values and changes only the terminal guidance', async () => {
  const f = await fixture({ connections: [connection({ provider: 'claude', models: [{ id: 'fixture-alias', label: 'Fixture alias', efforts: ['high', 'max'], defaultEffort: null, source: 'native-cli-alias', entitlement: 'unverified', inputModalities: [] }] })] });
  f.get('provider').value = 'claude'; f.get('provider').dispatch('change');
  assert.equal(f.get('login-command').textContent, 'claude auth login');
  assert.deepEqual(f.get('model').children.map(child => child.value), ['', 'fixture-alias']);
  f.get('model').value = 'fixture-alias'; f.get('model').dispatch('change');
  assert.deepEqual(f.get('effort').children.map(child => child.value), ['', 'high', 'max']);
  assert.equal(f.get('effort').value, ''); assert.equal(f.get('save').disabled, true);
});

test('reported strings remain text, and an unavailable saved model is never replaced', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const c = connection({ plan: hostile, models: [{ ...connection().models[0]!, label: hostile }], features: [{ ...connection().features[0]!, label: hostile, reason: hostile }], warnings: [hostile] });
  const f = await fixture({ connections: [c], selection: { provider: 'codex', model: 'unavailable-saved-id', effort: 'ultra', connectionRevision: 'old-revision', savedAt: 'fixture-time', applied: false } });
  assert.equal(f.get('model').value, ''); assert.equal(f.get('effort').value, ''); assert.equal(f.get('save').disabled, true);
  assert.equal(f.get('model').children[1]?.textContent, hostile);
  for (const id of ['connections', 'features', 'warnings']) assert.ok(f.get(id).textContent.includes(hostile));
  assert.match(f.get('saved').textContent, /unavailable-saved-id.*not applied to a task/);
  assert.equal(f.calls.some(call => call.path === '/v1/selection'), false);
});

test('a pending metadata request marks status busy and blocks duplicate refresh/save actions', async () => {
  let finish!: () => void;
  const holdProbe = new Promise<void>(done => { finish = done; });
  const f = await fixture({ connections: [connection()], holdProbe });
  assert.equal(f.get('status').attributes.get('aria-busy'), 'true');
  for (const id of ['provider', 'model', 'effort', 'refresh', 'save']) assert.equal(f.get(id).disabled, true);
  f.get('refresh').dispatch('click'); f.get('selection').dispatch('submit'); await turn();
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/state', '/v1/probe']);
  finish(); await turn();
  assert.equal(f.get('status').attributes.get('aria-busy'), 'false');
  assert.equal(f.get('provider').disabled, false); assert.equal(f.get('refresh').disabled, false); assert.equal(f.get('save').disabled, true);
});


test('small text and enabled control boundaries retain usable contrast on charcoal surfaces', async () => {
  const css = await readFile(resolve('apps/desktop/public/lab.css'), 'utf8');
  const token = (name: string) => { const value = new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})').exec(css)?.[1]; assert.ok(value); return value; };
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  for (const [foreground, background] of [[token('text'), token('raised')], [token('muted'), token('raised')], [token('accent-text'), '#1c1213'], [token('warning'), '#2b241b'], [token('danger'), token('bg')], ['#ffffff', '#b52e34']]) {
    assert.ok(contrast(foreground!, background!) >= 4.5, 'Small text meets 4.5:1: ' + foreground + ' / ' + background);
  }
  const selectBorder = /(?:^|\n)select \{[^}]*border: 1px solid (#[0-9a-f]{6})/.exec(css)?.[1];
  const refreshBorder = /\.secondary \{[^}]*border-color: (#[0-9a-f]{6})/.exec(css)?.[1];
  assert.ok(selectBorder); assert.ok(refreshBorder);
  assert.ok(contrast(selectBorder, '#101010') >= 3, 'Select boundary meets 3:1');
  assert.ok(contrast(refreshBorder, '#1b1818') >= 3, 'Refresh button boundary meets 3:1');
});
