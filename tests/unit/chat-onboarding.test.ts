/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import { CodexChatApi, prepareCodexAction, type ChatAction, type ChatActionRecord, type ChatState } from '../../apps/desktop/src/codex-chat.js';

const HUMAN = 'a'.repeat(64), browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const draft = 'Keep my first message.\nAnd its whitespace.  ';
function state(selected = true): ChatState {
  return {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false },
    nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'fixture-sol', id: 'opaque-picker-id', displayName: 'Fixture Sol', efforts: ['low', 'ultra'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: selected ? { model: 'fixture-sol', effort: 'ultra' } : null,
      thread: null, operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    },
  };
}
function thread(st: ChatState) {
  return { threadId: 'fixture-thread', sessionId: 'fixture-session', selection: { ...st.snapshot!.selection! }, configured: true,
    writeGranted: false, turnId: null, turnStatus: 'idle' as const };
}
function receipt(input: ChatAction, st: ChatState, status: ChatActionRecord['state'] = 'acknowledged'): ChatActionRecord {
  return { requestId: input.requestId, connectionId: input.connectionId, action: input.action, state: status,
    threadId: st.snapshot?.thread?.threadId ?? null, turnId: null, model: st.snapshot?.selection?.model ?? null,
    effort: st.snapshot?.selection?.effort ?? null, errorCode: status === 'rejected' ? 'FIXTURE_REJECTED' : null,
    createdAt: new Date().toISOString(), finishedAt: ['pending', 'unknown'].includes(status) ? null : new Date().toISOString() };
}

