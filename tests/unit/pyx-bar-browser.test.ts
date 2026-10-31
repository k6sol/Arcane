import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The same CSP the local runtime serves (lab-server.ts): the bar must work under it unchanged.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob:; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// In-page fake of window.arcaneDesktop.pyx (installed before the module boots), shaped like pyx-preload.cjs: the host
// says when the bar is open; the bar reports ready, close, moves and nudges. It records intents; nothing reaches a provider.
const FAKE_BRIDGE = `(() => {
  const states = new Set(), offers = new Set(), seen = new Set(); let current = { phase: 'idle', provider: 'claude', model: 'Opus 5.5', modelTitle: 'Claude Opus 5.5', effort: 'high' }, offered = [], visible = null;
  const catalog={revision:'453f0fb4-f28b-434a-aee5-605261af915f',selectable:true,message:null,selected:{provider:'claude',model:'opus',effort:'high'},models:[{provider:'claude',id:'opus',label:'Opus 5.5',efforts:['low','high']},{provider:'claude',id:'sonnet',label:'Sonnet 5.5',efforts:['low','high']},{provider:'codex',id:'fixture-sol',label:'Sol fixture',efforts:['low','high']}]};
  const calls = []; window.__pyx = { calls, catalog, selection:{state:'applied'},push: s => { current = s; states.forEach(l => l(s)); }, offer: s => { offered = s; offers.forEach(l => l(s)); },
    show: open => { visible = open; seen.forEach(l => l(open)); }, next: { accepted: true } };
  window.arcaneDesktop = { pyx: Object.freeze({ version: 1,
    submit: text => { calls.push(['submit', text]); return Promise.resolve(window.__pyx.next); },
    onState: l => { states.add(l); l(current); return () => states.delete(l); },
    onSuggestions: l => { offers.add(l); l(offered); return () => offers.delete(l); },
    onVisibility: l => { seen.add(l); if (visible !== null) l(visible); return () => seen.delete(l); },
    ready: () => calls.push(['ready']), drag: phase => calls.push(['drag', phase]), nudge: (dx, dy) => calls.push(['nudge', dx, dy]),
    close: () => calls.push(['close']), expandToMain: () => calls.push(['expandToMain']), stop: () => calls.push(['stop']),
    models:()=>{calls.push(['models']);return Promise.resolve(window.__pyx.catalog);},
    selectModel:choice=>{calls.push(['selectModel',choice]);const result=window.__pyx.selection;if(result.state==='applied'){const row=catalog.models.find(r=>r.provider===choice.provider&&r.id===choice.model);catalog.selected={provider:choice.provider,model:choice.model,effort:choice.effort};current={...current,provider:choice.provider,model:row.label,modelTitle:row.label,effort:choice.effort};states.forEach(l=>l(current));}return Promise.resolve(result);},
    pickerOpen:on=>calls.push(['pickerOpen',on]),setInteractive: on => calls.push(['setInteractive', on]) }) };
})();`;

