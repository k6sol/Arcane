import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOUR_STEPS, WELCOME_TOUR_KEY, markTourSeen, placeCard, tourKeyMove, tourSeen } from '../../apps/desktop/src/welcome-tour.js';

const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map }; };

test('tour content: 3-4 short steps in Arcane voice that point at real studio.html controls', async () => {
  const html = await readFile('apps/desktop/public/studio.html', 'utf8');
  assert.ok(TOUR_STEPS.length >= 3 && TOUR_STEPS.length <= 4);
  assert.deepEqual(TOUR_STEPS.map(s => s.id), ['model', 'playtest', 'setup', 'starters']);
  for (const step of TOUR_STEPS) {
    assert.ok(step.title.length <= 28 && step.body.length <= 140, step.id + ' stays short');
    assert.ok(step.targets.length >= 1);
    const id = step.targets[0]!.match(/^#([\w-]+)$/)?.[1];
    assert.ok(id && html.includes('id="' + id + '"'), step.id + ' primary target exists: ' + step.targets[0]);
    assert.doesNotMatch(step.body, /\b(I|we|assistant)\b/i, 'Arcane voice: second person, no assistant talk');
  }
  // Mount markup and replay entry point, with a dialog role and labelled card.
  assert.match(html, /<div id="welcome-tour" class="welcome-tour" hidden>/);
  assert.match(html, /id="welcome-tour-card"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="welcome-tour-title"/);
  assert.match(html.slice(html.indexOf('id="settings-guide"')), /id="welcome-tour-replay" type="button"[^>]*>Replay tour</);
  for (const id of ['welcome-tour-skip', 'welcome-tour-back', 'welcome-tour-next']) assert.match(html, new RegExp('id="' + id + '" type="button"'));
});

test('completion persists as a versioned flag and storage failures never throw', () => {
  const store = memory();
  assert.equal(tourSeen(store), false);
  markTourSeen(store, 'skipped');
  assert.deepEqual(JSON.parse(store.map.get(WELCOME_TOUR_KEY)!), { version: 1, seen: true, how: 'skipped' });
  assert.equal(tourSeen(store), true);
  store.setItem(WELCOME_TOUR_KEY, '{oops'); assert.equal(tourSeen(store), false);
  store.setItem(WELCOME_TOUR_KEY, JSON.stringify({ version: 2, seen: true })); assert.equal(tourSeen(store), false);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(tourSeen(broken), false); assert.doesNotThrow(() => markTourSeen(broken, 'finished'));
  assert.equal(tourSeen(null), false); assert.doesNotThrow(() => markTourSeen(null, 'finished'));
});

test('keyboard moves: arrows step, Enter advances off buttons, Esc skips, the last step finishes', () => {
  assert.deepEqual(tourKeyMove('ArrowRight', 0, 4), { kind: 'go', index: 1 });
  assert.deepEqual(tourKeyMove('ArrowRight', 3, 4), { kind: 'finish' });
  assert.deepEqual(tourKeyMove('ArrowLeft', 2, 4), { kind: 'go', index: 1 });
  assert.equal(tourKeyMove('ArrowLeft', 0, 4), null);
  assert.deepEqual(tourKeyMove('Escape', 1, 4), { kind: 'skip' });
  assert.deepEqual(tourKeyMove('Enter', 1, 4), { kind: 'go', index: 2 });
  assert.equal(tourKeyMove('Enter', 1, 4, true), null, 'A focused button handles Enter itself.');
  assert.deepEqual(tourKeyMove('Home', 3, 4), { kind: 'go', index: 0 });
  assert.deepEqual(tourKeyMove('End', 0, 4), { kind: 'go', index: 3 });
  assert.equal(tourKeyMove('a', 0, 4), null);
});

test('card placement: below, above, centered and always inside the viewport', () => {
  const card = { width: 360, height: 200 }, vp = { width: 1280, height: 860 };
  assert.deepEqual(placeCard({ top: 100, left: 600, width: 80, height: 30 }, card, vp), { top: 142, left: 460, side: 'below' });
  assert.deepEqual(placeCard({ top: 780, left: 1200, width: 60, height: 30 }, card, vp), { top: 568, left: 904, side: 'above' });
  assert.equal(placeCard(null, card, vp).side, 'center');
  const tall = placeCard({ top: 40, left: 0, width: 1280, height: 800 }, card, vp);
  assert.ok(tall.top >= 16 && tall.top + 200 <= 860 - 16 && tall.left >= 16);
  const phone = placeCard({ top: 10, left: 5, width: 20, height: 20 }, { width: 358, height: 220 }, { width: 390, height: 844 });
  assert.ok(phone.left >= 16 && phone.left + 358 <= 390 - 16 + 0.5);
});

test('real Edge tour: waits for sign-in, spotlights real controls, traps focus, persists, replays from Guide', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 90000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const files: Record<string, string> = {
    '/fixture': html, '/studio.css': await readFile('apps/desktop/public/studio.css', 'utf8'),
    '/welcome-tour.js': await readFile(join(build, 'apps/desktop/src/welcome-tour.js'), 'utf8'),
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  const boot = async () => {
    await page.goto(origin + '/fixture');
    await page.evaluate(async () => {
      const w = window as any, tourPath: string = '/welcome-tour.js', galleryPath: string = '/starter-gallery.js';
      const tour = await import(tourPath), gallery = await import(galleryPath);
      // Signed-out first launch: the sign-in gate is showing.
      const checklist = document.getElementById('setup-checklist')!;
      checklist.hidden = false;
      document.getElementById('setup-checklist-items')!.innerHTML = '<li class="setup-checklist-item">Signed in</li><li class="setup-checklist-item">Studio plugin installed</li><li class="setup-checklist-item">Connect Studio</li>';
      document.getElementById('setup-checklist-progress')!.textContent = '2 of 4';
      gallery.startStarterGallery(document);
      let storage: Storage | null = null; try { storage = window.localStorage; } catch { storage = null; }
      w.tour = tour.startWelcomeTour(document, { storage });
    });
  };
  const signIn = () => page.evaluate(() => { document.getElementById('provider-login-gate')!.hidden = true; document.getElementById('workspace-stage')!.classList.remove('provider-required'); });
  const shown = () => page.locator('#welcome-tour').isVisible();
  const overlaps = (selector: string) => page.evaluate((sel: string) => {
    const a = document.getElementById('welcome-tour-spotlight')!.getBoundingClientRect(), b = document.querySelector(sel)!.getBoundingClientRect();
    return !document.getElementById('welcome-tour-spotlight')!.hidden && a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
  }, selector);
  const cardInside = () => page.evaluate(() => { const r = document.getElementById('welcome-tour-card')!.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  const active = () => page.evaluate(() => document.activeElement?.id ?? '');

  await boot();
  await page.waitForTimeout(700);
  assert.equal(await shown(), false, 'Never shown over the sign-in screen.');
  assert.equal(await page.locator('#provider-login-start').isVisible(), true);
  await signIn();
  await page.waitForFunction(() => !(document.getElementById('welcome-tour') as HTMLElement).hidden);

  // Step 1: model picker.
  assert.equal(await page.locator('#welcome-tour-title').textContent(), 'Pick your model');
  assert.equal(await page.locator('#welcome-tour-count').textContent(), 'Step 1 of 4');
  assert.equal(await active(), 'welcome-tour-next');
  assert.equal(await page.locator('#welcome-tour-back').isVisible(), false);
  assert.equal(await overlaps('#codex-model-trigger'), true);
  assert.equal(await cardInside(), true);
  assert.deepEqual(await page.evaluate(() => getComputedStyle(document.getElementById('welcome-tour-card')!).transitionDuration.split(',').every(v => parseFloat(v) === 0)), true);
  if (shots) await page.screenshot({ path: join(shots, 'welcome-tour-1-model.png') });
  // Focus trap: Tab and Shift+Tab stay inside the card.
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); assert.ok((await active()).startsWith('welcome-tour-'), 'Tab stays in the card'); }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); assert.ok((await active()).startsWith('welcome-tour-'), 'Shift+Tab stays in the card'); }

  // Step 2 via ArrowRight: Playtest switch.
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#welcome-tour-title').textContent(), 'Let Arcane playtest');
  assert.equal(await overlaps('#playtest-toggle'), true);
  assert.equal(await cardInside(), true);
  if (shots) await page.screenshot({ path: join(shots, 'welcome-tour-2-playtest.png') });

  // Step 3 via Enter on Next: setup checklist.
  await page.locator('#welcome-tour-next').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#welcome-tour-title').textContent(), 'Connect Studio');
  assert.equal(await overlaps('#setup-checklist'), true);
  assert.equal(await cardInside(), true);
  if (shots) await page.screenshot({ path: join(shots, 'welcome-tour-3-setup.png') });
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#welcome-tour-title').textContent(), 'Let Arcane playtest');
  await page.locator('#welcome-tour-next').click();
  await page.locator('#welcome-tour-next').click();

  // Step 4: starter gallery, then Done.
  assert.equal(await page.locator('#welcome-tour-title').textContent(), 'Start from an idea');
  assert.equal(await overlaps('#starter-gallery'), true);
  assert.equal(await page.locator('#welcome-tour-next').textContent(), 'Done');
  assert.equal(await cardInside(), true);
  if (shots) await page.screenshot({ path: join(shots, 'welcome-tour-4-starters.png') });
  await page.locator('#welcome-tour-next').click();
  assert.equal(await shown(), false);
  assert.deepEqual(await page.evaluate((key: string) => JSON.parse(localStorage.getItem(key)!), WELCOME_TOUR_KEY), { version: 1, seen: true, how: 'finished' });

  // Seen: a fresh launch stays quiet.
  await boot(); await signIn(); await page.waitForTimeout(700);
  assert.equal(await shown(), false, 'Shown once only.');

  // Replay from Guide (drawer closed for the tour); Esc skips and focus leaves the card.
  await page.evaluate(() => { (document.getElementById('settings-drawer') as HTMLDialogElement).showModal(); document.getElementById('welcome-tour-replay')!.click(); });
  await page.waitForFunction(() => !(document.getElementById('welcome-tour') as HTMLElement).hidden);
  assert.equal(await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).open), false);
  assert.equal(await page.locator('#welcome-tour-title').textContent(), 'Pick your model');
  await page.keyboard.press('Escape');
  assert.equal(await shown(), false);
  assert.equal(await page.evaluate((key: string) => JSON.parse(localStorage.getItem(key)!).how, WELCOME_TOUR_KEY), 'skipped');
  assert.ok(!(await active()).startsWith('welcome-tour-'));

  // Skip button and Replay while signed out: never covers sign-in, explains instead.
  await page.evaluate(() => (window as any).tour.start()); await page.locator('#welcome-tour-skip').click(); assert.equal(await shown(), false);
  await page.evaluate(() => { document.getElementById('provider-login-gate')!.hidden = false; document.getElementById('welcome-tour-replay')!.click(); });
  await page.waitForTimeout(100);
  assert.equal(await shown(), false);
  assert.equal(await page.locator('#welcome-tour-replay-status').textContent(), 'Sign in first, then replay the tour.');
  // Sign-out while open pauses the tour without marking it seen.
  await page.evaluate((key: string) => { localStorage.removeItem(key); document.getElementById('provider-login-gate')!.hidden = true; (window as any).tour.start(); }, WELCOME_TOUR_KEY);
  assert.equal(await shown(), true);
  await page.evaluate(() => { document.getElementById('provider-login-gate')!.hidden = false; });
  await page.waitForFunction(() => (document.getElementById('welcome-tour') as HTMLElement).hidden);
  assert.equal(await page.evaluate((key: string) => localStorage.getItem(key), WELCOME_TOUR_KEY), null);

  // Phone width: the card fits without horizontal scroll.
  await page.evaluate(() => { document.getElementById('provider-login-gate')!.hidden = true; (window as any).tour.start(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(50);
  assert.equal(await cardInside(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);

  // A new renderer has empty browser storage. Wait for the app-wide flag before deciding to show anything.
  await page.evaluate((key:string)=>{
    const w=window as any;w.tour.stop();localStorage.removeItem(key);
    w.readTour=null;
    w.tour=undefined;
  },WELCOME_TOUR_KEY);
  await page.evaluate(async()=>{
    const w=window as any,path='/welcome-tour.js',module=await import(path);
    w.tour=module.startWelcomeTour(document,{storage:localStorage,persistence:{read:()=>new Promise(resolve=>{w.readTour=resolve;}),dismiss:async()=>({saved:true})}});
  });
  await page.waitForTimeout(700);assert.equal(await shown(),false,'a slow native read never flashes the tutorial');
  await page.evaluate(()=>(window as any).readTour({available:true,seen:true}));
  await page.waitForTimeout(700);assert.equal(await shown(),false,'app-wide dismissal wins with empty renderer storage');

  // Skip remains quiet in this window even if browser storage cannot be written.
  await page.evaluate(async()=>{
    const w=window as any,path='/welcome-tour.js',module=await import(path);w.tour.stop();w.dismissals=[];
    w.tour=module.startWelcomeTour(document,{storage:{getItem:()=>null,setItem:()=>{throw Error('Unavailable');}},persistence:{read:async()=>({available:true,seen:false}),dismiss:async(input:any)=>{w.dismissals.push(input.how);return{saved:true};}}});
  });
  await page.waitForFunction(()=>!document.getElementById('welcome-tour')!.hidden);
  await page.locator('#welcome-tour-skip').click();
  await page.evaluate(()=>document.getElementById('workspace-stage')!.classList.toggle('tour-fixture-refresh'));
  await page.waitForTimeout(700);assert.equal(await shown(),false);
  assert.deepEqual(await page.evaluate(()=>(window as any).dismissals),['shown','skipped']);

  // Closing during the first step still counts as a first launch; empty browser storage cannot replay it.
  await page.evaluate(async()=>{
    const w=window as any,path='/welcome-tour.js',module=await import(path);w.tour.stop();w.nativeSeen=false;w.presentationWrites=[];
    w.persistence={read:async()=>({available:true,seen:w.nativeSeen}),dismiss:async(input:any)=>{w.nativeSeen=true;w.presentationWrites.push(input.how);return{saved:true};}};
    w.startTour=()=>module.startWelcomeTour(document,{storage:null,persistence:w.persistence});w.tour=w.startTour();
  });
  await page.waitForFunction(()=>!document.getElementById('welcome-tour')!.hidden);
  await page.waitForFunction(()=>(window as any).nativeSeen===true);
  await page.evaluate(()=>{const w=window as any;w.tour.stop();w.tour=w.startTour();});
  await page.waitForTimeout(700);assert.equal(await shown(),false,'an interrupted first tour stays quiet on the next launch');
  assert.deepEqual(await page.evaluate(()=>(window as any).presentationWrites),['shown']);
  await page.locator('#welcome-tour-replay').evaluate((button:HTMLElement)=>button.click());
  await page.waitForFunction(()=>!document.getElementById('welcome-tour')!.hidden);
  await page.locator('#welcome-tour-skip').click();
  assert.deepEqual(errors, []);
});