test('onboarding markup uses a named, non-submit action outside Settings with no authority event', async () => {
  const html = await readFile(resolve('apps/desktop/public/studio.html'), 'utf8');
  const button = html.match(/<button[^>]*id="codex-conversation-start"[^>]*>/)![0];
  assert.match(button, /type="button"/); assert.match(button, /aria-describedby="codex-onboarding-status"/);
  assert.match(button, /disabled hidden/); assert.doesNotMatch(button, /data-workspace-target/);
  assert.equal(html.split('id="codex-conversation-start"').length - 1, 1);
  assert.ok(html.indexOf(button) < html.indexOf('id="settings-drawer"'));
  assert.match(html, /id="codex-onboarding-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('thread start envelopes have only the exact connection, action and request; mismatched receipts stay unknown', async () => {
  const st = state(), input = prepareCodexAction(st, 'thread-start');
  assert.deepEqual(Object.keys(input).sort(), ['action', 'connectionId', 'requestId']);
  const record = receipt(input, st);
  for (const changed of [{ requestId: randomUUID() }, { connectionId: randomUUID() }, { action: 'select' }]) {
    const api = new CodexChatApi(HUMAN, async () => Response.json({ record: { ...record, ...changed }, state: st, replayed: false }));
    await assert.rejects(api.action(input), /exact request/);
  }
});

type Outcome = { record: ChatActionRecord; state: ChatState };
async function fixture(t: TestContext, initial = state()) {
  const build = process.env.ARCANE_UI_BUILD_DIR;
  assert.ok(build, 'Use a private compiled tree, without changing the accepted bundle.');
  let observed = structuredClone(initial), failed = false;
  let handler: ((input: ChatAction) => Promise<Outcome | null>) | null = null;
  const posts: ChatAction[] = [], errors: string[] = [], unexpected: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'arcane-chat-onboarding-'));
  const html = (await readFile(resolve('apps/desktop/public/studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script type="module" src="/onboarding-fixture.js"></script></body>');
  const files = new Map([
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/user-errors.js', [join(build, 'apps/desktop/src/user-errors.js'), 'text/javascript']],
    ['/codex-chat.js', [join(build, 'apps/desktop/src/codex-chat.js'), 'text/javascript']],
    ['/workspace-shell.js', [join(build, 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
    ['/provider-setup.js', [join(build, 'apps/desktop/src/provider-setup.js'), 'text/javascript']],
    ['/brand/arcane-ridges.png', [resolve('apps/desktop/public/brand/arcane-ridges.png'), 'image/png']],
  ]);
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === '/v1/codex/state' || path === '/v1/codex/action') {
      assert.equal(request.headers.authorization, 'Bearer ' + HUMAN, 'Existing HUMAN control transport is required');
      if (path.endsWith('/state')) {
        assert.equal(request.method, 'GET');
        response.writeHead(failed ? 503 : 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(failed ? { error: 'FIXTURE_UNAVAILABLE' } : { state: observed })); return;
      }
      assert.equal(request.method, 'POST');
      let body = ''; for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body) as ChatAction; posts.push(input);
      assert.ok(input.action === 'thread-start' || input.action === 'select', 'No turn, grant, connection or Studio action is allowed in this fixture');
      assert.deepEqual(Object.keys(input).sort(), input.action === 'thread-start' ? ['action', 'connectionId', 'requestId'] : ['action', 'connectionId', 'effort', 'model', 'requestId']);
      let outcome: Outcome | null;
      if (handler) outcome = await handler(input);
      else {
        if (input.action === 'select') observed.snapshot!.selection = { model: input.model, effort: input.effort };
        else observed.snapshot!.thread = thread(observed);
        const record = receipt(input, observed); observed.actions = [record, ...observed.actions];
        outcome = { record, state: observed };
      }
      // Lose the ACK body after a completed HTTP response. Closing an untouched
      // socket makes Chromium retransmit POST at the transport layer.
      if (!outcome) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(); return; }
      response.writeHead(outcome.record.state === 'acknowledged' ? 200 : outcome.record.state === 'rejected' ? 409 : 202, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...outcome, replayed: false })); return;
    }
    assert.equal(request.method, 'GET');
    let content: string | Buffer, contentType = 'text/javascript';
    if (path === '/studio') { content = html; contentType = 'text/html'; }
    else if (path === '/onboarding-fixture.js') content = `
      import {CodexChat, CodexChatApi} from '/codex-chat.js';
      import {startWorkspaceShell} from '/workspace-shell.js';
      import {startProviderSetup} from '/provider-setup.js';
      window.fixtureEvents=[];
      for(const name of ['workspace:settingsrequest','workspace:providersetup']) document.addEventListener(name,()=>window.fixtureEvents.push(name));
      window.fixtureChat=new CodexChat(document,new CodexChatApi('${HUMAN}'));
      window.fixtureShell=startWorkspaceShell(document);
      window.fixtureSetup=startProviderSetup(document,{chat:window.fixtureChat});
      await window.fixtureChat.start(); window.fixtureReady=true;
    `;
    else {
      const file = files.get(path);
      if (!file) { unexpected.push(path); response.writeHead(404); response.end(); return; }
      content = await readFile(file[0]!); contentType = file[1]!;
    }
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'" });
    response.end(content);
  })().catch(error => { errors.push(String(error)); response.destroy(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const context = await playwright.chromium.launchPersistentContext(join(root, 'edge-profile'), {
    headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    viewport: { width: 1440, height: 900 }, args: ['--disable-gpu'],
  });
  t.after(() => context.close());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:' + address.port) { unexpected.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  await page.goto('http://127.0.0.1:' + address.port + '/studio');
  await page.waitForFunction(() => (window as any).fixtureReady === true);
  await page.locator('#codex-composer').fill(draft);
  const refresh = () => page.evaluate(() => (window as any).fixtureChat.refresh());
  t.after(async () => { assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); });
  t.diagnostic('Owned Edge ' + context.browser()!.version() + '; bounded HTTP fixture; no native provider or Studio; ' + root);
  return { page, posts, root, refresh, set: (value: ChatState) => { observed = structuredClone(value); }, observed: () => structuredClone(observed),
    fail: (value: boolean) => { failed = value; }, handler: (value: typeof handler) => { handler = value; } };
}
async function settled(page: Page) {
  await page.waitForFunction(() => document.getElementById('codex-conversation-start')?.getAttribute('aria-busy') === 'false');
}
async function untouched(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(await f.page.locator('#settings-drawer').isVisible(), false);
  assert.equal(await f.page.locator('#codex-composer').inputValue(), draft);
  assert.deepEqual(await f.page.evaluate(() => (window as any).fixtureEvents), []);
  assert.equal(f.observed().snapshot?.thread?.writeGranted ?? false, false);
  assert.deepEqual(f.observed().nativeAssets, { available: true, sealed: true, granted: false, admissionOpen: false });
  assert.deepEqual(f.observed().snapshot?.approvals ?? [], []);
  assert.equal(f.observed().nativeTools.verified, false);
}

async function trustedGuardClick(f: Awaited<ReturnType<typeof fixture>>, guard: string) {
  const {page}=f;
  await page.evaluate(()=>{
    const button=document.getElementById('codex-conversation-start') as HTMLButtonElement,
      stage=document.getElementById('workspace-stage')!,gate=document.getElementById('provider-login-gate')!;
    const display={active:true,repairs:0,clicks:[] as {trusted:boolean;button:number;detail:number;target:string|null;alt:boolean;ctrl:boolean;meta:boolean;shift:boolean}[]};
    // Keep only the original display tamper stable across controller refreshes.
    // The controller state, native guards and normal polling are untouched.
    const restore=()=>{if(!display.active)return;let changed=false;
      if(stage.classList.contains('provider-required')){stage.classList.remove('provider-required');changed=true;}
      if(!gate.hidden){gate.hidden=true;changed=true;}
      if(button.disabled){button.disabled=false;changed=true;}
      if(button.hidden){button.hidden=false;changed=true;}
      if(changed)display.repairs++;
    };
    const observer=new MutationObserver(restore);
    observer.observe(button,{attributes:true,attributeFilter:['disabled','hidden']});
    observer.observe(stage,{attributes:true,attributeFilter:['class']});
    observer.observe(gate,{attributes:true,attributeFilter:['hidden']});
    const cleanup=()=>{display.active=false;observer.disconnect();button.removeEventListener('click',capture,true);};
    const capture=(event:MouseEvent)=>{display.clicks.push({trusted:event.isTrusted,button:event.button,detail:event.detail,
      target:event.target instanceof Element?event.target.closest('button')?.id??null:null,alt:event.altKey,ctrl:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey});
      if(event.isTrusted&&event.button===0)cleanup();
    };
    button.addEventListener('click',capture,true);restore();
    (window as any).fixtureGuardDisplay={display,cleanup,initialRepairs:display.repairs};
  });
  try{
    // Exercise a real controller render after the display override, rather than
    // rely on finishing the gesture before the next 1500ms poll.
    await f.refresh();
    assert.equal(await page.evaluate(()=>{const owned=(window as any).fixtureGuardDisplay;return owned.display.repairs>owned.initialRepairs;}),true,guard+' refresh reapplied the controller display guard');
    await page.locator('#codex-conversation-start').click();
    assert.deepEqual(await page.evaluate(()=>(window as any).fixtureGuardDisplay.display.clicks),
      [{trusted:true,button:0,detail:1,target:'codex-conversation-start',alt:false,ctrl:false,meta:false,shift:false}],guard+' received one real left click');
  }finally{
    await page.evaluate(()=>{const owned=(window as any).fixtureGuardDisplay;owned?.cleanup();delete (window as any).fixtureGuardDisplay;});
  }
}

test('Edge direct start: mount sends zero actions; explicit setup remains single-flight alongside automatic Send', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await fixture(t), { page } = f;
  assert.equal(f.posts.length, 0); assert.equal(await page.locator('#codex-conversation-start').isVisible(), true);
  assert.equal(await page.locator('#codex-thread-start').isVisible(), false);
  assert.equal(await page.locator('#codex-submit').isDisabled(), false, 'A selected model and draft already allow explicit Send to set up its own conversation.');
  await page.screenshot({ path: join(f.root, 'ready-to-start.png') });
  let release!: () => void,received!:()=>void; const held = new Promise<void>(done => { release = done; }),dispatched=new Promise<void>(done=>{received=done;}); t.after(() => release());
  f.handler(async input => { received();await held; const next = f.observed(); next.snapshot!.thread = thread(next);
    const record = receipt(input, next); next.actions = [record]; f.set(next); return { record, state: next }; });
  await page.locator('#codex-conversation-start').evaluate((button: HTMLElement) => button.click());
  assert.equal(f.posts.length, 0, 'Synthetic activation cannot start a conversation');
  await page.locator('#codex-conversation-start').click();
  await page.waitForFunction(() => document.getElementById('codex-conversation-start')?.getAttribute('aria-busy') === 'true');
  await dispatched; // Observe this original transport, rather than equating the earlier busy paint with dispatch.
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.connectionId, f.observed().snapshot!.connectionId);
  assert.equal(await page.locator('#codex-conversation-start').isDisabled(), true);
  // Even an early state poll reporting a thread cannot enable Send while its POST is pending.
  const early = f.observed(); early.snapshot!.thread = thread(early); f.set(early); await f.refresh();
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  release(); await settled(page);
  await page.waitForFunction(() => !(document.getElementById('codex-submit') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#codex-conversation-start').isVisible(), false);
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'thread-start');
  await untouched(f); await page.screenshot({ path: join(f.root, 'acknowledged.png') });
});

