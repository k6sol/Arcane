import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioApi, StudioRequestError, StudioWorkbench, type Baseline, type IssuedStudioKey } from '../../apps/desktop/src/studio.js';
import type { InstanceRef, Json, StudioCommand, StudioSession } from '../../packages/protocol/src/studio.js';

// Only browser controller code and in-memory DOM/transport fixtures are evaluated.
// No SDK, browser, daemon, Studio, native bridge or external service is used.
class ElementFixture extends EventTarget {
  textContent = ''; value = ''; hidden = false; disabled = false; className = ''; type = ''; checked = false; open = false;
  children: ElementFixture[] = []; attributes = new Map<string, string>();
  constructor(readonly tagName = 'DIV') { super(); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  replaceChildren(...children: ElementFixture[]) { this.children = children; }
  append(...children: ElementFixture[]) { this.children.push(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  showModal() { this.open = true; }
}
class DocumentFixture {
  defaultView = null;
  elements = new Map<string, ElementFixture>();
  getElementById(id: string) { return id === 'settings-key-select' ? null : this.element(id); }
  element(id: string) { let element = this.elements.get(id); if (!element) { element = new ElementFixture(); this.elements.set(id, element); } return element; }
  createElement(tag: string) { return new ElementFixture(tag.toUpperCase()); }
  querySelectorAll() { return []; }
}
type Pending = { path: '/v1/studio/commands'; body: Record<string, unknown>; sessionId: string; requestId: string };
interface WorkbenchFixture {
  sessions: StudioSession[]; commands: StudioCommand[]; sessionId: string; historySessionId: string; commandId: string;
  ref: InstanceRef | null; propertyBaseline: Baseline | null; sourceBaseline: Baseline | null; historyReady: boolean;
  busy: boolean; pending: Pending | null; refreshing: boolean; online: boolean;
  issuedKey: IssuedStudioKey | null; nativeToken: string; keySecretEpoch: number; nativeSecretEpoch: number;
  confirmation: (() => Promise<void>) | null; keyUnknown: string; workUnknown: string;
  renderSessions(): void; renderControls(): void; selectSession(id: string): void; refresh(): Promise<void>; stop(): void;
  setRef(ref: InstanceRef | null): void; submit(request: Pending): Promise<void>; recover(): Promise<void>;
  reviewRestore(): void;
  refreshWork(): Promise<void>; refreshAssets(): Promise<void>; resetAssetContext(): void; clearChatAssets(): void;
  observeProjectPath(path: unknown, id: unknown): void;
}
const stamp = new Date().toISOString(), projectId = 'b'.repeat(64), projectPath = 'C:/offline-fixture/project';
const scene = (id: string, revokedAt: string | null = null): StudioSession => ({
  id, clientSessionId: 'client-' + id, name: 'Same scene name', placeId: 777, universeId: 888,
  pluginVersion: 'offline-fixture', protocolVersion: 1, allowedRoots: ['Workspace'], allowWrites: true,
  capabilities: ['selection.read', 'scene.inspect', 'scene.update', 'script.read', 'script.update', 'scene.restore'],
  connectedAt: stamp, lastSeenAt: stamp, revokedAt,
});
const receipt = (session: StudioSession, state: StudioCommand['state'] = 'succeeded', id = 'receipt-1'): StudioCommand => ({
  id, requestId: 'request-1', sessionId: session.id, clientSessionId: session.clientSessionId, protocolVersion: 1,
  method: 'selection.read', args: {}, allowedRoots: ['Workspace'], allowWrites: true, leaseEpoch: 1,
  expiresAt: stamp, state, createdAt: stamp, finishedAt: state === 'succeeded' ? stamp : null, result: null, error: null,
});
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(sessions: StudioSession[], commands: StudioCommand[] = [], transport?: typeof fetch) {
  const doc = new DocumentFixture(), requests: { path: string; method: string }[] = [];
  const durableReceipts = new Map(commands.map(command => [command.id, command]));
  const api = new StudioApi('a'.repeat(64), transport ?? (async (path, options) => {
    requests.push({ path: String(path), method: options?.method ?? 'GET' });
    const url = new URL(String(path), 'http://127.0.0.1');
    if (url.pathname === '/v1/studio/sessions') return Response.json({ sessions });
    if (url.pathname === '/v1/product/state') return Response.json({ projectId, projectPath, protocolVersion: 1, studioSessions: sessions, commandCounts: {}, features: [], buildTasks: [] });
    if (url.pathname === '/v1/studio/keys') return Response.json({ keys: [] });
    if (url.pathname === '/v1/studio/commands') { for (const command of commands) durableReceipts.set(command.id, command); return Response.json({ commands }); }
    if (url.pathname.startsWith('/v1/studio/commands/')) return Response.json({ command: durableReceipts.get(url.pathname.split('/').at(-1)!) });
    throw new Error('Unexpected offline fixture request: ' + path);
  }));
  doc.element('method').value = 'selection.read'; doc.element('history-filter').value = 'all';
  const view = new StudioWorkbench(doc as unknown as Document, api, 'http://127.0.0.1:45871', 'a'.repeat(64)) as unknown as WorkbenchFixture;
  // Other product subsystems are outside this controller regression's scope.
  view.refreshWork = async () => {}; view.refreshAssets = async () => {};
  view.resetAssetContext = () => {}; view.clearChatAssets = () => {};
  view.observeProjectPath(projectPath, projectId);
  view.sessions = sessions; view.renderSessions();
  return { view, doc, requests, api, durableReceipts };
}
function select(view: WorkbenchFixture, session: StudioSession) {
  view.sessionId = session.id; view.historySessionId = session.id; view.historyReady = true; view.online = true;
  view.renderSessions(); view.renderControls();
}

test('normal picker/count contain only active exact IDs; complete session records remain unchanged', async () => {
  const revoked = Object.freeze(scene('revoked', stamp)), active = Object.freeze(scene('active'));
  const sessions = Object.freeze([revoked, active]) as unknown as StudioSession[];
  const { view, doc, requests } = fixture(sessions);
  await view.refresh();
  assert.deepEqual(doc.element('session-picker').children.map(option => option.value), ['', active.id]);
  assert.equal(doc.element('session-count').textContent, '1 active');
  assert.doesNotMatch(doc.element('session-picker').children.map(option => option.textContent).join('\n'), /revoked|REVOKED/);
  assert.deepEqual(view.sessions, sessions); assert.equal(view.sessionId, '');
  assert.equal(doc.element('send').disabled, true);
  assert.match(doc.element('product-evidence').children.at(-1)!.children[1]!.textContent, /revoked/);
  assert.ok(requests.every(request => request.method === 'GET'));
});

test('all revoked sessions produce an empty target and zero active count', () => {
  const { view, doc } = fixture([scene('old-a', stamp), scene('old-b', stamp)]);
  view.renderControls();
  assert.deepEqual(doc.element('session-picker').children.map(option => option.value), ['']);
  assert.equal(doc.element('session-count').textContent, '0 active'); assert.equal(view.sessionId, '');
  assert.equal(doc.element('session-mode').textContent, 'No target'); assert.equal(doc.element('send').disabled, true);
});

test('revoking the selected scene clears target, both baselines and secrets while retaining audit and approvals', async () => {
  const selected = scene('old'), replacement = scene('new');
  const commands = [receipt(selected)], { view, doc } = fixture([selected, replacement], commands);
  select(view, selected); view.commands = commands; view.commandId = commands[0]!.id;
  const ref: InstanceRef = { instanceId: 'opaque', sessionId: selected.id, root: 'Workspace', className: 'Script', pathSegments: ['Same name'] };
  view.ref = ref; view.propertyBaseline = { ref, commandId: 'inspect', properties: { Name: 'Same name' } };
  view.sourceBaseline = { ref, commandId: 'read', source: 'private editor source' }; doc.element('source').value = 'private editor source';
  view.issuedKey = { keyId: 'key', apiKey: 'arcane_local_v1_45871_' + 'c'.repeat(64), allowedRoots: ['Workspace'], allowWrites: true, issuedAt: stamp };
  view.nativeToken = 'secret'; view.keyUnknown = 'Issuance outcome unknown'; view.workUnknown = 'Review outcome unknown';
  const confirmation = async () => {}; view.confirmation = confirmation;
  const keyEpoch = view.keySecretEpoch, nativeEpoch = view.nativeSecretEpoch;
  selected.revokedAt = stamp; await view.refresh();
  assert.equal(view.sessionId, ''); assert.equal(view.historySessionId, selected.id); assert.equal(doc.element('session-picker').value, '');
  assert.deepEqual(doc.element('session-picker').children.map(option => option.value), ['', replacement.id]);
  assert.equal(view.ref, null); assert.equal(view.propertyBaseline, null); assert.equal(view.sourceBaseline, null);
  assert.equal(doc.element('source').value, ''); assert.equal(doc.element('expected-source').textContent, 'No baseline captured.');
  assert.equal(view.issuedKey, null); assert.equal(view.nativeToken, ''); assert.ok(view.keySecretEpoch > keyEpoch); assert.ok(view.nativeSecretEpoch > nativeEpoch);
  assert.equal(doc.element('key-secret').textContent, ''); assert.equal(doc.element('native-token-result').hidden, true);
  assert.deepEqual(view.commands, commands); assert.equal(view.commandId, commands[0]!.id); assert.equal(doc.element('receipt-content').hidden, false);
  assert.equal(view.confirmation, confirmation); assert.equal(view.keyUnknown, 'Issuance outcome unknown'); assert.equal(view.workUnknown, 'Review outcome unknown');
  for (const id of ['send', 'inspect-target', 'read-source', 'restore']) assert.equal(doc.element(id).disabled, true, id);
});

test('revoked session recovery remains exact and uncertain receipts keep the target-switch fence', async () => {
  const selected = scene('old'), replacement = scene('new'), commands: StudioCommand[] = [];
  const { view, doc, requests } = fixture([selected, replacement], commands); select(view, selected);
  const pending: Pending = { path: '/v1/studio/commands', sessionId: selected.id, requestId: 'request-1', body: { sessionId: selected.id, requestId: 'request-1' } };
  view.pending = pending; selected.revokedAt = stamp; await view.refresh();
  assert.equal(view.pending, pending); assert.equal(doc.element('unknown-request').hidden, false); assert.match(doc.element('unknown-message').textContent, /old/);
  assert.equal(doc.element('session-picker').disabled, true); assert.equal(view.sessionId, '');
  commands.push(receipt(selected, 'needs_reconciliation')); await view.recover();
  assert.equal(view.pending, null); assert.equal(doc.element('unknown-request').hidden, true);
  assert.equal(doc.element('command-status').textContent, 'Awaiting / uncertain'); assert.equal(doc.element('session-picker').disabled, true);
  view.selectSession(replacement.id); assert.equal(view.sessionId, ''); assert.equal(view.historySessionId, selected.id);
  const uncertain = commands.pop()!; await view.refresh();
  assert.deepEqual(view.commands, [uncertain], 'bounded omission must not imply settlement');
  assert.equal(doc.element('session-picker').disabled, true);
  commands.push({ ...uncertain, state: 'succeeded', finishedAt: stamp }); await view.refresh();
  assert.equal(view.sessionId, ''); assert.equal(doc.element('session-picker').disabled, false);
  assert.ok(requests.filter(request => request.path.startsWith('/v1/studio/commands?')).every(request => request.path.endsWith('sessionId=old')));
  assert.ok(requests.every(request => request.method === 'GET'));
  view.selectSession(replacement.id); assert.equal(view.sessionId, replacement.id); await view.refresh();
});

test('late submitted receipt after revocation is retained without restoring a target', async () => {
  const selected = scene('old'), result = deferred<Response>();
  const { view, doc } = fixture([selected, scene('new')], [], async () => result.promise); select(view, selected);
  const pending: Pending = { path: '/v1/studio/commands', sessionId: selected.id, requestId: 'request-1', body: { sessionId: selected.id, requestId: 'request-1' } };
  const sending = view.submit(pending); assert.equal(view.busy, true);
  selected.revokedAt = stamp; view.renderSessions(); assert.equal(view.busy, true); assert.equal(doc.element('session-picker').disabled, true);
  result.resolve(Response.json({ command: receipt(selected, 'needs_reconciliation') })); await sending;
  assert.equal(view.sessionId, ''); assert.equal(doc.element('session-picker').value, ''); assert.equal(view.commands[0]!.sessionId, selected.id);
  assert.equal(doc.element('receipt-content').hidden, false); assert.equal(doc.element('command-status').textContent, 'Awaiting / uncertain');
  assert.equal(doc.element('session-picker').disabled, true); assert.equal(doc.element('send').disabled, true);
});

test('lost in-flight response after revocation preserves the identical pending request', async () => {
  const selected = scene('old'), result = deferred<Response>();
  const { view, doc } = fixture([selected, scene('new')], [], async () => result.promise); select(view, selected);
  const pending: Pending = { path: '/v1/studio/commands', sessionId: selected.id, requestId: 'request-1', body: { sessionId: selected.id, requestId: 'request-1' } };
  const sending = view.submit(pending); selected.revokedAt = stamp; view.renderSessions();
  result.reject(new StudioRequestError('Offline fixture lost response', 'unknown')); await sending;
  assert.equal(view.pending, pending); assert.equal(view.sessionId, ''); assert.equal(doc.element('unknown-request').hidden, false);
  assert.equal(doc.element('session-picker').disabled, true); assert.equal(doc.element('send').disabled, true);
});

test('same-name/place replacement never inherits the revoked scene selection or baseline', async () => {
  const selected = scene('old'), replacement = { ...scene('new'), clientSessionId: selected.clientSessionId };
  const { view, doc } = fixture([selected, replacement]); select(view, selected);
  selected.revokedAt = stamp; await view.refresh();
  assert.equal(view.sessionId, ''); assert.equal(view.historySessionId, selected.id); assert.equal(doc.element('send').disabled, true);
  view.selectSession(selected.id); assert.equal(view.sessionId, '');
  await view.refresh(); assert.equal(doc.element('session-picker').value, '');
});

test('selection generation rejects a delayed history read after switching away and back', async () => {
  const first = scene('first'), second = scene('second'), history = deferred<Response>();
  const base = fixture([first, second]); const transport = base.api;
  const { view } = fixture([first, second], [], async path => String(path).startsWith('/v1/studio/commands?') ? history.promise : Response.json(await transport.request(String(path))));
  select(view, first); const refreshing = view.refresh();
  view.selectSession(second.id); view.selectSession(first.id);
  history.resolve(Response.json({ commands: [receipt(first)] })); await refreshing;
  assert.equal(view.sessionId, first.id); assert.deepEqual(view.commands, []); assert.equal(view.historyReady, false);
});

test('refresh from an earlier canonical project cannot repopulate current scene records', async () => {
  const old = scene('old'), sessionRead = deferred<Response>();
  const base = fixture([old]);
  const { view, doc } = fixture([], [], async path => String(path) === '/v1/studio/sessions' ? sessionRead.promise : Response.json(await base.api.request(String(path))));
  const refreshing = view.refresh(); view.observeProjectPath('C:/offline-fixture/other', 'd'.repeat(64));
  sessionRead.resolve(Response.json({ sessions: [old] })); await refreshing;
  assert.deepEqual(view.sessions, []); assert.equal(doc.element('session-count').textContent, '0 active');
  assert.equal(doc.element('refresh').disabled, false);
});

test('a previously opened restore approval remains visible but cannot write after its target is revoked', async () => {
  const selected = scene('old'), mutation = receipt(selected);
  const ref: InstanceRef = { instanceId: 'opaque', sessionId: selected.id, root: 'Workspace', className: 'Part', pathSegments: ['Part'] };
  mutation.method = 'scene.update'; mutation.result = { mutation: { kind: 'scene.update', ref: ref as unknown as Json, before: { Name: 'Before' }, after: { Name: 'After' } } };
  const { view, doc, requests } = fixture([selected, scene('new')], [mutation]); select(view, selected);
  view.commands = [mutation]; view.commandId = mutation.id; view.reviewRestore();
  const confirmation = view.confirmation; assert.ok(confirmation); assert.equal(doc.element('confirm-dialog').open, true);
  selected.revokedAt = stamp; await view.refresh();
  assert.equal(view.confirmation, confirmation); assert.equal(doc.element('confirm-dialog').open, true);
  await confirmation(); assert.equal(view.sessionId, ''); assert.ok(requests.every(request => request.method === 'GET'));
});

test('stop generation discards delayed session reads and cannot expose connection secrets', async () => {
  const sessionRead = deferred<Response>(), base = fixture([scene('old')]);
  const { view, doc } = fixture([], [], async path => String(path) === '/v1/studio/sessions' ? sessionRead.promise : Response.json(await base.api.request(String(path))));
  const refreshing = view.refresh(); view.stop(); sessionRead.resolve(Response.json({ sessions: [scene('old')] })); await refreshing;
  assert.deepEqual(view.sessions, []); assert.equal(view.sessionId, ''); assert.equal(doc.element('session-picker').value, '');
  assert.equal(view.issuedKey, null); assert.equal(view.nativeToken, ''); assert.equal(view.refreshing, false);
});

test('canonical project generation rejects stale sessions after switching away and back', async () => {
  const sessionRead = deferred<Response>(), base = fixture([scene('old')]);
  const { view, doc } = fixture([], [], async path => String(path) === '/v1/studio/sessions' ? sessionRead.promise : Response.json(await base.api.request(String(path))));
  const refreshing = view.refresh();
  view.observeProjectPath('C:/offline-fixture/other', 'd'.repeat(64)); view.observeProjectPath(projectPath, projectId);
  sessionRead.resolve(Response.json({ sessions: [scene('old')] })); await refreshing;
  assert.deepEqual(view.sessions, []); assert.equal(doc.element('session-count').textContent, '0 active');
  assert.equal(doc.element('refresh').disabled, false);
});

test('selected uncertain receipt outside bounded history remains recoverable by exact command ID', async () => {
  const selected = scene('old'), uncertain = receipt(selected, 'needs_reconciliation');
  const { view, doc, requests, durableReceipts } = fixture([selected, scene('new')], []); select(view, selected);
  view.commands = [uncertain]; view.commandId = uncertain.id; selected.revokedAt = stamp;
  durableReceipts.set(uncertain.id, { ...uncertain, state: 'failed', error: 'Recorded reconciliation failure', finishedAt: stamp });
  await view.refresh();
  assert.equal(view.sessionId, ''); assert.equal(view.commands.length, 1); assert.equal(view.commands[0]!.state, 'failed');
  assert.equal(doc.element('receipt-state').textContent, 'failed'); assert.equal(doc.element('session-picker').disabled, false);
  assert.ok(requests.some(request => request.path === '/v1/studio/commands/' + uncertain.id));
});

for (const rejected of [false, true]) test('late selected-receipt ' + (rejected ? 'failure' : 'success') + ' cannot affect a new selection', async () => {
  const first = scene('first'), second = scene('second'), detail = deferred<Response>(), started = deferred<void>();
  const base = fixture([first, second]);
  const { view } = fixture([first, second], [], async path => {
    if (String(path) === '/v1/studio/commands/receipt-1') { started.resolve(); return detail.promise; }
    return Response.json(await base.api.request(String(path)));
  });
  select(view, first); view.commandId = 'receipt-1'; const refreshing = view.refresh(); await started.promise;
  view.selectSession(second.id); view.selectSession(first.id);
  if (rejected) detail.reject(new Error('Delayed fixture failure')); else detail.resolve(Response.json({ command: receipt(first) }));
  await refreshing;
  assert.equal(view.sessionId, first.id); assert.deepEqual(view.commands, []); assert.equal(view.historyReady, false); assert.equal(view.online, true);
});