test('real Edge Pyx bar: pop open/close, ×, Escape, moving, no clipping, moods, suggestions only fill, steering, honest offline, reduced motion, CSP', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 120000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const files: Record<string, [string | Buffer, string]> = {
    '/pyx-bar': [await readFile('apps/desktop/public/pyx-bar.html', 'utf8'), 'text/html; charset=utf-8'], '/pyx-bar.css': [await readFile('apps/desktop/public/pyx-bar.css', 'utf8'), 'text/css; charset=utf-8'],
    '/pyx-bar.js': [await readFile(join(build, 'apps/desktop/src/pyx-bar.js'), 'utf8'), 'text/javascript; charset=utf-8'], '/pyx-sprite.js': [await readFile(join(build, 'apps/desktop/src/pyx-sprite.js'), 'utf8'), 'text/javascript; charset=utf-8'],
  };
  for (const name of ['ibm-plex-sans-latin-wght-normal.woff2', 'ibm-plex-sans-latin-ext-wght-normal.woff2']) files['/fonts/' + name] = [await readFile(join('apps/desktop/public/fonts', name)), 'font/woff2'];
  const server = createServer((req, res) => {
    const file = files[req.url?.split('?')[0] ?? ''];
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Security-Policy', CSP);
    res.writeHead(file ? 200 : 404, { 'Content-Type': file?.[1] ?? 'text/plain; charset=utf-8' }); res.end(file?.[0] ?? '');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });

  const open = async (reducedMotion: 'reduce' | 'no-preference', bridge = true) => {
    const context = await browser.newContext({ viewport: { width: 772, height: 244 }, reducedMotion, colorScheme: 'dark' });
    if (bridge) await context.addInitScript(FAKE_BRIDGE);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => { (window as any).__csp = ((window as any).__csp ?? 0) + 1; console.error('CSP ' + e.violatedDirective); }));
    await page.goto(origin + '/pyx-bar');
    await page.waitForFunction(() => document.getElementById('pyx')?.classList.contains('is-ready'));
    return { context, page, errors };
  };
  const quiet = ['setInteractive', 'drag', 'ready', 'nudge','pickerOpen'];
  const calls = (page: any) => page.evaluate((q: string[]) => (window as any).__pyx.calls.filter((c: unknown[]) => !q.includes(c[0] as string)), quiet);
  const allCalls = (page: any) => page.evaluate(() => (window as any).__pyx.calls.slice());
  const clearCalls = (page: any) => page.evaluate(() => { (window as any).__pyx.calls.length = 0; });
  const mood = (page: any) => page.evaluate(() => document.getElementById('pyx')!.dataset.mood);
  const frameOf = (page: any) => page.evaluate(() => document.querySelector('#pyx-sprite > g')?.getAttribute('data-frame'));
  const openState = (page: any) => page.evaluate(() => ({ open: document.getElementById('pyx')!.dataset.open, opacity: getComputedStyle(document.getElementById('pyx')!).opacity,
    moving: document.getAnimations().filter(a => ((a as any).effect?.target as Element | undefined)?.id === 'pyx').length }));
  const shownAgain = async (page: any) => { await page.evaluate(() => (window as any).__pyx.show(true)); await page.waitForTimeout(450); await clearCalls(page); };

  // ---- Motion on
  {
    const { context, page, errors } = await open('no-preference');
    // The first paint is the closed state; the bar tells the host it may show the window, then pops in when told it is open.
    await page.waitForFunction(() => (window as any).__pyx.calls.some((c: unknown[]) => c[0] === 'ready'));
    assert.deepEqual(await openState(page), { open: 'false', opacity: '0', moving: 0 }, 'nothing visible before the host opens it');
    await page.evaluate(() => (window as any).__pyx.show(true));
    const popping = await openState(page);
    assert.equal(popping.open, 'true'); assert.ok(popping.moving >= 1, 'opening pops (opacity and scale transitions run)');
    await page.waitForTimeout(70); if (shots) await page.screenshot({ path: join(shots, 'pyx-pop-in-70ms.png') });
    await page.waitForTimeout(450);
    assert.deepEqual(await openState(page), { open: 'true', opacity: '1', moving: 0 }, 'settled');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pyx-input', 'opening puts the caret in the box');
    // Idle: the chip carries the real Claude mark in white, the model and three red pips.
    const chip = await page.evaluate(() => {
      const c = document.getElementById('pyx-model')!, logo = document.getElementById('pyx-model-logo')!, pip = getComputedStyle(document.querySelector('.pyx-pip')!);
      return { label: c.getAttribute('aria-label'), name: document.getElementById('pyx-model-name')!.textContent, logo: logo.querySelector('path')?.getAttribute('d')?.slice(0, 18), logoColor: getComputedStyle(logo).color,
        level: document.getElementById('pyx-model-pips')!.dataset.level, pip: pip.backgroundColor, pipSize: pip.width + '×' + pip.height, height: c.getBoundingClientRect().height };
    });
    assert.deepEqual(chip, { label: 'Model: Claude Opus 5.5, reasoning high. Change model', name: 'Opus 5.5', logo: 'M4.7144 15.9555l4.', logoColor: 'rgb(255, 255, 255)', level: '3', pip: 'rgb(229, 50, 63)', pipSize: '4px×4px', height: 40 });
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const r = (id: string) => { const b = document.getElementById(id)!.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      const sprite = document.getElementById('pyx-sprite')!;
      return { bar: r('pyx-form'), pet: r('pyx-pet'), sprite: r('pyx-sprite'), send: r('pyx-send'), close: r('pyx-close'), input: r('pyx-input'), rendering: getComputedStyle(sprite).imageRendering, rects: sprite.querySelectorAll('rect').length,
        font: getComputedStyle(document.getElementById('pyx-input')!).fontFamily, plex: document.fonts.check('15px "IBM Plex Sans"'),
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
    });
    assert.deepEqual(geometry.bar, [16, 80, 740, 60], 'bar 740×60 at a fixed row');
    assert.deepEqual(geometry.pet, [17, 76, 68, 68], 'Pyx overhangs the bar by 4px');
    assert.deepEqual(geometry.sprite, [27, 86, 48, 48], 'integer 2x sprite');
    assert.equal(geometry.send[2], 40); assert.equal(geometry.rendering, 'pixelated'); assert.ok(geometry.rects > 100); assert.equal(geometry.overflow, false, 'no scrolling');
    assert.deepEqual(geometry.close.slice(2), [30, 30]); assert.ok(geometry.close[0]! > geometry.send[0]! && geometry.close[0]! + 30 <= 16 + 740 - 8, '× sits at the bar end, inside it');
    assert.equal(geometry.input[3], 40); assert.match(geometry.font, /^"IBM Plex Sans"/); assert.equal(geometry.plex, true, 'the app face is served same-origin and used');
    assert.equal(await mood(page), 'idle');
    // Idle swaps its two frames every 600 ms.
    const first = await frameOf(page);
    await page.waitForFunction((f: string) => document.querySelector('#pyx-sprite > g')?.getAttribute('data-frame') !== f, first, { timeout: 1000 });
    if (shots) await page.screenshot({ path: join(shots, 'pyx-idle.png') });

    // No clipping: the user's own words, then a long line. The line box clears the face; long text scrolls inside the box.
    await page.locator('#pyx-input').fill('playtest_request once to check it');
    const short = await page.evaluate(() => {
      const input = document.getElementById('pyx-input') as HTMLInputElement, style = getComputedStyle(input);
      const ctx = document.createElement('canvas').getContext('2d')!; ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      const m = ctx.measureText(input.value);
      return { fits: input.scrollWidth <= input.clientWidth, glyphs: Math.ceil(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent), box: input.clientHeight, lineHeight: style.lineHeight,
        selected: input.selectionEnd! - input.selectionStart!, scrollTop: input.scrollTop };
    });
    assert.equal(short.fits, true); assert.ok(short.glyphs <= Number.parseFloat(short.lineHeight) && Number.parseFloat(short.lineHeight) <= short.box, JSON.stringify(short));
    assert.equal(short.selected, 0, 'nothing is left selected'); assert.equal(short.scrollTop, 0);
    assert.equal(await mood(page), 'listening');
    if (shots) await page.screenshot({ path: join(shots, 'pyx-text-short.png') });
    const long = 'playtest_request once to check it, then walk the spawn, the caves, the waterfall, the bridge and the whole valley twice before golden hour';
    await page.locator('#pyx-input').fill(''); await page.keyboard.type(long, { delay: 0 });
    const scrolled = await page.evaluate(() => {
      const input = document.getElementById('pyx-input') as HTMLInputElement, bar = document.getElementById('pyx-form')!.getBoundingClientRect(), box = input.getBoundingClientRect();
      return { overflows: input.scrollWidth > input.clientWidth, followsCaret: input.scrollLeft > 0 && Math.abs(input.scrollLeft + input.clientWidth - input.scrollWidth) <= 2, inside: box.left >= bar.left && box.right <= bar.right,
        caret: input.selectionStart === input.value.length };
    });
    assert.deepEqual(scrolled, { overflows: true, followsCaret: true, inside: true, caret: true }, 'long text scrolls within the box and the caret stays in view');
    if (shots) await page.screenshot({ path: join(shots, 'pyx-text-long.png') });
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => (document.getElementById('pyx-input') as HTMLInputElement).scrollLeft), 0, 'Home shows the start');

    // Suggestions only fill the box.
    await page.locator('#pyx-input').fill('Plant a forest');
    await page.evaluate(() => (window as any).__pyx.offer(['Add a waterfall by the caves', 'Playtest the spawn', 'Make it golden hour', 'A fourth is never shown']));
    await page.waitForFunction(() => document.querySelectorAll('.pyx-suggestion').length === 3);
    await page.locator('.pyx-suggestion').nth(0).click();
    assert.equal(await page.locator('#pyx-input').inputValue(), 'Plant a forest Add a waterfall by the caves', 'a draft is extended, not replaced');
    await page.locator('#pyx-input').fill('');
    await page.locator('.pyx-suggestion').nth(1).click();
    assert.equal(await page.locator('#pyx-input').inputValue(), 'Playtest the spawn');
    await page.locator('.pyx-suggestion').nth(2).click();
    assert.equal(await page.locator('#pyx-input').inputValue(), 'Make it golden hour', 'an earlier suggestion is replaced');
    assert.deepEqual(await calls(page), [], 'clicking suggestions never sends');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pyx-input');
    await page.waitForTimeout(700);
    if (shots) await page.screenshot({ path: join(shots, 'pyx-suggestions.png') });

    // Enter submits through the bridge and clears the box.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).__pyx.calls.some((c: unknown[]) => c[0] === 'submit'));
    assert.deepEqual(await calls(page), [['submit', 'Make it golden hour']]);
    await page.waitForFunction(() => (document.getElementById('pyx-input') as HTMLInputElement).value === '');

    // Long everything: a 60-character label on each chip, a long model name, a long reply. Nothing leaves its box.
    const label = 'Add a waterfall that spills from the cliffs into the cave lake';
    await page.evaluate((l: string) => { (window as any).__pyx.offer([l, l + ' too', l + ' again']);
      (window as any).__pyx.push({ phase: 'idle', provider: 'claude', model: 'Opus 5.5 Extended Preview Long Context Edition', effort: 'high',
        reply: 'Forest’s planted across the whole valley with oak, pine and birch, a river through the middle, three bridges, stepping stones by the caves and a lookout on the ridge so the spawn faces the sunset.' }); }, label);
    await page.waitForTimeout(1600);
    const fit = await page.evaluate(() => {
      const r = (el: Element) => el.getBoundingClientRect(), bar = r(document.getElementById('pyx-form')!), chip = r(document.getElementById('pyx-model')!), send = r(document.getElementById('pyx-send')!);
      const name = document.getElementById('pyx-model-name')!, bubble = document.getElementById('pyx-bubble')!, text = document.getElementById('pyx-bubble-text')!, slot = r(document.querySelector('.pyx-bubble-slot')!);
      const chips = [...document.querySelectorAll('.pyx-suggestion')].map(c => r(c));
      return { chipInBar: chip.left >= bar.left && chip.right <= send.left, nameShortened: name.scrollWidth > name.clientWidth,
        bubbleInSlot: r(bubble).top >= slot.top - 0.5 && r(bubble).bottom <= slot.bottom + 0.5, bubbleClamped: text.scrollHeight > text.clientHeight, bubbleTitle: bubble.title.length > 100,
        chipsVisible: chips.length === 3 && chips.every(c => c.width > 40 && c.right <= bar.right && c.bottom <= innerHeight), oneRow: new Set(chips.map(c => Math.round(c.top))).size === 1,
        inputInBar: r(document.getElementById('pyx-input')!).right <= chip.left };
    });
    assert.deepEqual(fit, { chipInBar: true, nameShortened: true, bubbleInSlot: true, bubbleClamped: true, bubbleTitle: true, chipsVisible: true, oneRow: true, inputInBar: true });
    if (shots) await page.screenshot({ path: join(shots, 'pyx-long-everything.png') });
    await page.evaluate(() => { (window as any).__pyx.offer([]); (window as any).__pyx.push({ phase: 'idle', provider: 'claude', model: 'Opus 5.5', modelTitle: 'Claude Opus 5.5', effort: 'high' }); });

    // Working: status, real counts, Stop; the sprite swaps every 180 ms; suggestions and the input step aside.
    await page.evaluate(() => (window as any).__pyx.push({ phase: 'working', provider: 'claude', model: 'Opus 5.5', effort: 'high', canStop: true,
      progress: { title: 'Placing oak and pine across the valley', step: 5, steps: 8, startedAt: Date.now() - 72000 } }));
    await page.locator('#pyx-input').blur();
    await page.waitForFunction(() => document.getElementById('pyx')!.dataset.mood === 'working');
    const working = await page.evaluate(() => ({ input: (document.getElementById('pyx-input') as HTMLElement).hidden, status: (document.getElementById('pyx-status') as HTMLElement).hidden,
      stop: (document.getElementById('pyx-stop') as HTMLElement).hidden, send: (document.getElementById('pyx-send') as HTMLElement).hidden, chips: (document.getElementById('pyx-suggestions') as HTMLElement).hidden,
      close: (document.getElementById('pyx-close') as HTMLElement).hidden,
      title: document.getElementById('pyx-status-title')!.textContent, count: document.getElementById('pyx-status-count')!.textContent,
      now: document.getElementById('pyx-progress')!.getAttribute('aria-valuenow'), max: document.getElementById('pyx-progress')!.getAttribute('aria-valuemax') }));
    assert.deepEqual(working, { input: true, status: false, stop: false, send: true, chips: true, close: false, title: 'Placing oak and pine across the valley', count: '5 of 8 · 1m 12s', now: '5', max: '8' });
    const seen = new Set<string>(); for (let i = 0; i < 6; i++) { seen.add(await frameOf(page)); await page.waitForTimeout(100); }
    assert.equal(seen.size, 2, 'working animates both frames');
    await page.waitForTimeout(700);
    if (shots) await page.screenshot({ path: join(shots, 'pyx-working.png') });
    await page.locator('#pyx-stop').click();
    assert.deepEqual((await calls(page)).at(-1), ['stop']);
    // Typing while it works opens the box to steer.
    await page.locator('#pyx-form').click({ position: { x: 300, y: 4 } });
    await page.keyboard.type('m');
    assert.equal(await page.evaluate(() => (document.getElementById('pyx-input') as HTMLElement).hidden), false, 'steering box');
    assert.equal(await page.locator('#pyx-input').inputValue(), 'm', 'the first key lands in the box');
    assert.equal(await page.locator('#pyx-input').getAttribute('placeholder'), 'Steer the build');
    assert.equal(await mood(page), 'listening');
    await page.locator('#pyx-input').fill(''); await page.locator('#pyx-input').blur();

    // Done: Pyx hops, reports and asks what next, the reply is announced; back to idle after 1.2 s.
    await page.evaluate(() => (window as any).__pyx.push({ phase: 'idle', provider: 'claude', model: 'Opus 5.5', effort: 'high', reply: 'Forest’s planted.' }));
    assert.equal(await mood(page), 'done');
    await page.waitForFunction(() => document.getElementById('pyx-announce')!.textContent === 'Forest’s planted. What next?');
    assert.equal(await page.locator('#pyx-bubble-text').textContent(), 'Forest’s planted. What next?');
    await page.waitForTimeout(950);
    if (shots) await page.screenshot({ path: join(shots, 'pyx-done.png') });
    await page.waitForFunction(() => document.getElementById('pyx')!.dataset.mood === 'idle', undefined, { timeout: 2000 });
    assert.equal(await page.locator('#pyx-bubble').isVisible(), true, 'the report stays until the next instruction');

    // Error: honest message, alert badge, the text is kept on a refused send.
    await page.evaluate(() => { (window as any).__pyx.next = { accepted: false, message: 'Arcane’s chat box has an unsent draft. Send or clear it there first.' }; });
    await page.locator('#pyx-input').fill('Light the caves'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('pyx-bubble')!.dataset.tone === 'alert');
    assert.equal(await page.locator('#pyx-bubble-text').textContent(), 'Arcane’s chat box has an unsent draft. Send or clear it there first.');
    assert.equal(await page.locator('#pyx-input').inputValue(), 'Light the caves');

    // Moving. A press on Pyx that travels moves the window (the host follows the cursor) and is not a click.
    await clearCalls(page);
    await page.mouse.move(51, 110); await page.mouse.down(); await page.mouse.move(60, 112, { steps: 3 });
    assert.equal(await page.evaluate(() => document.getElementById('pyx')!.dataset.dragging), 'true');
    if (shots) await page.screenshot({ path: join(shots, 'pyx-dragging.png') });
    await page.mouse.move(120, 140, { steps: 4 }); await page.mouse.up();
    let moves: unknown[][] = await allCalls(page);
    const phases = moves.filter(c => c[0] === 'drag').map(c => c[1] as string);
    assert.deepEqual(phases.filter((p, i) => p !== 'move' || phases[i - 1] !== 'move'), ['start', 'move', 'end']);
    assert.ok(phases.filter(p => p === 'move').length >= 3, 'every pointer move is passed on');
    assert.equal(moves.some(c => c[0] === 'expandToMain'), false, 'a move is not a click');
    assert.equal(await page.evaluate(() => document.getElementById('pyx')!.dataset.dragging), undefined);
    // A still press on Pyx is a click (Open Arcane); so is a wobble under the threshold.
    await clearCalls(page);
    await page.mouse.move(51, 110); await page.mouse.down(); await page.mouse.move(53, 111); await page.mouse.up();
    moves = await allCalls(page);
    assert.deepEqual(moves.filter(c => c[0] === 'drag' || c[0] === 'expandToMain'), [['drag', 'start'], ['drag', 'cancel'], ['expandToMain']]);
    // The bar's own surface moves it too; its input and buttons never start a move.
    await clearCalls(page);
    await page.mouse.move(400, 83); await page.mouse.down(); await page.mouse.move(430, 70, { steps: 3 }); await page.mouse.up();
    const surface = ((await allCalls(page)) as unknown[][]).filter(c => c[0] === 'drag').map(c => c[1]);
    assert.equal(surface[0], 'start'); assert.equal(surface.at(-1), 'end'); assert.ok(surface.includes('move'));
    await clearCalls(page);
    await page.locator('#pyx-input').click(); await page.locator('#pyx-model').click();
    assert.equal(((await allCalls(page)) as unknown[][]).some(c => c[0] === 'drag'), false, 'controls never move the bar');
    // Arrow keys on Pyx move it in steps.
    await page.locator('#pyx-pet').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowUp');
    assert.deepEqual(((await allCalls(page)) as unknown[][]).filter(c => c[0] === 'nudge'), [['nudge', 16, 0], ['nudge', 0, -64]]);

    // The transparent margin passes the pointer through; the bar takes it.
    await page.mouse.move(5, 5); await page.mouse.move(300, 110); await page.mouse.move(5, 230);
    const pointer = await page.evaluate(() => (window as any).__pyx.calls.filter((c: unknown[]) => c[0] === 'setInteractive').map((c: unknown[]) => c[1]));
    assert.deepEqual(pointer.slice(-2), [true, false]);

    // × pops the bar out, then asks the host to hide it; the draft stays.
    await clearCalls(page);
    await page.locator('#pyx-input').fill('Keep this draft');
    await page.locator('#pyx-close').click();
    const closing = await openState(page);
    assert.equal(closing.open, 'false'); assert.ok(closing.moving >= 1, 'closing pops out');
    if (shots) await page.screenshot({ path: join(shots, 'pyx-pop-out.png') });
    assert.deepEqual(await calls(page), [], 'the host is told only once the pop-out has played');
    await page.waitForFunction(() => (window as any).__pyx.calls.some((c: unknown[]) => c[0] === 'close'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('pyx')!).opacity), '0');
    // Reopened by the host (the perch): pops back in with the draft and the caret at its end.
    await shownAgain(page);
    assert.deepEqual(await page.evaluate(() => { const i = document.getElementById('pyx-input') as HTMLInputElement; return [i.value, i.selectionStart, i.selectionEnd, document.activeElement?.id]; }), ['Keep this draft', 15, 15, 'pyx-input']);
    // The perch closing it: the host says closed, the bar pops out and then reports done.
    await page.evaluate(() => (window as any).__pyx.show(false));
    assert.equal(await page.evaluate(() => document.getElementById('pyx')!.dataset.open), 'false');
    await page.waitForFunction(() => (window as any).__pyx.calls.some((c: unknown[]) => c[0] === 'close'));
    // Escape closes the same way.
    await shownAgain(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('pyx')!.dataset.open), 'false');
    await page.waitForFunction(() => (window as any).__pyx.calls.some((c: unknown[]) => c[0] === 'close'));
    // The model chip opens inside Pyx; only Pyx's explicit Open Arcane gesture reaches the main window.
    await shownAgain(page);
    await page.setViewportSize({width:772,height:460});await page.locator('#pyx-model').click();await page.waitForFunction(()=>!document.getElementById('pyx-model-picker')!.hidden);
    assert.equal(await page.locator('#pyx-model-options').getByRole('option').count(),3);assert.equal(await page.locator('#pyx-input').inputValue(),'Keep this draft');
    if(shots)await page.screenshot({path:join(shots,'pyx-model-selector.png')});
    assert.equal((await calls(page)).some((c:unknown[])=>c[0]==='expandToMain'||c[0]==='submit'),false);
    await page.locator('#pyx-model-search').fill('Sonnet');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('pyx-model-picker')!.hidden);
    const selections=(await calls(page)).filter((c:unknown[])=>c[0]==='selectModel');assert.equal(selections.length,1);assert.deepEqual(selections[0]![1],{revision:'453f0fb4-f28b-434a-aee5-605261af915f',provider:'claude',model:'sonnet',effort:'high'});
    assert.equal(await page.locator('#pyx-input').inputValue(),'Keep this draft');assert.equal(await page.evaluate(()=>document.activeElement?.id),'pyx-model');
    await page.locator('#pyx-model').click();await page.waitForFunction(()=>!document.getElementById('pyx-model-effort')!.hasAttribute('disabled'));
    await page.locator('#pyx-model-effort').focus();await page.keyboard.press('ArrowUp');await page.waitForFunction(()=>document.getElementById('pyx-model-picker')!.hidden);
    const reasoning=(await calls(page)).filter((c:unknown[])=>c[0]==='selectModel');assert.equal(reasoning.length,2);
    assert.deepEqual(reasoning.at(-1)![1],{revision:'453f0fb4-f28b-434a-aee5-605261af915f',provider:'claude',model:'sonnet',effort:'low'});assert.equal(await page.locator('#pyx-input').inputValue(),'Keep this draft');
    await page.locator('#pyx-model').click();await page.setViewportSize({width:480,height:460});
    const rect=await page.locator('#pyx-model-picker').boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=480&&rect.y>=0&&rect.y+rect.height<=460);
    if(shots)await page.screenshot({path:join(shots,'pyx-model-selector-narrow.png')});
    await page.keyboard.press('Escape');assert.equal(await page.locator('#pyx-model-picker').isVisible(),false);assert.equal(await page.evaluate(()=>document.getElementById('pyx')!.dataset.open),'true');
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'pyx-model');
    await page.evaluate(()=>(window as any).__pyx.selection={state:'unknown',message:'Synthetic unobserved selection. Review it in Arcane.'});await page.locator('#pyx-model').click();await page.locator('#pyx-model-options').getByRole('option').first().click();
    await page.waitForFunction(()=>document.getElementById('pyx-model-notice')!.textContent!.includes('unobserved'));assert.equal(await page.locator('#pyx-model-options').getByRole('option').first().isDisabled(),true);
    assert.equal((await calls(page)).some((c:unknown[])=>c[0]==='submit'||c[0]==='expandToMain'),false);await page.keyboard.press('Escape');
    await page.locator('#pyx-pet').click();assert.deepEqual((await calls(page)).at(-1),['expandToMain']);
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => (window as any).__csp ?? 0), 0, 'no CSP violations');
    await context.close();
  }

  // ---- Reduced motion: a static frame, no animation, no transition; open and close are instant.
  {
    const { context, page, errors } = await open('reduce');
    await page.evaluate(() => (window as any).__pyx.show(true));
    assert.deepEqual(await openState(page), { open: 'true', opacity: '1', moving: 0 }, 'opens instantly');
    await page.evaluate(() => (window as any).__pyx.push({ phase: 'working', provider: 'codex', model: 'gpt-5.5', modelTitle: 'GPT-5.5', effort: 'medium', canStop: true, progress: { title: 'Carving caves' } }));
    await page.waitForFunction(() => document.getElementById('pyx')!.dataset.mood === 'working');
    const frames = new Set<string>(); for (let i = 0; i < 5; i++) { frames.add(await frameOf(page)); await page.waitForTimeout(120); }
    assert.deepEqual([...frames], ['1'], 'still');
    const still = await page.evaluate(() => ({ animations: document.getAnimations().length, bar: getComputedStyle(document.getElementById('pyx-form')!).transitionDuration,
      count: document.getElementById('pyx-status-count')!.textContent, progress: (document.getElementById('pyx-progress') as HTMLElement).hidden,
      logo: document.getElementById('pyx-model-logo')!.querySelector('path')?.getAttribute('d')?.slice(0, 12), pips: document.getElementById('pyx-model-pips')!.dataset.level }));
    assert.deepEqual(still, { animations: 0, bar: '0s', count: '', progress: true, logo: 'M22.2819 9.8', pips: '2' }, 'no counts are invented without a feed');
    await page.evaluate(() => (window as any).__pyx.push({ phase: 'idle', provider: 'codex', reply: 'Caves carved.' }));
    assert.equal(await mood(page), 'done');
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'no hop or pop with reduced motion');
    await page.keyboard.press('Escape');
    assert.deepEqual((await calls(page)).at(-1), ['close'], 'closes at once');
    assert.deepEqual(await openState(page), { open: 'false', opacity: '0', moving: 0 });
    assert.deepEqual(errors, []);
    await context.close();
  }

  // ---- No host: honest offline, nothing to send (open from the start: there is no window to pop).
  {
    const { context, page, errors } = await open('reduce', false);
    const offline = await page.evaluate(() => ({ mood: document.getElementById('pyx')!.dataset.mood, text: document.getElementById('pyx-bubble-text')!.textContent, open: document.getElementById('pyx')!.dataset.open,
      send: (document.getElementById('pyx-send') as HTMLButtonElement).disabled, badge: document.getElementById('pyx-badge')!.hasAttribute('hidden') }));
    assert.deepEqual(offline, { mood: 'alert', text: 'Pyx isn’t connected to Arcane. Open Arcane to use Pyx.', open: 'true', send: true, badge: false });
    if (shots) await page.screenshot({ path: join(shots, 'pyx-offline.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
