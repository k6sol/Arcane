import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserContext } from 'playwright-core';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { createLearningService } from '../../apps/daemon/src/learning-service.js';
import type { CodexService, CodexProductState } from '../../apps/daemon/src/codex-service.js';
import { workflowReceiptParent } from '../../apps/daemon/src/workflow-host.js';
import type { WorkflowPreview, WorkflowEvidencePreparationResponse, WorkflowDraftResponse } from '../../apps/daemon/src/workflow-host.js';
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

test('owned Edge synthetic installed-cli metadata fixture exercises evidence, explicit decisions, same-chat draft, tools and reload',
  { skip: !browserModule || process.platform !== 'win32', timeout: 60000 }, async t => {
  assert.equal(resolve(browserExecutable).toLowerCase(), resolve(EDGE).toLowerCase(), 'Use only the fixed installed Edge executable.');
  assert.equal(resolve(browserModule!).toLowerCase(), resolve(SOURCE, 'node_modules/playwright-core/index.mjs').toLowerCase(),
    'Use the repository Playwright test runtime.');
  assert.ok(existsSync(EDGE));
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-browser-'));
  const fixtureStarted = Date.now();
  let lastPhase = 'setup';
  const mark = (phase: string) => { lastPhase = phase; t.diagnostic('Fixture phase: ' + phase + ' elapsedMs=' + (Date.now() - fixtureStarted)); };
  t.after(() => t.diagnostic('Final fixture phase: ' + lastPhase + ' elapsedMs=' + (Date.now() - fixtureStarted)));
  const projectPath = join(root, 'project'), resources = join(root, 'resources'), stateDirectory = join(root, 'connection-lab');
  const profile = join(root, 'edge-profile');
  const verification = join(SOURCE, 'runtime/verification', 'workflow-browser-' + randomUUID());
  const screenshot = join(verification, 'workflow.png');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  const briefBytes = Buffer.from('Owned evidence brief: preserve the local request and measurable acceptance.\nUTF-8 proof: café 🧩\n');
  const briefPath = 'src/brief.txt';
  const briefHash = createHash('sha256').update(briefBytes).digest('hex');
  writeFileSync(join(projectPath, briefPath), briefBytes);
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
  // Borrowed synthetic installed-cli metadata through the CodexService state seam.
  // This declares the installed/coding prerequisite for this UI-only fixture; it
  // neither creates an installed CLI client nor proves actual CLI integration.
  // The independent workflow-native-model.test.ts keeps spawned-node-fixture
  // projection installed:false; production metadata and guards remain unchanged.
  const snapshot: Snapshot = {
    connectionId: randomUUID(), provenance: 'installed-cli', connected: true, ready: true,
    account: { auth: 'subscription', plan: 'plus', requiresOpenaiAuth: true },
    models: [{ model: selection.model, id: 'offline-browser-model', displayName: 'Offline browser fixture',
      efforts: ['high'], defaultEffort: 'high', entitlement: 'unverified' }],
    selection, thread: { threadId: native.threadId, sessionId: native.sessionId, selection,
      configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' },
    operations: [], approvals: [], events: [{ seq: 1, type: 'delta', threadId: native.threadId,
      turnId: 'recorded-fixture-turn', itemId: 'recorded-fixture-text', text: 'Owned fixture public transcript.' }],
    droppedEvents: 0, lastEventSeq: 1, failureCode: null,
  };
  const counters = { installedCliStarts: 0, nativeActions: 0, nativeCloses: 0, providerProbes: 0 };
  t.diagnostic('Borrowed synthetic installed-cli metadata fixture only; no installed CLI client or model turn is started.');
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
    const allowedPost = ['/v1/workflows/preview', '/v1/workflows/execute', '/v1/workflows/receipt', '/v1/workflows/evidence', '/v1/workflows/draft'];
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
  mark('initial-navigation');
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
  const composer = await page.locator('#codex-composer').elementHandle();
  assert.ok(composer);
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
  const observed=await page.evaluate(()=>document.querySelector('#workflow-panel')?.textContent??'');
  assert.ok(observed.includes('offline-browser-fixture'));
  assert.equal(preview.request!.model!.model,selection.model);
  assert.equal(preview.request!.model!.effort,selection.effort);
  assert.match(preview.request!.model!.connectionRevision,/^[a-f0-9]{64}$/);
  assert.equal(work.runs().length, 0);
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="confirm"]');
    return !!button && !button.disabled;
  });
  const executedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workflows/execute');
  await page.locator('[data-workflow-action="confirm"]').click();
  const commandResponse = await executedResponse;
  const created = await commandResponse.json() as WorkflowSnapshot & { conversation: NativeConversation };
  assert.equal(commandResponse.status(), 200, 'Workflow execute response: ' + JSON.stringify(created));
  mark('workflow-created');
  assert.deepEqual(created.conversation, native);
  await page.waitForFunction(() => document.querySelector('#workflow-panel [role="status"]')?.textContent?.includes('recorded: created'));
  assert.equal(work.runs().length, 1);
  const associations = new ConversationWorkStore({ directory: join(stateDirectory, 'conversation-work'), projectPath });
  try { assert.deepEqual(associations.binding('workflow', created.workflow.id)!.conversation, native); }
  finally { associations.close(); }

  // Assistance reads actual files, but cannot submit evidence or accept a step.
  const executions = () => workflowRequests.filter(r => r.method === 'POST' && r.path === '/v1/workflows/execute').length;
  const promptTaskId = created.workflow.taskIds.prompt!;
  const requirementsTaskId = created.workflow.taskIds.requirements!;
  await page.locator('#workflow-step').selectOption('prompt');
  await page.locator('#workflow-action').selectOption('handoff');
  await page.locator('#workflow-files-brief').fill(briefPath);
  const taskBeforePreparation = work.task(promptTaskId);
  const evidenceReply = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/v1/workflows/evidence' && response.request().method() === 'POST');
  await page.locator('[data-workflow-action="evidence-files"]').click();
  const fileResponse = await evidenceReply;
  assert.equal(fileResponse.status(), 200);
  assert.deepEqual(fileResponse.request().postDataJSON(), {
    workflowId: created.workflow.id, stepKey: 'prompt', files: [{ path: briefPath, role: 'brief' }],
  });
  const preparedFiles = await fileResponse.json() as WorkflowEvidencePreparationResponse;
  assert.equal(preparedFiles.workflowId, created.workflow.id);
  assert.equal(preparedFiles.projectId, created.workflow.projectId);
  assert.equal(preparedFiles.workflowRevision, created.workflow.revision);
  assert.equal(preparedFiles.stepKey, 'prompt');
  assert.deepEqual(preparedFiles.conversation, native);
  assert.deepEqual(preparedFiles.submission, {
    key: 'prompt', artifacts: [{ path: briefPath, role: 'brief', sha256: briefHash, bytes: briefBytes.length }],
    subjectHashes: [], checks: [],
  });
  await page.waitForFunction(hash => {
    const input = document.getElementById('workflow-evidence') as HTMLTextAreaElement | null;
    return !!input && input.value.includes(hash);
  }, briefHash);
  assert.deepEqual(JSON.parse(await page.locator('#workflow-evidence').inputValue()), preparedFiles.submission);
  assert.deepEqual(work.task(promptTaskId), taskBeforePreparation);
  assert.equal(executions(), 1);
  assert.equal(await page.locator('[data-workflow-action="confirm"]').isVisible(), false);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);

  // Each durable command has its own real preview and a separate trusted click.
  const confirmDecision = async (
    kind: 'submit-evidence' | 'review-evidence' | 'recipe-gate',
    result: 'submitted' | 'reviewed' | 'decided',
    stepKey: 'prompt' | 'requirements',
    inspect: (prepared: WorkflowPreview) => void,
  ): Promise<WorkflowSnapshot & { conversation: NativeConversation }> => {
    const before = executions(), beforePrompt = work.task(promptTaskId), beforeRequirements = work.task(requirementsTaskId);
    const previewReply = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/v1/workflows/preview' && response.request().method() === 'POST');
    await page.locator('[data-workflow-action="decision"]').click();
    const response = await previewReply;
    assert.equal(response.status(), 200);
    const prepared = await response.json() as WorkflowPreview;
    assert.equal(prepared.prepared.kind, kind);
    assert.equal(prepared.prepared.workflowId, created.workflow.id);
    assert.equal(prepared.prepared.stepKey, stepKey);
    assert.deepEqual(prepared.conversation, native);
    inspect(prepared);
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="confirm"]');
      return !!button && !button.disabled;
    });
    assert.equal(executions(), before, 'Preview cannot execute a durable command.');
    assert.deepEqual(work.task(promptTaskId), beforePrompt);
    assert.deepEqual(work.task(requirementsTaskId), beforeRequirements);
    const executedReply = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/v1/workflows/execute' && response.request().method() === 'POST');
    await page.locator('[data-workflow-action="confirm"]').click();
    const executed = await executedReply;
    assert.equal(executed.status(), 200);
    const body = await executed.json() as WorkflowSnapshot & { conversation: NativeConversation; result: string };
    assert.equal(body.result, result);
    assert.equal(body.workflow.id, created.workflow.id);
    assert.deepEqual(body.conversation, native);
    await page.waitForFunction(expected => {
      const status = document.querySelector('#workflow-panel [role="status"]');
      return status?.textContent?.includes('recorded: ' + expected);
    }, result);
    assert.equal(executions(), before + 1);
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    assert.equal(counters.nativeActions, 0);
    return body;
  };
  mark('submit-evidence');
  const handedOff = await confirmDecision('submit-evidence', 'submitted', 'prompt', prepared => {
    assert.deepEqual(prepared.prepared.submission, preparedFiles.submission);
  });
  assert.equal(handedOff.workflow.taskStates.prompt, 'needs_review');
  assert.equal(work.task(promptTaskId).state, 'needs_review');
  assert.deepEqual(handedOff.workflow.submissions.find(s => s.key === 'prompt'), preparedFiles.submission);
  assert.equal(work.task(requirementsTaskId).state, 'pending');

  mark('review-evidence');
  await page.locator('#workflow-action').selectOption('review');
  await page.locator('#workflow-decision').selectOption('approved');
  const reviewed = await confirmDecision('review-evidence', 'reviewed', 'prompt', prepared => {
    assert.equal(prepared.prepared.decision, 'approved');
    assert.deepEqual(prepared.prepared.submission, preparedFiles.submission);
  });
  assert.equal(reviewed.workflow.taskStates.prompt, 'complete');
  assert.equal(work.task(promptTaskId).state, 'complete');
  const beforeGate = reviewed.assessment!.steps.find(s => s.key === 'requirements');
  assert.ok(beforeGate);
  t.diagnostic('Synthetic installed-cli requirements before explicit gate: ' + JSON.stringify(beforeGate));
  assert.equal(beforeGate.disposition, 'pending');
  assert.ok(beforeGate.blockers.some(b => b.code === 'human'), 'Model handoff still requires its explicit human gate.');
  assert.ok(!beforeGate.blockers.some(b => b.code === 'provider'), 'Declared synthetic installed/coding prerequisite must be satisfied: ' + JSON.stringify(beforeGate));

  await page.locator('#workflow-step').selectOption('requirements');
  await page.locator('#workflow-action').selectOption('gate');
  await page.locator('#workflow-gate').selectOption('model-handoff');
  await page.locator('#workflow-decision').selectOption('approved');
  assert.equal(await page.locator('[data-workflow-action="draft"]').isDisabled(), true);
  mark('model-gate');
  const gated = await confirmDecision('recipe-gate', 'decided', 'requirements', prepared => {
    assert.equal(prepared.prepared.decision, 'approved');
    assert.equal(prepared.prepared.recipeGate!.gate, 'model-handoff');
    assert.deepEqual(prepared.prepared.subjectHashes, [briefHash]);
    assert.deepEqual(prepared.prepared.inputArtifacts, [{ ...preparedFiles.submission.artifacts[0]!, stepKey: 'prompt' }]);
  });
  const afterGate = gated.assessment!.steps.find(s => s.key === 'requirements');
  assert.ok(afterGate);
  t.diagnostic('Synthetic installed-cli requirements after explicit gate: ' + JSON.stringify(afterGate));
  assert.equal(afterGate.disposition, 'human-handoff', 'Synthetic metadata prerequisite or gate is still blocked: ' + JSON.stringify(afterGate));
  assert.deepEqual(afterGate.blockers, []);
  assert.equal(gated.workflow.taskStates.requirements, 'pending');
  assert.equal(executions(), 4);

  // The server prepares text; the UI appends that exact text to the same composer.
  const beforeDraft = { prompt: work.task(promptTaskId), requirements: work.task(requirementsTaskId) };
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="draft"]');
    return !!button && !button.disabled;
  });
  const draftReply = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/v1/workflows/draft' && response.request().method() === 'POST');
  await page.locator('[data-workflow-action="draft"]').click();
  const textResponse = await draftReply;
  assert.equal(textResponse.status(), 200);
  assert.deepEqual(textResponse.request().postDataJSON(), { workflowId: created.workflow.id, stepKey: 'requirements' });
  mark('draft-returned');
  const serverDraft = await textResponse.json() as WorkflowDraftResponse;
  assert.equal(serverDraft.workflowId, created.workflow.id);
  assert.equal(serverDraft.projectId, created.workflow.projectId);
  assert.equal(serverDraft.workflowRevision, gated.workflow.revision);
  assert.equal(serverDraft.stepKey, 'requirements');
  assert.deepEqual(serverDraft.conversation, native);
  assert.deepEqual(serverDraft.model, preview.request!.model);
  assert.equal(serverDraft.requiresHumanSubmit, true);
  assert.equal(serverDraft.startsNativeTurn, false);
  assert.ok(serverDraft.text.includes(briefPath) && serverDraft.text.includes(briefHash));
  assert.ok(serverDraft.text.includes('This draft grants no permission and runs no tool.'));
  const appendedDraft = draft + '\n\n' + serverDraft.text;
  await page.waitForFunction(expected => {
    const input = document.getElementById('codex-composer') as HTMLTextAreaElement | null;
    return input?.value === expected;
  }, appendedDraft);
  assert.equal(await composer.evaluate(element => element === document.getElementById('codex-composer')), true);
  assert.equal(await page.locator('#codex-composer').inputValue(), appendedDraft);
  assert.equal(await page.locator('#codex-messages').textContent(), chat);
  assert.deepEqual(work.task(promptTaskId), beforeDraft.prompt);
  assert.deepEqual(work.task(requirementsTaskId), beforeDraft.requirements);
  assert.equal(work.task(requirementsTaskId).evidence.length, 0);
  assert.equal(work.runs().length, 1);
  assert.equal(executions(), 4);
  assert.equal(counters.installedCliStarts, 0); assert.equal(counters.nativeActions, 0); assert.equal(counters.providerProbes, 0);
  assert.equal(snapshot.thread!.writeGranted, false);
  assert.equal(snapshot.thread!.turnId, null);
  assert.deepEqual(snapshot.operations, []); assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(codex.state().actions, []);
  assert.equal(assets.jobs().length, 0); assert.equal(studio.commands().length, 0); assert.equal(studio.keys().length, 0);

  for (const tool of ['blender', 'roblox', 'all']) {
    await page.locator('.workspace-tabs [data-workspace-tool="' + tool + '"]').click();
    assert.equal(await page.locator('#codex-composer').inputValue(), appendedDraft);
    assert.equal(await page.locator('#codex-messages').textContent(), chat);
  }
  // Switching native identity must preserve the appended draft but block sending.
  const foreignThread = randomUUID(); snapshot.thread!.threadId = foreignThread;
  await page.waitForFunction(() => {
    const warning=document.getElementById('codex-draft-review'),submit=document.getElementById('codex-submit') as HTMLButtonElement|null;
    return !!warning&&!warning.hidden&&submit?.disabled;
  });
  assert.equal(await page.locator('#codex-composer').inputValue(), appendedDraft);
  mark('native-draft-review');
  await page.locator('#codex-draft-review-button').click();
  await page.waitForFunction(() => (document.getElementById('codex-confirm') as HTMLDialogElement|null)?.open);
  const draftReview=await page.locator('#codex-confirm-preview').textContent();
  assert.ok(draftReview!.includes(native.threadId)&&draftReview!.includes(foreignThread));
  assert.ok(draftReview!.includes(serverDraft.text));
  await page.locator('#codex-confirm-check').check();
  await page.locator('#codex-confirm-submit').click();
  await page.waitForFunction(() => document.getElementById('codex-draft-review')?.hidden===true);
  assert.equal(await page.locator('#codex-composer').inputValue(), appendedDraft);
  assert.equal(await page.locator('#codex-submit').isDisabled(), false);
  assert.equal(counters.nativeActions,0);assert.equal(snapshot.thread!.writeGranted,false);
  assert.equal(executions(),4,'Draft re-review cannot mutate workflows.');
  snapshot.thread!.threadId=native.threadId;
  await page.waitForFunction(thread=>document.getElementById('codex-scope')?.textContent?.includes('Thread '+thread),native.threadId);
  assert.equal(await page.locator('#codex-composer').inputValue(), appendedDraft);
  assert.equal(counters.nativeActions, 0);
  assert.deepEqual(await page.evaluate(() => (window as typeof window & { fixtureCspViolations: string[] }).fixtureCspViolations), []);
  // Read a response from an explicit post-navigation refresh. A timing-only
  // filter can still select an old-document poll queued immediately before reload,
  // whose response body Chromium correctly discards on navigation.
  mark('reload');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#workflow-details > summary').click();
  await page.waitForFunction(id => (document.getElementById('workflow-stored') as HTMLSelectElement | null)?.value === id, created.workflow.id);
  const currentResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/workflows/current-flow')
    .then(response => response.json() as Promise<WorkflowSnapshot & {conversation?: NativeConversation}>);
  mark('post-reload-refresh');
  await page.locator('[data-workflow-action="refresh"]').click();
  mark('await-post-reload-response');
  const current = await currentResponse;
  assert.deepEqual(current.conversation, native);
  assert.equal(current.workflow.id, created.workflow.id);
  await page.waitForFunction(id => {
    const action = document.getElementById('workflow-action') as HTMLSelectElement | null;
    return document.getElementById('workflow-stored') instanceof HTMLSelectElement &&
      (document.getElementById('workflow-stored') as HTMLSelectElement).value === id && !!action && !action.disabled;
  }, created.workflow.id);
  assert.equal(current.workflow.taskStates.prompt, 'complete');
  assert.equal(current.workflow.taskStates.requirements, 'pending');
  assert.deepEqual(current.workflow.submissions.find(s => s.key === 'prompt'), preparedFiles.submission);
  assert.ok(current.workflow.decisions.some(d => d.stepKey === 'requirements' && d.gate === 'model-handoff' && d.decision === 'approved'));
  await page.locator('#workflow-step').selectOption('requirements');
  await page.locator('#workflow-action').selectOption('handoff');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-workflow-action="decision"]');
    return !!button && !button.disabled;
  });
  assert.ok(!(await page.locator('#workflow-panel').textContent())!.includes('no attested link'));
  assert.equal(work.runs().length, 1);
  assert.equal(executions(), 4);
  assert.equal(workflowRequests.filter(r => r.method === 'POST' && r.path === '/v1/workflows/evidence').length, 1);
  assert.equal(workflowRequests.filter(r => r.method === 'POST' && r.path === '/v1/workflows/draft').length, 1);
  assert.equal(await page.locator('[data-workflow-action="draft"]').isDisabled(), false);
  assert.equal(counters.installedCliStarts, 0); assert.equal(counters.nativeActions, 0); assert.equal(counters.providerProbes, 0);
  assert.equal(assets.jobs().length, 0); assert.equal(studio.commands().length, 0); assert.equal(studio.keys().length, 0);
  assert.deepEqual(forbiddenRequests, []); assert.deepEqual(failedResources, []); assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as typeof window & { fixtureCspViolations: string[] }).fixtureCspViolations), []);
  const visible = await page.locator('body').innerText();
  assert.ok(!visible.includes(app.token) && !visible.includes(app.agentToken));
  assert.equal(new URL(page.url()).hash, '');
  await page.locator('#workflow-panel').scrollIntoViewIfNeeded();
  mark('screenshot');
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.ok(lstatSync(screenshot).size > 1000);
  t.diagnostic('Owned Edge renderer with borrowed synthetic installed-cli metadata; actual CLI integration untested; installedCliStarts=' + counters.installedCliStarts + '; nativeActions=' + counters.nativeActions + '; version=' + context.browser()!.version() + '; screenshot=' + screenshot);
});
