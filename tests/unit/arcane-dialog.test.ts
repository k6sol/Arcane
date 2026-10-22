import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDialogRequest } from '../../apps/desktop/src/arcane-dialog.js';

const request = { id: '00000000-0000-4000-8000-000000000001', type: 'question', title: 'Arcane Claude chat', message: 'Use Claude chat with Arcane project tools?',
  detail: 'Claude chat runs the installed Claude Code 2.1.301 in the background for this project.\n\nProject: C:\\Games\\Obby', buttons: ['Cancel', 'Allow', 'Always allow'], defaultId: 0, cancelId: 0 };

test('dialog requests are copied only when every field is exact and bounded', () => {
  assert.deepEqual(readDialogRequest(request), request);
  for (const patch of [{ id: 'x' }, { type: 'html' }, { buttons: [] }, { buttons: ['a', 'b', 'c', 'd', 'e'] }, { buttons: [''] }, { defaultId: 3 }, { cancelId: -1 }, { title: 'x'.repeat(121) }, { detail: 7 }])
    assert.equal(readDialogRequest({ ...request, ...patch }), null, JSON.stringify(patch));
});

test('real Edge in-app dialog: focus, Esc/Enter, inert page, Arcane styling, permissions card and screenshots', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const js = await readFile(join(build, 'apps/desktop/src/arcane-dialog.js'), 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const server = createServer((req, res) => {
    const p = req.url?.split('?')[0] ?? '';
    const value = p === '/fixture' ? html : p === '/arcane-dialog.js' ? js : p === '/studio.css' ? css : '';
    res.writeHead(value ? 200 : 404, { 'Content-Type': p === '/fixture' ? 'text/html' : p === '/studio.css' ? 'text/css' : 'text/javascript' }); res.end(value);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });
  for (const colorScheme of ['dark', 'light'] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme });
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(origin + '/fixture');
    await page.evaluate(async () => {
      const path: string = '/arcane-dialog.js', m = await import(path); const w = window as any;
      w.replies = []; w.saves = []; w.autoApprove = [];
      const log = [{ at: Date.UTC(2026, 9, 17, 12, 0, 0), summary: 'run npm test' }];
      const desktop = {
        dialogs: { attach: async (listener: (r: unknown) => void) => { w.push = listener; return { attached: true }; }, reply: async (answer: unknown) => { w.replies.push(answer); return { accepted: true }; } },
        projectPermissions: { read: async () => ({ available: true, settings: { claudeTools: true, codexAutoApprove: true } }),
          save: async (patch: Record<string, boolean>) => { w.saves.push(patch); return { saved: true, settings: { claudeTools: true, codexAutoApprove: true, ...patch } }; } } };
      m.startArcaneDialogs(document, { desktop, codex: { setAutoApprove: (on: boolean) => w.autoApprove.push(on), autoApprovals: () => log, subscribeAutoApprovals: () => () => {} } });
      document.getElementById('settings-drawer')?.setAttribute('open', '');
    });
    await page.waitForFunction(() => (window as any).autoApprove.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).autoApprove), [true], 'the saved project switch reaches the Codex chat');
    assert.equal(await page.locator('#permissions-claude-tools').isChecked(), true);
    assert.equal(await page.locator('#permissions-codex-auto').isChecked(), true);
    assert.equal(await page.locator('#permissions-state').textContent(), 'Auto-approve on');
    if (shots) await page.locator('#permissions-settings').screenshot({ path: join(shots, 'permissions-card-' + colorScheme + '.png') });
    await page.locator('#permissions-codex-auto').click();
    await page.waitForFunction(() => (window as any).saves.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).saves), [{ codexAutoApprove: false }]);
    assert.deepEqual(await page.evaluate(() => (window as any).autoApprove), [true, false], 'switching off stops auto-approval at once');
    await page.locator('#permissions-codex-auto').click();
    await page.waitForFunction(() => (window as any).saves.length === 2);

    const open = (value: unknown) => page.evaluate((v: unknown) => (window as any).push(v), value);
    await page.locator('#permissions-claude-tools').focus();
    await open({ ...request });
    const dialog = page.locator('.arcane-modal[role=dialog][aria-modal=true]');
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-labelledby'), 'arcane-modal-title-' + request.id);
    assert.equal(await page.locator('#arcane-modal-title-' + request.id).textContent(), 'Arcane Claude chat');
    assert.equal(await page.locator('.arcane-modal-detail').count(), 2, 'detail paragraphs');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'focus starts on the default (safe) button');
    assert.equal(await page.evaluate(() => (document.querySelector('.app-shell, body > :not(.arcane-modal-layer)') as HTMLElement).inert), true, 'the page behind is inert');
    const style = await page.evaluate(() => { const box = getComputedStyle(document.querySelector('.arcane-modal')!), primary = getComputedStyle(document.querySelector('.arcane-modal-primary')!);
      return { top: box.borderTopColor, animation: box.animationName, transition: box.transitionDuration, primaryTransition: primary.transitionDuration, primaryBg: primary.backgroundColor, primaryText: primary.color, label: document.querySelector('.arcane-modal-primary')!.textContent }; });
    assert.equal(style.top, 'rgb(255, 51, 64)'); assert.equal(style.primaryBg, 'rgb(200, 16, 46)'); assert.equal(style.primaryText, 'rgb(255, 255, 255)');
    assert.equal(style.label, 'Always allow');
    // C31 motion contract: the dialog rises in once (no transition on the panel); its buttons take the shared 120 ms fade and press.
    assert.equal(style.animation, 'c31-rise'); assert.equal(style.transition, '0s'); assert.match(style.primaryTransition, /^0\.12s(?:, 0\.12s)*$/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => { const box = getComputedStyle(document.querySelector('.arcane-modal')!), primary = getComputedStyle(document.querySelector('.arcane-modal-primary')!);
      return box.animationName + '|' + box.transitionDuration + primary.transitionDuration; }), 'none|0s0s', 'no motion with reduced motion');
    await page.emulateMedia({ reducedMotion: null });
    if (shots) await page.screenshot({ path: join(shots, 'in-app-dialog-' + colorScheme + '.png') });
    // Focus trap: Tab cycles inside the three buttons.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.arcane-modal')), true, 'Tab stays inside the dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).replies.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).replies), [{ id: request.id, response: 0 }], 'Esc answers cancel');
    assert.equal(await page.locator('.arcane-modal-layer').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'permissions-claude-tools', 'focus returns');
    // Enter on a non-button target answers the default; clicking answers that exact button; requests queue in order.
    await open({ ...request, id: '00000000-0000-4000-8000-000000000002', defaultId: 1 });
    await open({ ...request, id: '00000000-0000-4000-8000-000000000003', type: 'warning', title: 'Switch project', buttons: ['Cancel', 'Open project'] });
    await page.locator('.arcane-modal').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).replies.length === 2);
    await page.locator('.arcane-modal[role=alertdialog]').waitFor();
    if (shots && colorScheme === 'dark') await page.screenshot({ path: join(shots, 'in-app-dialog-warning.png') });
    await page.getByRole('button', { name: 'Open project' }).click();
    await page.waitForFunction(() => (window as any).replies.length === 3);
    assert.deepEqual(await page.evaluate(() => (window as any).replies.slice(1)), [{ id: '00000000-0000-4000-8000-000000000002', response: 1 }, { id: '00000000-0000-4000-8000-000000000003', response: 1 }]);
    await open({ ...request, id: 'not-a-uuid' });
    assert.equal(await page.locator('.arcane-modal-layer').count(), 0, 'a malformed request is ignored');
    await page.setViewportSize({ width: 390, height: 760 });
    await open({ ...request, id: '00000000-0000-4000-8000-000000000004' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow on a phone');
    if (shots && colorScheme === 'dark') await page.screenshot({ path: join(shots, 'in-app-dialog-mobile.png') });
    await page.keyboard.press('Escape');
    const beforeRecovery=await page.evaluate(()=>(window as any).replies.length);
    await open({...request,id:'00000000-0000-4000-8000-000000000005',buttons:['Close'],defaultId:0,cancelId:0});
    await page.evaluate(()=>document.dispatchEvent(new Event('workspace:runtimestopped')));
    assert.equal(await page.locator('.arcane-modal-layer').count(),0);
    await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>(window as any).replies.length),beforeRecovery,'Retired dialog listeners cannot answer another native request.');
    assert.deepEqual(errors, []);
    await context.close();
  }
});
