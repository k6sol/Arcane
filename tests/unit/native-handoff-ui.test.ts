import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHandoffList, readHandoffOutcome } from '../../apps/desktop/src/native-handoff.js';

const id = 'a1223344-5566-7788-99aa-bbccddeeff00';
const row = { handoffId: id, state: 'sealed', createdAt: '2026-10-16T07:00:00.000Z', expiresAt: '2026-10-16T07:30:00.000Z', sealedAt: '2026-10-16T07:01:00.000Z', endedAt: null, owned: true };
const listed = { state: 'listed', projectId: 'a'.repeat(64), handoffs: [row] };
const opened = { state: 'opened', reason: null, message: 'Opened.', handoffId: id, expiresAt: row.expiresAt };
test('handoff presentation accepts bounded detached status and refuses authority, unknown fields and getters', () => {
  const out = readHandoffList(listed); assert.deepEqual(out, [row]); assert.ok(Object.isFrozen(out) && Object.isFrozen(out[0]));
  assert.notEqual(out[0], row); assert.equal(readHandoffOutcome(opened).state, 'opened');
  for (const value of [{ ...listed, token: 'x' }, { ...listed, handoffs: [row, row] }, { ...listed, handoffs: new Array(2) },
    { ...listed, handoffs: [{ ...row, credential: 'x' }] }, { ...listed, handoffs: [{ ...row, expiresAt: 'later' }] }]) assert.throws(() => readHandoffList(value));
  for (const value of [{ ...opened, env: {} }, { ...opened, state: 'connected' }, { ...opened, expiresAt: null }, { ...opened, handoffId: null },
    { ...opened, message: 'bad\noutput' }]) assert.throws(() => readHandoffOutcome(value));
  let reads = 0; const hostile = { ...listed }; Object.defineProperty(hostile, 'handoffs', { enumerable: true, get() { reads++; return [row]; } });
  assert.throws(() => readHandoffList(hostile)); assert.equal(reads, 0);
});

