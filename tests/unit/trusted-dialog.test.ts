import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The trusted decision window page (apps/desktop/electron/trusted-dialog.html) in real Edge, with a stub of its dedicated
// preload. Proves: textContent rendering, default-button focus, Tab stays on the buttons, Esc answers cancel, a click
// answers its button, and the page answers exactly once.
const request = { type: 'question', title: 'Arcane Claude chat', message: 'Use Claude chat with Arcane project tools?',
  detail: 'Claude chat runs in the background for this project.\n\n<b>Project</b>: C:\\Games\\Obby', buttons: ['Cancel', 'Allow', 'Always allow'], defaultId: 0, cancelId: 0 };

test('real Edge trusted decision window: focus, Tab, Esc = cancel, one answer, Arcane styling', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  // The packaged page only allows file: scripts and styles; this http fixture drops that meta and serves the same bytes.
  const html = (await readFile('apps/desktop/electron/trusted-dialog.html', 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  const js = await readFile('apps/desktop/electron/trusted-dialog.js', 'utf8'), css = await readFile('apps/desktop/electron/trusted-dialog.css', 'utf8');
  const server = createServer((req, res) => {
    const p = req.url?.split('?')[0] ?? '';
    const value = p === '/trusted-dialog.html' ? html : p === '/trusted-dialog.js' ? js : p === '/trusted-dialog.css' ? css : '';
    res.writeHead(value ? 200 : 404, { 'Content-Type': p.endsWith('.html') ? 'text/html' : p.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(value);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/trusted-dialog.html';
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });
  const open = async (value: typeof request) => {
    const context = await browser.newContext({ viewport: { width: 480, height: 300 } });
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.addInitScript((value: typeof request) => {
      const w = window as any; w.answers = []; w.readyHeights = [];
      w.arcaneTrustedDialog = Object.freeze({ version: 1, request: async () => value, ready: async (height: number) => { w.readyHeights.push(height); return { shown: true }; },
        answer: async (index: number) => { w.answers.push(index); return { accepted: true }; } });
    }, value);
    await page.goto(url); await page.waitForFunction(() => (window as any).readyHeights.length === 1);
    return { context, page, errors };
  };
  {
    const { context, page, errors } = await open(request);
    assert.equal(await page.textContent('#trusted-dialog-title'), 'Arcane Claude chat');
    assert.equal(await page.locator('.trusted-dialog-detail').count(), 2);
    assert.equal(await page.locator('.trusted-dialog-body b').count(), 0, 'detail text is never parsed as HTML');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.response), '0', 'the default (Cancel) button has focus');
    assert.equal(await page.getAttribute('.trusted-dialog-primary', 'data-response'), '2', 'the last non-cancel button is the red primary');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.trusted-dialog-primary')!).backgroundColor), 'rgb(212, 21, 43)');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.response), '1');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.response), '0', 'Tab wraps inside the buttons');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.response), '2');
    if (shots) await page.screenshot({ path: join(shots, 'trusted-dialog.png') });
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => (window as any).answers), [0], 'Esc answers the cancel button');
    await page.click('[data-response="2"]', { force: true }).catch(() => {});
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as any).answers), [0], 'answers exactly once');
    assert.deepEqual(errors, []); await context.close();
  }
  {
    const { context, page, errors } = await open({ ...request, type: 'warning', buttons: ['Cancel', 'Turn on'], defaultId: 1, cancelId: 0 });
    assert.equal(await page.getAttribute('#trusted-dialog', 'role'), 'alertdialog');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as any).answers), [1], 'Enter activates the focused default button');
    assert.deepEqual(errors, []); await context.close();
  }
  {
    const { context, page } = await open(request);
    await page.click('[data-response="1"]');
    assert.deepEqual(await page.evaluate(() => (window as any).answers), [1], 'a click answers its own button');
    await context.close();
  }
});