test('Edge missing pair opens the composer picker; exact user selection never starts a thread or sends a turn', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await fixture(t, state(false)), { page } = f;
  assert.equal(f.posts.length, 0); assert.equal(await page.locator('#codex-model').inputValue(), '');
  assert.equal(await page.locator('#codex-effort').inputValue(), '');
  await page.locator('#codex-conversation-start').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#codex-model-popover').isVisible(), true);
  assert.equal(await page.locator('#codex-model-popover').getAttribute('data-view'), 'reasoning');
  await page.locator('#codex-picker-current-model').click();
  assert.equal(await page.locator('#codex-model-search').evaluate(node => node === document.activeElement), true);
  assert.equal(f.posts.length, 0); await untouched(f);
  await page.locator('[data-picker-model="fixture-sol"]').click();
  await page.waitForFunction(() => document.getElementById('codex-model-trigger')?.getAttribute('aria-busy') === 'false' && document.getElementById('codex-effort-label')?.textContent === 'low');
  assert.equal(await page.locator('#codex-effort').inputValue(), 'low', 'Explicit model selection acknowledges only its reported default.');
  assert.deepEqual(f.posts, [{ requestId: f.posts[0]!.requestId, connectionId: f.observed().snapshot!.connectionId, action: 'select', model: 'fixture-sol', effort: 'low' }]);
  assert.equal(f.observed().snapshot!.thread, null); await untouched(f);
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false, 'A pending selection closes the picker; its ACK does not reopen it.');
  await page.locator('#codex-model-trigger').click();
  await page.locator('#codex-picker-effort-slider').focus(); await page.keyboard.press('End');
  await page.waitForFunction(() => document.getElementById('codex-model-trigger')?.getAttribute('aria-busy') === 'false' && document.getElementById('codex-effort-label')?.textContent === 'ultra');
  assert.equal(f.posts.length, 2); assert.deepEqual(f.posts[1], { requestId: f.posts[1]!.requestId, connectionId: f.observed().snapshot!.connectionId, action: 'select', model: 'fixture-sol', effort: 'ultra' });
  assert.equal(f.observed().snapshot!.thread, null); assert.equal(await page.locator('#codex-submit').isDisabled(), false);
  await page.keyboard.press('Escape'); await page.locator('#codex-conversation-start').focus(); await page.keyboard.press('Space');
  await settled(page);
  await page.waitForFunction(() => !(document.getElementById('codex-submit') as HTMLButtonElement).disabled);
  assert.deepEqual(f.posts.map(input => input.action), ['select', 'select', 'thread-start']); await untouched(f);
});