test('real Edge handoff controls require explicit choices, preserve native uncertainty and fence stopped replies', {
  skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 30000,
}, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const js = await readFile(join(build, 'apps/desktop/src/native-handoff.js')), css = await readFile('apps/desktop/public/studio.css');
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0], value = path === '/fixture' ? html : path === '/native-handoff.js' ? js : path === '/studio.css' ? css : null;
    res.writeHead(value ? 200 : 404, { 'Content-Type': path === '/fixture' ? 'text/html' : path === '/studio.css' ? 'text/css' : 'text/javascript' }); res.end(value ?? '');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/fixture');
  await page.evaluate(async ({ opened, listed }: any) => {
    const path: string = '/native-handoff.js', module = await import(path), w = window as any;
    w.calls = []; w.listed = listed; w.opened = opened; w.hold = false; w.unknown = false;
    w.choices = { cliVersion: '2.1.177', aliases: ['opus', 'sonnet'], efforts: ['low', 'high', 'max'] };
    const listeners = new Set<() => void>();
    w.updateChoices = (choices: unknown) => { w.choices = choices; for (const listener of listeners) listener(); };
    const bridge = Object.freeze({ version: 1,
      launch: async (profile: unknown) => { w.calls.push({ action: 'launch', profile }); if (w.hold) return new Promise(resolve => { w.release = resolve; });
        return w.unknown ? { state: 'unknown', reason: 'launch_unconfirmed', message: 'Unknown.', handoffId: opened.handoffId, revocation: 'unknown', cleanup: 'removed' } : opened; },
      list: async () => { w.calls.push({ action: 'list' }); return w.listed; },
      revoke: async (id: string) => { w.calls.push({ action: 'revoke', id }); w.listed = { ...w.listed, handoffs: w.listed.handoffs.map((row: any) => ({ ...row, state: 'revoked', endedAt: row.expiresAt })) };
        return { state: 'revoked', reason: null, message: 'Revoked.', handoffId: id, cleanup: 'removed' }; },
    });
    w.controller = module.startNativeHandoff(document, { provider: { handoffChoices: () => w.choices, subscribeHandoffChoices: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } }, nativeBridge: bridge });
    for (const pane of document.querySelectorAll<HTMLElement>('[data-settings-section]')) pane.hidden = pane.id !== 'settings-connections';
    (document.getElementById('settings-drawer') as HTMLDialogElement).showModal();
  }, { opened, listed });
  const launch = page.locator('#native-handoff-launch');
  assert.deepEqual(await page.evaluate(() => (window as any).calls), []);
  assert.equal(await page.locator('#native-handoff-model').inputValue(), ''); assert.equal(await page.locator('#native-handoff-effort').inputValue(), ''); assert.equal(await launch.isDisabled(), true);
  await page.locator('#native-handoff-model').selectOption('opus'); assert.equal(await launch.isDisabled(), true);
  await page.locator('#native-handoff-effort').selectOption('high'); assert.equal(await launch.isEnabled(), true);
  await launch.evaluate((el: HTMLButtonElement) => el.click()); assert.deepEqual(await page.evaluate(() => (window as any).calls), [], 'synthetic click has no authority');
  await launch.click({ modifiers: ['Alt'] }); assert.deepEqual(await page.evaluate(() => (window as any).calls), []);
  await launch.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).calls.length === 2 && !(document.getElementById('native-handoff-launch') as HTMLButtonElement).disabled);
  assert.deepEqual(await page.evaluate(() => (window as any).calls), [{ action: 'launch', profile: { model: 'opus', effort: 'high' } }, { action: 'list' }]);
  assert.match(await page.locator('#native-handoff-status').innerText(), /Confirm the connection in the terminal/);
  await page.getByRole('button', { name: 'Revoke handoff ' + id.slice(0, 8) }).click();
  await page.waitForFunction(() => (window as any).calls.length === 4); assert.match(await page.locator('#native-handoff-status').innerText(), /Handoff revoked/);
  assert.equal(await page.locator('#native-handoff-list button').count(), 0);
  await page.evaluate(() => (window as any).updateChoices(null));
  assert.equal(await page.locator('#native-handoff-model').inputValue(), ''); assert.equal(await launch.isDisabled(), true);
  await page.locator('#native-handoff-refresh').click(); await page.waitForFunction(() => (window as any).calls.length === 5);
  await page.evaluate(() => { const w = window as any; w.updateChoices({ cliVersion: '2.1.178', aliases: ['sonnet'], efforts: ['high'] }); w.unknown = true; });
  await page.locator('#native-handoff-model').selectOption('sonnet'); await page.locator('#native-handoff-effort').selectOption('high');
  await launch.click(); await page.waitForFunction(() => (window as any).calls.length === 7);
  assert.match(await page.locator('#native-handoff-status').innerText(), /outcome is unknown/);
  assert.match(await page.locator('#native-handoff-status').innerText(), /Revocation could not be confirmed/);
  assert.equal(await page.evaluate(() => (window as any).calls.filter((c: any) => c.action === 'launch').length), 2, 'unknown is not retried');
  await page.evaluate(() => { (window as any).hold = true; }); await launch.click();
  await page.waitForFunction(() => typeof (window as any).release === 'function');
  const before = await page.evaluate(() => (window as any).calls.length);
  await page.evaluate(() => { const w = window as any; w.controller.stop(); w.controller.resume(); w.release(w.opened); });
  await page.waitForFunction(() => document.getElementById('native-handoff-status')!.textContent === 'Choose a profile or check project handoffs.');
  assert.equal(await page.evaluate(() => (window as any).calls.length), before, 'stale launch reply triggers no followup read');
  assert.equal(await page.locator('#native-handoff-model').inputValue(), ''); assert.equal(await launch.isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const artifacts = process.env.ARCANE_UI_ARTIFACT_DIR;
  if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, 'native-handoff-390.png'), fullPage: true }); }
  assert.deepEqual(errors, []); await page.evaluate(() => (window as any).controller.cleanup());
});
