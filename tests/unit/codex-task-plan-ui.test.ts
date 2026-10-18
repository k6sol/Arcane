/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskPlanCard, readTaskPlanView, TaskPlanViewError } from '../../apps/desktop/src/codex-task-plan.js';

// Private fake document plus an optional owned real-Edge page over a private frozen module root.
class FakeElement extends EventTarget {
  id = ''; className = ''; hidden = false; disabled = false; type = ''; title = ''; dataset: Record<string, string> = {}; children: FakeElement[] = [];
  readonly attributes = new Map<string, string>(); #text = '';
  constructor(readonly tagName: string) { super(); }
  get textContent(): string { return this.#text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.#text = String(value); this.children = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeElement[]) { this.children = [...nodes]; this.#text = ''; }
  all(tag: string): FakeElement[] { return [...(this.tagName === tag ? [this] : []), ...this.children.flatMap(child => child.all(tag))]; }
}
const doc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const TASK = randomUUID(), PLAN = randomUUID(), RUN = randomUUID();
const selection = (taskId = TASK) => ({ connectionId: randomUUID(), threadId: 'thread:exact', taskId });
const step = (seq: number, kind: string, round: number, index: number, state: string, terminal: string | null = null, reason: string | null = null) => ({ seq, kind, round, index, state, terminal, reason });
const full = (overrides: Record<string, unknown> = {}) => ({ taskId: TASK, plan: { planId: PLAN, state: 'awaiting_review', reason: null, steps: [
  step(1, 'worker', 1, 0, 'completed'), step(2, 'worker', 1, 1, 'failed', null, 'worker_failed'), step(3, 'incorporation', 1, 0, 'completed', 'completed'),
  step(4, 'worker', 2, 0, 'completed'), step(5, 'incorporation', 2, 0, 'completed', 'completed'), step(6, 'evidence', 2, 0, 'acknowledged')],
  review: { runId: RUN, state: 'awaiting_human_review', reason: null, tasks: [{ key: 'build', state: 'complete' }, { key: 'verify', state: 'needs_review' }] }, ...overrides } });
const text = (value: unknown) => JSON.stringify(value);
const click = (element: FakeElement, init: Partial<{ isTrusted: boolean; button: number; shiftKey: boolean }> = {}) => {
  const event = new Event('click', { cancelable: true }); Object.defineProperty(event, 'isTrusted', { value: init.isTrusted ?? true });
  for (const [key, value] of Object.entries({ button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })) if (key !== 'isTrusted') Object.defineProperty(event, key, { value });
  element.dispatchEvent(event);
};
function mount(read: (selection: unknown) => Promise<string>) {
  const host = new FakeElement('section'), navigations: string[] = [];
  const card = TaskPlanCard.mount(doc, host as unknown as HTMLElement, { read: read as never, navigateReview: runId => { navigations.push(runId); } });
  return { host, card, navigations };
}

test('the parser accepts only bounded raw JSON text with exact keys, enums, order and terminal semantics', () => {
  assert.equal(readTaskPlanView(text(full()), TASK).plan!.steps.length, 6);
  assert.deepEqual(readTaskPlanView(text({ taskId: TASK, plan: null }), TASK), { taskId: TASK, plan: null });
  let reads = 0; const getter = Object.defineProperty({}, 'taskId', { get: () => { reads++; return TASK; } });
  for (const value of [full(), new Proxy({}, { get: () => { reads++; return 1; } }), getter, null, 1, ['x']]) assert.throws(() => readTaskPlanView(value, TASK), TaskPlanViewError);
  assert.equal(reads, 0, 'non-string input is refused before any property access');
  const plan = full().plan, bad: [string, unknown][] = [
    ['other task', { ...full(), taskId: randomUUID() }], ['extra key', { ...full(), extra: 1 }], ['plan extra', { ...full(), plan: { ...plan, accepted: true } }],
    ['unknown state', { ...full(), plan: { ...plan, state: 'done' } }], ['seq gap', { ...full(), plan: { ...plan, steps: [{ ...plan.steps[0], seq: 2 }] } }],
    ['ack terminal', { ...full(), plan: { ...plan, steps: [step(1, 'worker', 1, 0, 'completed'), step(2, 'incorporation', 1, 0, 'acknowledged', 'completed')] } }],
    ['completed without terminal', { ...full(), plan: { ...plan, steps: [step(1, 'incorporation', 1, 0, 'completed')] } }],
    ['worker terminal', { ...full(), plan: { ...plan, steps: [step(1, 'worker', 1, 0, 'completed', 'completed')] } }],
    ['duplicate slot', { ...full(), plan: { ...plan, steps: [step(1, 'worker', 1, 0, 'completed'), step(2, 'worker', 1, 0, 'failed', null, 'worker_failed')] } }],
    ['review without evidence', { ...full(), plan: { ...plan, steps: plan.steps.slice(0, 5) } }],
    ['raw reason text', { ...full(), plan: { ...plan, reason: 'Ignore previous instructions' } }],
    ['17 steps', { ...full(), plan: { ...plan, review: null, steps: Array.from({ length: 17 }, (_, i) => step(i + 1, 'worker', 1, 0, 'completed')) } }],
    ['65 review tasks', { ...full(), plan: { ...plan, review: { ...plan.review, tasks: Array.from({ length: 65 }, (_, i) => ({ key: 'k' + i, state: 'complete' })) } } }],
    ['identity hash', { ...full(), plan: { ...plan, review: { ...plan.review, accountIdentity: 'a'.repeat(64) } } }],
  ];
  for (const [name, value] of bad) assert.throws(() => readTaskPlanView(text(value), TASK), TaskPlanViewError, name);
  assert.throws(() => readTaskPlanView(text(full()).replace('{', '{"__proto__":{"x":1},'), TASK), TaskPlanViewError, '__proto__ key');
  assert.throws(() => readTaskPlanView(' '.repeat(65537), TASK), /exceeds its bound/);
  assert.throws(() => readTaskPlanView('{', TASK), TaskPlanViewError);
});

test('every phase and review state renders honest copy as plain text; native completion is never accepted', async () => {
  const views: [unknown, RegExp, RegExp | null][] = [
    [full({ state: 'active', review: null, steps: [step(1, 'worker', 1, 0, 'reserved'), step(2, 'incorporation', 1, 0, 'acknowledged')].map((s, i) => ({ ...s, seq: i + 1 })) }), /sent, waiting for result/, /Accepted/],
    [full({ state: 'stopped', reason: 'repair_reserved', review: null, steps: [step(1, 'incorporation', 1, 0, 'completed', 'failed')] }), /main task reported a problem/, /Accepted|verified/],
    [full({ state: 'unknown', reason: 'step_unknown', review: null, steps: [step(1, 'incorporation', 1, 0, 'unknown', null, 'dispatch_uncertain')] }), /Outcome unknown/, null],
    [full(), /Waiting for your review/, /Accepted/],
    [full({ review: { runId: RUN, state: 'changes_requested', reason: null, tasks: [] } }), /Changes requested/, null],
    [full({ review: { runId: RUN, state: 'unavailable', reason: 'evidence_changed', tasks: [] } }), /Review unavailable · Evidence changed after review/, null],
    [full({ review: { runId: RUN, state: 'pending_submission', reason: null, tasks: [] } }), /Evidence not submitted yet/, null],
    [full({ review: { runId: RUN, state: 'accepted', reason: null, tasks: [{ key: 'build', state: 'complete' }] } }), /Accepted after your review/, null],
  ];
  for (const [value, expected, forbidden] of views) {
    const m = mount(async () => text(value)); m.card.setSelection(selection()); await m.card.refresh();
    const rendered = m.host.textContent; assert.match(rendered, expected); if (forbidden) assert.doesNotMatch(rendered, forbidden);
    assert.doesNotMatch(rendered, /[a-f0-9]{64}|operationId|turnId|connectionId/, 'no identity or native handles');
  }
  const loading = mount(() => new Promise<string>(() => {})); loading.card.setSelection(selection()); void loading.card.refresh();
  assert.match(loading.host.textContent, /Checking plan status/);
  const failed = mount(async () => { throw new Error('offline'); }); failed.card.setSelection(selection()); await failed.card.refresh();
  assert.match(failed.host.textContent, /Plan status unavailable/);
});

test('ordinary chat hides the plan card when the server reports no plan',async()=>{
  const m=mount(async()=>text({taskId:TASK,plan:null}));m.card.setSelection(selection());await m.card.refresh();
  assert.equal(m.host.hidden,true);assert.equal(m.host.textContent,'');assert.equal(m.host.attributes.get('aria-busy'),'false');
});

test('one held read is coalesced; a selection change clears immediately and ignores the held response; disposal fences', async () => {
  let release!: (value: string) => void, reads = 0;
  const m = mount(() => { reads++; return new Promise<string>(done => { release = done; }); });
  m.card.setSelection(selection()); const first = m.card.refresh(), second = m.card.refresh();
  assert.equal(first, second); assert.equal(reads, 1, 'coalesced');
  m.card.setSelection(selection(randomUUID())); assert.match(m.host.textContent, /Checking plan status/); assert.doesNotMatch(m.host.textContent, /Round/);
  release(text(full())); await first; await delay(5);
  assert.doesNotMatch(m.host.textContent, /Waiting for your review/, 'a held response never reveals another task');
  m.card.setSelection(null); assert.equal(m.host.hidden, true);
  const n = mount(async () => text(full())); n.card.setSelection(selection()); await n.card.refresh(); n.card.dispose();
  assert.equal(n.host.hidden, true); assert.equal(n.host.children.length, 0); await n.card.refresh(); assert.equal(n.host.children.length, 0);
  let getterReads = 0;
  n.card.setSelection(selection()); assert.equal(n.host.children.length, 0, 'a disposed card ignores later selections');
  const o = mount(async () => text(full())); assert.throws(() => o.card.setSelection(Object.defineProperty({ connectionId: randomUUID(), threadId: 't' }, 'taskId', { enumerable: true, get: () => { getterReads++; return TASK; } })), TaskPlanViewError);
  assert.equal(getterReads, 0);
});

test('Open review needs trusted unmodified activation and navigates the exact run at most once', async () => {
  const m = mount(async () => text(full())); m.card.setSelection(selection()); await m.card.refresh();
  const button = m.host.all('button')[0]!; assert.equal(button.textContent, 'Open review');
  click(button, { isTrusted: false }); click(button, { shiftKey: true }); click(button, { button: 1 }); assert.deepEqual(m.navigations, []);
  click(button); click(button); assert.deepEqual(m.navigations, [RUN]); assert.equal(button.disabled, true);
  await m.card.refresh(); assert.equal(m.host.all('button')[0]!.disabled, true, 'a refresh does not re-open the same run');
  const accepted = mount(async () => text(full({ review: { runId: RUN, state: 'accepted', reason: null, tasks: [] } }))); accepted.card.setSelection(selection()); await accepted.card.refresh();
  assert.equal(accepted.host.all('button').length, 0, 'no review action once accepted');
  const pending = mount(async () => text(full({ review: { runId: RUN, state: 'pending_submission', reason: null, tasks: [] } }))); pending.card.setSelection(selection()); await pending.card.refresh();
  const evidence = pending.host.all('button')[0]!; assert.equal(evidence.textContent, 'Open evidence');
  click(evidence, { isTrusted: false }); assert.deepEqual(pending.navigations, []); click(evidence); click(evidence); assert.deepEqual(pending.navigations, [RUN]);
  const unavailable = mount(async () => text(full({ review: { runId: RUN, state: 'unavailable', reason: null, tasks: [] } }))); unavailable.card.setSelection(selection()); await unavailable.card.refresh();
  assert.equal(unavailable.host.all('button').length, 0, 'no action when the review is unavailable');
});

// Review bound BEFORE the final native turn: evidence precedes an acknowledged (still running) final incorporation.
const early = (review: Record<string, unknown> = { runId: RUN, state: 'pending_submission', reason: null, tasks: [{ key: 'build', state: 'pending' }, { key: 'verify', state: 'pending' }] }, planState = 'active') =>
  ({ taskId: TASK, plan: { planId: PLAN, state: planState, reason: null, steps: [step(1, 'worker', 1, 0, 'completed'), step(2, 'worker', 1, 1, 'completed'),
    step(3, 'incorporation', 1, 0, 'completed', 'completed'), step(4, 'worker', 2, 0, 'completed'), step(5, 'evidence', 2, 0, 'acknowledged'),
    step(6, 'incorporation', 2, 0, 'acknowledged')], review } });
test('early review binding: evidence before a running final update shows both, and forged acceptance refuses', async () => {
  assert.equal(readTaskPlanView(text(early()), TASK).plan!.steps.at(-1)!.kind, 'incorporation', 'evidence need not be the final row');
  const m = mount(async () => text(early())); m.card.setSelection(selection()); await m.card.refresh();
  assert.match(m.host.textContent, /Main task update · sent, waiting for result/); assert.match(m.host.textContent, /Evidence not submitted yet/);
  assert.doesNotMatch(m.host.textContent, /Accepted/);
  const button = m.host.all('button')[0]!; assert.equal(button.textContent, 'Open evidence'); click(button, { isTrusted: false }); click(button); click(button); assert.deepEqual(m.navigations, [RUN]);
  const accepted = { runId: RUN, state: 'accepted', reason: null, tasks: [{ key: 'build', state: 'complete' }] };
  const forged: [string, unknown][] = [
    ['plan still active', early(accepted, 'active')],
    ['final update still running', early(accepted, 'awaiting_review')],
    ['final update failed', (() => { const v = early(accepted, 'awaiting_review'); v.plan.steps[5] = step(6, 'incorporation', 2, 0, 'completed', 'failed'); return v; })()],
    ['final update unknown', (() => { const v = early(accepted, 'awaiting_review'); v.plan.steps[5] = step(6, 'incorporation', 2, 0, 'unknown', null, 'dispatch_uncertain'); return v; })()],
    ['evidence not acknowledged', (() => { const v = full({ review: accepted }); v.plan.steps[5] = step(6, 'evidence', 2, 0, 'reserved'); return v; })()],
    ['a step still reserved', (() => { const v = full({ review: accepted }); v.plan.steps[3] = step(4, 'worker', 2, 0, 'reserved'); return v; })()],
  ];
  for (const [name, value] of forged) assert.throws(() => readTaskPlanView(text(value), TASK), /Acceptance is not consistent/, name);
  const settled = (() => { const v = early(accepted, 'awaiting_review'); v.plan.steps[5] = step(6, 'incorporation', 2, 0, 'completed', 'completed'); return v; })();
  assert.equal(readTaskPlanView(text(settled), TASK).plan!.review!.state, 'accepted', 'a fully settled early-bound plan may show acceptance');
});

test('hostile plain text stays inert', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  assert.throws(() => readTaskPlanView(text({ ...full(), plan: { ...full().plan, review: { ...full().plan.review, tasks: [{ key: hostile, state: 'complete' }] } } }), TASK), TaskPlanViewError, 'keys are bounded slugs');
  const m = mount(async () => text(full())); m.card.setSelection(selection()); await m.card.refresh();
  assert.ok(m.host.all('img').length === 0);
});

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE, moduleRoot = process.env.ARCANE_UI_MODULE_ROOT, shot = process.env.ARCANE_TASK_PLAN_SCREENSHOT;
const PRODUCT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob:; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
test('owned Edge: released studio.html + studio.css under the exact product CSP, 390px, trusted single navigation', { skip: !browserModule || !moduleRoot, timeout: 60000 }, async t => {
  const modules = resolve(moduleRoot!), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const tag = '<script type="module" src="/studio.js"></script>', released = await readFile('apps/desktop/public/studio.html', 'utf8');
  assert.equal(released.split(tag).length, 2, 'released page has exactly one bootstrap tag');
  // Fixed external bootstrap in place of the product boot; the released markup and stylesheet are otherwise unchanged.
  const html = released.replace(tag, '<script type="module" src="/task-plan-fixture.js"></script>');
  const fixture = `import {TaskPlanCard} from '/m/apps/desktop/src/codex-task-plan.js';
    const violations=[];document.addEventListener('securitypolicyviolation',event=>violations.push(event.violatedDirective+' '+event.blockedURI));
    const host=document.getElementById('codex-task-plan'),stage=document.createElement('main');stage.className='task-plan-stage';
    for(const child of [...document.body.children])child.hidden=true;stage.append(host);document.body.prepend(stage);
    const responses=[${JSON.stringify(text(early()))},${JSON.stringify(text(full()))}];let index=0;window.navigated=[];
    const card=TaskPlanCard.mount(document,host,{read:async()=>responses[Math.min(index,1)],navigateReview:id=>{window.navigated.push(id);}});
    card.setSelection(${JSON.stringify(selection())});await card.refresh();
    window.planFixture={violations,next:async()=>{index=1;card.setSelection(${JSON.stringify(selection())});await card.refresh();}};window.ready=true;`;
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://x').pathname; let body: string | Buffer = '', type = 'text/javascript';
    if (path === '/') { body = html; type = 'text/html'; } else if (path === '/studio.css') { body = css; type = 'text/css'; } else if (path === '/task-plan-fixture.js') body = fixture;
    else if (path.startsWith('/m/') && path.endsWith('.js')) { const file = resolve(modules, '.' + path.slice(2)), child = relative(modules, file); if (isAbsolute(child) || child.startsWith('..')) throw new Error('outside'); body = await readFile(file); }
    else { response.writeHead(path === '/favicon.ico' ? 204 : 404, { 'Content-Security-Policy': PRODUCT_CSP }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': PRODUCT_CSP }); response.end(body);
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors: string[] = [], cspConsole: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text()); });
  await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/'); await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
  const card = page.locator('#codex-task-plan');
  const box = await card.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'card fits the 390px viewport');
  assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'no horizontal overflow inside the card');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page horizontal scroll');
  assert.match(await card.innerText(), /Main task update · sent, waiting for result[\s\S]*Evidence not submitted yet/);
  const evidence = page.getByRole('button', { name: 'Open evidence' });
  await evidence.evaluate(node => (node as HTMLButtonElement).click()); assert.deepEqual(await page.evaluate(() => (window as unknown as { navigated: string[] }).navigated), [], 'synthetic click denied');
  await evidence.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => (window as unknown as { navigated: string[] }).navigated), [RUN], 'trusted Open evidence navigates once');
  if (shot) await writeFile(shot.replace(/\.png$/, '-csp-evidence.png'), await card.screenshot());
  await page.evaluate(() => (window as unknown as { planFixture: { next(): Promise<void> } }).planFixture.next());
  const review = page.getByRole('button', { name: 'Open review' }); await review.waitFor();
  await review.evaluate(node => (node as HTMLButtonElement).click()); await review.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(() => (window as unknown as { navigated: string[] }).navigated), [RUN, RUN], 'trusted Open review navigates exactly once more after the selection change');
  if (shot) await writeFile(shot.replace(/\.png$/, '-csp-review.png'), await card.screenshot());
  assert.deepEqual(await page.evaluate(() => (window as unknown as { planFixture: { violations: string[] } }).planFixture.violations), [], 'no CSP violation from the card modules or styles');
  assert.deepEqual(cspConsole, []); assert.deepEqual(errors, []);
  t.diagnostic('Actual browser ' + browser.version() + '; released studio.html/studio.css; exact product CSP; fixed external bootstrap; private frozen controller.');
});
test('owned Edge: 390px card layout over the private frozen module graph', { skip: !browserModule || !moduleRoot, timeout: 60000 }, async t => {
  const modules = resolve(moduleRoot!), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const fixture = `import {TaskPlanCard} from '/m/apps/desktop/src/codex-task-plan.js';
    const host=document.getElementById('codex-task-plan'),card=TaskPlanCard.mount(document,host,{read:async()=>${JSON.stringify(text(full({ review: { runId: RUN, state: 'changes_requested', reason: null, tasks: [{ key: 'build', state: 'complete' }, { key: 'verify', state: 'pending' }] } })))},navigateReview:id=>{window.navigated=(window.navigated||[]).concat(id);}});
    card.setSelection(${JSON.stringify(selection())});await card.refresh();window.ready=true;`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio.css"></head>
    <body class="arcane-app"><main style="padding:0 16px"><section id="codex-task-plan" class="task-plan" aria-labelledby="codex-task-plan-title" hidden></section></main><script type="module" src="/fixture.js"></script></body></html>`;
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://x').pathname; let body: string | Buffer = '', type = 'text/javascript';
    if (path === '/') { body = html; type = 'text/html'; } else if (path === '/studio.css') { body = css; type = 'text/css'; } else if (path === '/fixture.js') body = fixture;
    else if (path.startsWith('/m/') && path.endsWith('.js')) { const file = resolve(modules, '.' + path.slice(2)), child = relative(modules, file); if (isAbsolute(child) || child.startsWith('..')) throw new Error('outside'); body = await readFile(file); }
    else { response.writeHead(path === '/favicon.ico' ? 204 : 404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'" }); response.end(body);
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/'); await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll at 390px');
  const button = page.getByRole('button', { name: 'Open review' });
  await button.evaluate(node => (node as HTMLButtonElement).click()); assert.equal(await page.evaluate(() => ((window as unknown as { navigated?: string[] }).navigated ?? []).length), 0, 'scripted click inert');
  await button.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => (window as unknown as { navigated?: string[] }).navigated), [RUN]);
  if (shot) await writeFile(shot, await page.screenshot({ fullPage: true }));
  assert.deepEqual(errors, []); t.diagnostic('Actual browser ' + browser.version() + '; private frozen module graph; synthetic read callback.');
});