test('Edge uncertain start acknowledgements block Send; known rejection permits a new explicit gesture without retry', { skip: !browserModule, timeout: 60000 }, async t => {
  for (const outcome of ['pending', 'unknown', 'rejected', 'lost', 'mismatch'] as const) await t.test(outcome, async t => {
    const f = await fixture(t), { page } = f;
    f.handler(async input => {
      if (outcome === 'lost') return null;
      const next = f.observed(), record = receipt(input, next, outcome === 'mismatch' ? 'acknowledged' : outcome);
      if (outcome === 'mismatch') record.requestId = randomUUID();
      next.actions = [record]; f.set(next); return { record, state: next };
    });
    await page.locator('#codex-conversation-start').click();
    if (outcome === 'rejected') {
      // A rejected start reads in plain words with Review and Details; the request ID lives only in Details.
      await page.waitForFunction(() => document.getElementById('codex-notice-actions')?.hidden === false);
      assert.doesNotMatch(await page.locator('#codex-notice').textContent() ?? '', /[0-9a-f]{8}-[0-9a-f]{4}-|acknowledgement|Request ID/);
      assert.match(await page.locator('#codex-notice-detail').textContent() ?? '', /^Error \d{3} · [^\n]+\n\nRequest [0-9a-f-]{36} · /);
    } else {
      // An unconfirmed start is told once, by the recovery card: plain words, the request ID only in its collapsed Details.
      await page.locator('#codex-unknown').waitFor();
      assert.equal(await page.locator('#codex-notice-actions').isHidden(), true, 'no second copy in the notice line');
      const words = (await page.locator('#codex-unknown-title').textContent() ?? '') + (await page.locator('#codex-unknown-body').textContent() ?? '') + (await page.locator('#codex-notice').textContent() ?? '');
      assert.doesNotMatch(words, /[0-9a-f]{8}-[0-9a-f]{4}-|acknowledgement|Request ID/);
      assert.equal(await page.locator('#codex-unknown-details').evaluate((node: HTMLDetailsElement) => node.open), false);
      assert.match(await page.locator('#codex-unknown-requests').textContent() ?? '', /^Error \d{3} · [^\n]+\n[^\n]+\nTechnical reference: [0-9a-f-]{36} · /);
    }
    await settled(page); assert.equal(f.posts.length, 1); assert.equal(await page.locator('#codex-submit').isDisabled(), outcome!=='rejected');
    assert.equal(await page.locator('#codex-unknown').isVisible(), outcome !== 'rejected');
    assert.equal(await page.locator('#codex-conversation-start').isDisabled(), outcome !== 'rejected');
    await f.refresh(); await f.refresh(); assert.equal(f.posts.length, 1); await untouched(f);
    if (outcome === 'unknown') {
      const next = f.observed(); next.snapshot!.thread = thread(next); next.actions = [receipt(f.posts[0]!, next)]; f.set(next); await f.refresh();
      assert.equal(await page.locator('#codex-submit').isDisabled(), true, 'Reading a later ACK still requires the existing explicit unknown-state review');
      await page.locator('#codex-acknowledge').click();
      await page.waitForFunction(() => !(document.getElementById('codex-submit') as HTMLButtonElement).disabled);
      assert.equal(f.posts.length, 1);
    }
  });
});

