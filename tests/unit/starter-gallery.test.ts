import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STARTER_PROMPTS } from '../../apps/desktop/src/starter-prompts.js';
import { composerWithStarter, starterFocusTarget, STARTER_ICONS } from '../../apps/desktop/src/starter-gallery.js';

const TOOLS = ['scene_build', 'environment_apply', 'studio_asset_search', 'studio_asset_insert', 'studio_asset_generate', 'assets_procedural', 'studio_viewport_capture', 'playtest_request', 'script_read'];
const PRESETS = ['clear_day', 'golden_hour', 'foggy_forest', 'night', 'horror', 'sci_fi'];

test('starter prompts preserve the original-assets default without injecting Toolbox requests', () => {
  for (const starter of STARTER_PROMPTS) assert.doesNotMatch(starter.prompt, /studio_asset_search|studio_asset_insert|Creator Store/, starter.id);
});

test('starter data: 8-12 unique, complete, lean prompts that name real Arcane tools and skills', async () => {
  assert.ok(STARTER_PROMPTS.length >= 8 && STARTER_PROMPTS.length <= 12);
  assert.equal(new Set(STARTER_PROMPTS.map(s => s.id)).size, STARTER_PROMPTS.length);
  assert.equal(new Set(STARTER_PROMPTS.map(s => s.title)).size, STARTER_PROMPTS.length);
  const skills = new Set((JSON.parse(await readFile('skills/registry.json', 'utf8')) as { skills: { id: string }[] }).skills.map(s => s.id));
  for (const s of STARTER_PROMPTS) {
    assert.match(s.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(s.title.length <= 32 && s.description.length <= 64, s.id + ' card text stays short');
    assert.ok(Object.hasOwn(STARTER_ICONS, s.icon), s.id + ' icon exists');
    assert.ok(s.prompt.length >= 200 && s.prompt.length <= 900, s.id + ' prompt is token-lean (' + s.prompt.length + ')');
    assert.ok(TOOLS.some(tool => s.prompt.includes(tool)), s.id + ' names an Arcane tool');
    for (const tool of s.prompt.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) assert.ok(TOOLS.includes(tool) || PRESETS.includes(tool), s.id + ' unknown tool ' + tool);
    for (const skill of s.prompt.match(/\barcane-[a-z-]+\b/g) ?? []) assert.ok(skills.has(skill), s.id + ' unknown skill ' + skill);
    assert.ok(!/\b(send|submit) (it|this) (now|automatically)\b/i.test(s.prompt));
  }
  // The gallery covers original assets, VFX, viewport critique, playtest and DataStore safety.
  const all = STARTER_PROMPTS.map(s => s.prompt).join('\n');
  for (const needle of ['original meshes', 'assets_procedural', 'scene_build', 'environment_apply', 'ParticleEmitter', 'studio_viewport_capture', 'playtest_request', 'arcane-datastore-safety']) assert.ok(all.includes(needle), needle);
});

test('composer fill replaces an empty box or an unedited starter and keeps a typed draft', () => {
  const [a, b] = STARTER_PROMPTS;
  assert.deepEqual(composerWithStarter('', a!.prompt), { value: a!.prompt, replaced: true, fits: true });
  assert.deepEqual(composerWithStarter('  \n', a!.prompt).value, a!.prompt);
  assert.equal(composerWithStarter(a!.prompt, b!.prompt).value, b!.prompt);
  const kept = composerWithStarter('Make it night time.  \n', b!.prompt);
  assert.equal(kept.value, 'Make it night time.\n\n' + b!.prompt); assert.equal(kept.replaced, false);
  assert.equal(composerWithStarter('x'.repeat(100), a!.prompt, 120).fits, false);
});

test('arrow navigation moves across rows and columns and clamps at the edges', () => {
  assert.equal(starterFocusTarget('ArrowRight', 0, 10, 3), 1);
  assert.equal(starterFocusTarget('ArrowRight', 9, 10, 3), 9);
  assert.equal(starterFocusTarget('ArrowLeft', 0, 10, 3), 0);
  assert.equal(starterFocusTarget('ArrowDown', 1, 10, 3), 4);
  assert.equal(starterFocusTarget('ArrowDown', 8, 10, 3), 8);
  assert.equal(starterFocusTarget('ArrowUp', 4, 10, 3), 1);
  assert.equal(starterFocusTarget('ArrowUp', 1, 10, 1), 0);
  assert.equal(starterFocusTarget('Home', 6, 10, 3), 0);
  assert.equal(starterFocusTarget('End', 2, 10, 3), 9);
  assert.equal(starterFocusTarget('Enter', 2, 10, 3), null);
});

test('real Edge gallery: fills without sending, keyboard roving, folds behind the checklist, hides with messages', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const files: Record<string, string> = {
    '/fixture': html, '/studio.css': await readFile('apps/desktop/public/studio.css', 'utf8'),
    '/starter-gallery.js': await readFile(join(build, 'apps/desktop/src/starter-gallery.js'), 'utf8'),
    '/starter-prompts.js': await readFile(join(build, 'apps/desktop/src/starter-prompts.js'), 'utf8'),
  };
  const server = createServer((req, res) => {
    const p = req.url?.split('?')[0] ?? '', value = files[p] ?? '';
    res.writeHead(value ? 200 : 404, { 'Content-Type': p === '/fixture' ? 'text/html' : p.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(value);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/fixture');
  await page.evaluate(async () => {
    const path: string = '/starter-gallery.js', m = await import(path); const w = window as any;
    document.getElementById('provider-login-gate')!.hidden = true;
    document.getElementById('workspace-stage')!.classList.remove('provider-required');
    const composer = document.getElementById('codex-composer') as HTMLTextAreaElement; w.inputs = 0; w.submits = 0;
    composer.addEventListener('input', () => { w.inputs++; });
    document.getElementById('codex-compose')!.addEventListener('submit', e => { e.preventDefault(); w.submits++; });
    w.gallery = m.startStarterGallery(document);
  });
  const cards = page.locator('#starter-gallery .starter-card');
  assert.equal(await cards.count(), STARTER_PROMPTS.length);
  assert.equal(await page.locator('#starter-gallery').isVisible(), true);
  assert.equal(await page.locator('#starter-gallery-toggle').isVisible(), false, 'No toggle without the checklist.');
  assert.deepEqual(await cards.evaluateAll((nodes: Element[]) => nodes.map(n => (n as HTMLElement).tabIndex)), STARTER_PROMPTS.map((_, i) => i === 0 ? 0 : -1), 'One tab stop.');
  if (shots) await page.locator('.codex-panel').screenshot({ path: join(shots, 'starter-gallery.png') });

  // Keyboard: focus the first card, arrow right, Enter fills the composer and focuses it; nothing is submitted.
  await cards.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.starterId), STARTER_PROMPTS[1]!.id);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#codex-composer').inputValue(), STARTER_PROMPTS[1]!.prompt);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'codex-composer');
  assert.deepEqual(await page.evaluate(() => [(window as any).inputs, (window as any).submits]), [1, 0]);
  assert.match(await page.locator('#starter-gallery-status').textContent() ?? '', /Review it, then send/);
  assert.equal(await cards.nth(1).getAttribute('aria-current'), 'true');
  // A typed draft is kept.
  await page.locator('#codex-composer').fill('Use blue colours.');
  await cards.nth(2).click();
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Use blue colours.\n\n' + STARTER_PROMPTS[2]!.prompt);

  // Checklist showing: the grid folds behind Browse starters.
  await page.evaluate(() => { document.getElementById('setup-checklist')!.hidden = false; });
  await page.waitForFunction(() => (document.getElementById('starter-gallery-grid') as HTMLElement).hidden);
  const toggle = page.locator('#starter-gallery-toggle');
  assert.equal(await toggle.textContent(), 'Browse starters');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await page.locator('#starter-gallery-grid').isVisible(), true);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await toggle.click();
  assert.equal(await page.locator('#starter-gallery-grid').isVisible(), false);

  // Messages hide it.
  await page.evaluate(() => { const p = document.createElement('article'); p.className = 'codex-message human'; document.getElementById('codex-messages')!.append(p); });
  await page.waitForFunction(() => (document.getElementById('starter-gallery') as HTMLElement).hidden);
  assert.equal(await page.locator('#starter-gallery').isVisible(), false);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
});
