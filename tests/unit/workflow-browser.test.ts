import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserContext } from 'playwright-core';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { createLearningService } from '../../apps/daemon/src/learning-service.js';
import type { CodexService, CodexProductState } from '../../apps/daemon/src/codex-service.js';
import { workflowReceiptParent } from '../../apps/daemon/src/workflow-host.js';
import type { WorkflowPreview } from '../../apps/daemon/src/workflow-host.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import { ConversationWorkStore, type NativeConversation } from '../../packages/storage/src/conversation-work-store.js';
import type { Snapshot } from '../../packages/codex-client/src/types.js';
// Include the actual UI and its imports in an isolated compile, without a Node DOM.
type ProductBrowserModule = typeof import('../../apps/desktop/src/studio.js');

const SOURCE = resolve(process.cwd());
const EMITTED = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const browserExecutable = process.env.ARCANE_UI_BROWSER_EXE ?? EDGE;

test('owned Edge exercises the real unified workflow UI, exact native attestation, tool switching and reload',
  { skip: !browserModule || process.platform !== 'win32', timeout: 60000 }, async t => {
  assert.equal(resolve(browserExecutable).toLowerCase(), resolve(EDGE).toLowerCase(), 'Use only the fixed installed Edge executable.');
  assert.equal(resolve(browserModule!).toLowerCase(), resolve(SOURCE, 'node_modules/playwright-core/index.mjs').toLowerCase(),
    'Use the repository Playwright test runtime.');
  assert.ok(existsSync(EDGE));
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-browser-'));
  const projectPath = join(root, 'project'), resources = join(root, 'resources'), stateDirectory = join(root, 'connection-lab');
  const profile = join(root, 'edge-profile');
  const verification = join(SOURCE, 'runtime/verification', 'workflow-browser-' + randomUUID());
  const screenshot = join(verification, 'workflow.png');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  mkdirSync(join(resources, 'apps/desktop/public/brand'), { recursive: true });
  mkdirSync(join(resources, 'dist/apps/desktop/src'), { recursive: true });
  mkdirSync(verification, { recursive: true, mode: 0o700 });
  for (const name of ['studio.html', 'studio.css']) {
    copyFileSync(join(SOURCE, 'apps/desktop/public', name), join(resources, 'apps/desktop/public', name));
  }
  copyFileSync(join(SOURCE, 'apps/desktop/public/brand/arcane-ridges.png'), join(resources, 'apps/desktop/public/brand/arcane-ridges.png'));
  for (const name of ['studio', 'codex-chat', 'codex-history', 'learning-panel', 'workspace-shell', 'asset-downloads', 'workflow-panel']) {
    copyFileSync(join(EMITTED, 'apps/desktop/src', name + '.js'), join(resources, 'dist/apps/desktop/src', name + '.js'));
  }

  const studio = new StudioStore({ directory: join(root, 'studio') });
  const work = new WorkStore({ directory: join(root, 'work'), projectPath });
  const assets = await createAssetService({ cwd: root, projectPath, outputRoot: join(root, 'runtime/assets'),
    workerRoot: join(SOURCE, 'workers/blender') });
  const learning = createLearningService({ directory: join(root, 'learning'), projectPath });
  const native: NativeConversation = { provider: 'codex', threadId: randomUUID(), sessionId: randomUUID() };
  const selection = { model: 'offline-browser-fixture', effort: 'high' };
  const snapshot: Snapshot = {
    connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
    account: { auth: 'subscription', plan: 'plus', requiresOpenaiAuth: true },
    models: [{ model: selection.model, id: 'offline-browser-model', displayName: 'Offline browser fixture',
      efforts: ['high'], defaultEffort: 'high', entitlement: 'unverified' }],
    selection, thread: { threadId: native.threadId, sessionId: native.sessionId, selection,
      configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' },
    operations: [], approvals: [], events: [{ seq: 1, type: 'delta', threadId: native.threadId,
      turnId: 'recorded-fixture-turn', itemId: 'recorded-fixture-text', text: 'Owned fixture public transcript.' }],
    droppedEvents: 0, lastEventSeq: 1, failureCode: null,
  };
  const counters = { nativeActions: 0, nativeCloses: 0, providerProbes: 0 };
  let closed = false;
  const codex: CodexService = {
    state(): CodexProductState {
      assert.equal(closed, false);
      return structuredClone({ provider: 'codex', use: 'personal-local', projectPath, connecting: false, closing: false,
        busy: false, snapshot, lastSnapshot: null, actions: [], nativeHistory: null,
        nativeTools: { configured: false, verified: false } });
    },
    async action() { counters.nativeActions++; throw new Error('Native lifecycle actions are forbidden in this browser fixture.'); },
    async close() { counters.nativeCloses++; closed = true; },
  };
  let app: Awaited<ReturnType<typeof createConnectionLab>> | undefined;
  let context: BrowserContext | undefined;
  let receiptParent: string | undefined;
  t.after(async () => {
    try { await context?.close(); } finally {
      try { await app?.close(); } finally {
        await assets.close(); learning.close(); work.close(); studio.close();
        if (receiptParent && existsSync(receiptParent)) {
          const part = relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent));
          assert.match(part, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(receiptParent).isSymbolicLink());
          rmSync(resolve(receiptParent), { recursive: true, force: true });
        }
        const part = relative(resolve(tmpdir()), resolve(root));
        assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink());
        rmSync(resolve(root), { recursive: true, force: true });
      }
    }
  });
  app = await createConnectionLab({ cwd: resources, stateDirectory, projectPath, studioStore: studio,
    workStore: work, assetService: assets, learningService: learning, codexService: codex,
    probe: async () => { counters.providerProbes++; return []; }, port: 0 });
  receiptParent = workflowReceiptParent(join(stateDirectory, 'workflows'), workflowProjectIdentity(projectPath).projectId);
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  // launchPersistentContext creates an isolated disposable user-data directory.
  // No connectOverCDP, existing-browser discovery or live user profile is used.
  context = await playwright.chromium.launchPersistentContext(profile, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    args: ['--disable-gpu'], serviceWorkers: 'block',
  });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const errors: string[] = [], failedResources: string[] = [], forbiddenRequests: string[] = [];
  const workflowRequests: { method: string; path: string }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => {
    if (['script', 'stylesheet', 'image', 'font'].includes(request.resourceType())) {
      failedResources.push(new URL(request.url()).pathname + ': ' + request.failure()?.errorText);
    }
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/v1/workflows')) workflowRequests.push({ method: request.method(), path });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const allowedPost = ['/v1/workflows/preview', '/v1/workflows/execute', '/v1/workflows/receipt'];
    if (url.origin !== app!.origin || url.pathname.startsWith('/v1/native/') || url.pathname.startsWith('/v1/plugin/') ||
        (request.method() === 'POST' && !allowedPost.includes(url.pathname))) {
      forbiddenRequests.push(url.origin === app!.origin ? url.pathname : url.origin);
      await route.abort(); return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    const state = window as typeof window & { fixtureCspViolations: string[] };
    state.fixtureCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      state.fixtureCspViolations.push(event.effectiveDirective + ': ' + event.blockedURI);
    });
  });
  const navigation = await page.goto(app.origin + '/studio#' + app.token, { waitUntil: 'domcontentloaded' });
  assert.ok(navigation);
  const csp = navigation.headers()['content-security-policy']!;
  assert.match(csp, /script-src 'self'/); assert.match(csp, /style-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  await page.waitForFunction(path => document.getElementById('project-path')?.textContent === path, projectPath);
  await page.waitForFunction(() => document.getElementById('codex-messages')?.textContent?.includes('Owned fixture public transcript.'));
  await page.locator('#workflow-details > summary').click();
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="recipe"]');
    return !!button && !button.disabled;
  });
  assert.ok(workflowRequests.some(r => r.method === 'GET' && r.path === '/v1/workflows'));
  assert.equal(work.runs().length, 0);
  const draft = 'Unsent draft preserved across tool selection.';
  await page.locator('#codex-composer').fill(draft);
  const chat = await page.locator('#codex-messages').textContent();
  await page.locator('#workflow-title').fill('Edge-owned workflow proof');
  await page.locator('#workflow-prompt').fill('Review a scoped local change with pinned evidence; no native turn is requested.');
  await page.locator('#workflow-scope').fill('src');
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workflows/preview');
  await page.locator('[data-workflow-action="recipe"]').click();
  const preparedResponse = await previewResponse;
  assert.equal(preparedResponse.status(), 200);
  const preview = await preparedResponse.json() as WorkflowPreview;
  assert.deepEqual(preview.conversation, native);
  assert.equal(work.runs().length, 0);
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="confirm"]');
    return !!button && !button.disabled;
  });
  const executedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workflows/execute');
  await page.locator('[data-workflow-action="confirm"]').click();
  const commandResponse = await executedResponse;
  assert.equal(commandResponse.status(), 200);
  const created = await commandResponse.json() as WorkflowSnapshot & { conversation: NativeConversation };
  assert.deepEqual(created.conversation, native);
  await page.waitForFunction(() => document.querySelector('#workflow-panel [role="status"]')?.textContent?.includes('recorded: created'));
  assert.equal(work.runs().length, 1);
  const associations = new ConversationWorkStore({ directory: join(stateDirectory, 'conversation-work'), projectPath });
  try { assert.deepEqual(associations.binding('workflow', created.workflow.id)!.conversation, native); }
  finally { associations.close(); }

  for (const tool of ['blender', 'roblox', 'all']) {
    await page.locator('.workspace-tabs [data-workspace-tool="' + tool + '"]').click();
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    assert.equal(await page.locator('#codex-messages').textContent(), chat);
  }
  assert.equal(counters.nativeActions, 0);
  assert.deepEqual(await page.evaluate(() => (window as typeof window & { fixtureCspViolations: string[] }).fixtureCspViolations), []);
  const currentResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workflows/current-flow');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const current = await (await currentResponse).json() as WorkflowSnapshot & { conversation: NativeConversation };
  assert.deepEqual(current.conversation, native);
  assert.equal(current.workflow.id, created.workflow.id);
  await page.locator('#workflow-details > summary').click();
  await page.waitForFunction(id => {
    const action = document.getElementById('workflow-action') as HTMLSelectElement | null;
    return document.getElementById('workflow-stored') instanceof HTMLSelectElement &&
      (document.getElementById('workflow-stored') as HTMLSelectElement).value === id && !!action && !action.disabled;
  }, created.workflow.id);
  await page.locator('#workflow-action').selectOption('handoff');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="decision"]');
    return !!button && !button.disabled;
  });
  assert.ok(!(await page.locator('#workflow-panel').textContent())!.includes('no attested link'));
  assert.equal(work.runs().length, 1);
  assert.equal(workflowRequests.filter(r => r.method === 'POST' && r.path === '/v1/workflows/execute').length, 1);
  assert.equal(counters.nativeActions, 0); assert.equal(counters.providerProbes, 0);
  assert.equal(assets.jobs().length, 0); assert.equal(studio.commands().length, 0); assert.equal(studio.keys().length, 0);
  assert.deepEqual(forbiddenRequests, []); assert.deepEqual(failedResources, []); assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as typeof window & { fixtureCspViolations: string[] }).fixtureCspViolations), []);
  const visible = await page.locator('body').innerText();
  assert.ok(!visible.includes(app.token) && !visible.includes(app.agentToken));
  assert.equal(new URL(page.url()).hash, '');
  await page.locator('#workflow-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.ok(lstatSync(screenshot).size > 1000);
  t.diagnostic('Owned Edge profile; version=' + context.browser()!.version() + '; screenshot=' + screenshot);
});