test('Edge stale, busy, limited and invalid account states fence both start controls even if DOM disabled is cleared', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await fixture(t), baseline = f.observed(), { page } = f;
  for (const guard of ['busy', 'connecting', 'closing', 'limited', 'notReady', 'disconnected', 'signedOut', 'unsupported', 'noSubscription', 'thread'] as const) {
    const next = structuredClone(baseline);
    if (guard === 'busy') next.busy = true;
    else if (guard === 'connecting') next.connecting = true;
    else if (guard === 'closing') next.closing = true;
    else if (guard === 'limited') next.displayLimited = true;
    else if (guard === 'notReady') next.snapshot!.ready = false;
    else if (guard === 'disconnected') next.snapshot!.connected = false;
    else if (guard === 'signedOut') next.snapshot!.account!.auth = 'signed-out';
    else if (guard === 'unsupported') next.snapshot!.account!.auth = 'unsupported';
    else if (guard === 'noSubscription') next.snapshot!.account!.requiresOpenaiAuth = false;
    else next.snapshot!.thread = thread(next);
    f.set(next); await f.refresh();
    assert.equal(await page.locator('#codex-thread-start').isDisabled(), true, guard);
    assert.equal(await page.locator('#codex-conversation-start').isDisabled(), true, guard);
    await trustedGuardClick(f,guard); assert.equal(f.posts.length, 0, guard);
  }
  f.set(baseline); await f.refresh(); f.fail(true); await f.refresh();
  assert.equal(await page.locator('#codex-conversation-start').isDisabled(), true);
  await trustedGuardClick(f,'stale read'); assert.equal(f.posts.length, 0);
  f.fail(false); await f.refresh();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#codex-conversation-start').evaluate(node => {
    const button = node.getBoundingClientRect(), conversation = node.closest('.conversation-scroll')!.getBoundingClientRect();
    return button.top >= conversation.top && button.bottom <= conversation.bottom;
  }), true, 'Start conversation stays visible above the mobile composer');
  assert.match(await page.locator('#codex-onboarding-status').textContent() ?? '', /won’t send your message/);
  await page.screenshot({ path: join(f.root, 'mobile.png') }); await untouched(f);
});

test('Edge a late start ACK from the previous connection cannot replace the current thread scope', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await fixture(t), original = f.observed(), { page } = f;
  let release!: () => void; const held = new Promise<void>(done => { release = done; }); t.after(() => release());
  f.handler(async input => { await held; original.snapshot!.thread = thread(original);
    return { record: receipt(input, original), state: original }; });
  await page.locator('#codex-conversation-start').click();
  await page.waitForFunction(() => document.getElementById('codex-conversation-start')?.getAttribute('aria-busy') === 'true');
  const replacement = state(); f.set(replacement); await f.refresh();
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  release(); await settled(page);
  assert.match(await page.locator('#codex-scope').textContent() ?? '', new RegExp(replacement.snapshot!.connectionId));
  assert.doesNotMatch(await page.locator('#codex-scope').textContent() ?? '', /fixture-thread/);
  assert.equal(await page.locator('#codex-submit').isDisabled(), false, 'The fresh selected connection can set up its own conversation on a new human Send.');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.connectionId, original.snapshot!.connectionId);
  await untouched(f);
});
