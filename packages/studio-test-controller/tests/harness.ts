import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createStudioTestControl, NativeTestAdapter, reviewedTestTools, TestLedger,
  type PairedTestProof, type Scheduler, type TestBinding, type TestProposal } from '../src/index.js';

export class ManualScheduler implements Scheduler {
  #now = 10_000; #next = 0; readonly #timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.#now; }
  schedule(ms: number, callback: () => void): () => void {
    const id = ++this.#next; this.#timers.set(id, { at: this.#now + ms, callback }); return () => { this.#timers.delete(id); };
  }
  advance(ms: number): void {
    this.#now += ms;
    for (const [id, timer] of [...this.#timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])) {
      if (timer.at <= this.#now && this.#timers.delete(id)) timer.callback();
    }
  }
  pending(): number { return this.#timers.size; }
}
export const BINDING: TestBinding = {
  nativeStudioId: 'exact-studio-A', pairedSessionId: 'paired-A', clientLifetimeId: 'plugin-load-A',
  pluginArtifactHash: 'a'.repeat(64), scopeRevision: 'b'.repeat(64), placeId: 0,
};
export const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const decoded = (value: CallToolResult) => {
  assert.equal(value.content.length, 1); const text = value.content[0]; assert.equal(text?.type, 'text');
  if (text?.type !== 'text') throw new Error('fixture text'); return JSON.parse(text.text) as unknown;
};
export async function pumpUntil(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error('Fixture did not reach expected state');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
export async function fixture(options: {
  scheduler?: Scheduler; controllerTimeout?: number; adapterTimeout?: number; durationMs?: number;
  proof?: (proof: PairedTestProof, count: number) => unknown;
  beforeTool?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult | undefined>;
  pages?: (cursor: string | undefined) => { tools: Tool[]; nextCursor?: string };
} = {}) {
  const scheduler = options.scheduler ?? new ManualScheduler();
  const root = await mkdtemp(join(tmpdir(), 'arcane-studio-controller-'));
  const ledger = await TestLedger.open(join(root, 'host-ledger'), root);
  const state = {
    binding: { ...BINDING }, mode: 'Edit' as 'Edit' | 'Play', epoch: 20, placeId: 0,
    connected: true, revoked: false, protectedPlace: false, testActionsAllowed: true, continuitySupported: true,
    inventory: [{ id: 'other-studio-B', name: 'same untrusted name' }, { id: BINDING.nativeStudioId, name: 'same untrusted name' }],
    logs: [] as { id: string; level: 'info' | 'warning' | 'error'; message: string }[], truncated: false,
    tools: structuredClone(reviewedTestTools) as Tool[], proofs: 0, lists: 0,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-test-controller', version: 'fixture-only' }, { capabilities: {} });
  const server = new Server({ name: 'fixture-not-RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: { listChanged: true } } });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    state.lists++; return options.pages ? options.pages(request.params?.cursor) : { tools: state.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name } = request.params, args = request.params.arguments ?? {};
    calls.push({ name, args });
    const custom = await options.beforeTool?.(name, args); if (custom) return custom;
    if (name === 'list_roblox_studios') return result(state.inventory);
    assert.equal(args.studio_id, BINDING.nativeStudioId);
    if (name === 'get_studio_state') return result({ nativeStudioId: BINDING.nativeStudioId, placeId: state.placeId,
      mode: state.mode, datamodels: state.mode === 'Edit' ? ['Edit'] : ['Client', 'Server'] });
    if (name === 'get_console_output') return result({ entries: state.logs, truncated: state.truncated });
    if (name === 'start_stop_play') { state.mode = args.is_start ? 'Play' : 'Edit'; state.epoch++; return result({ accepted: true }); }
    assert.fail('No arbitrary native tool is reachable');
  });
  await server.connect(serverTransport); await client.connect(clientTransport);
  let lifecycle: { onDisconnect(): void } | undefined;
  const adapter = new NativeTestAdapter({ client, scheduler, evidence: 'fixture',
    requestTimeoutMs: options.adapterTimeout ?? 250, proofMaxAgeMs: 1000,
    pairedProof: { async read() {
      const proof: PairedTestProof = { binding: state.binding, observedAt: scheduler.now(), expiresAt: scheduler.now() + 1000,
        connected: state.connected, revoked: state.revoked, protectedPlace: state.protectedPlace,
        testActionsAllowed: state.testActionsAllowed, continuitySupported: state.continuitySupported, playEpoch: state.epoch };
      return options.proof ? options.proof(proof, ++state.proofs) : structuredClone(proof);
    } },
    decoder: { inventory: decoded, state: decoded, logs: decoded }, onDisconnect: () => lifecycle?.onDisconnect(),
  });
  const trustedHuman = Symbol('TEST FIXTURE ONLY: authenticated human control audience');
  const confirmations: string[] = [], statuses: ReturnType<typeof control.requests.status>[] = [];
  const control = createStudioTestControl({ adapter, ledger, scheduler, requestTimeoutMs: options.controllerTimeout ?? 500,
    cleanupGraceMs: 1000, proofMaxAgeMs: 1000,
    humanVerifier: { async confirm(context, display, digest) {
      assert.ok(Object.isFrozen(display)); confirmations.push(digest); return context === trustedHuman;
    } }, onStatus: status => { statuses.push(status); } });
  lifecycle = control.lifecycle;
  const proposal: TestProposal = { binding: BINDING, durationMs: options.durationMs ?? 500, observationIntervalMs: 100, failOnRuntimeError: true };
  const approve = async (input: unknown = proposal) => {
    const prepared = await control.requests.prepare(input);
    const consentId = await control.humanControl.confirm(prepared.proposalId, trustedHuman);
    return { ...prepared, consentId };
  };
  const launch = async () => {
    const approved = await approve(); const status = await control.requests.start({ proposalId: approved.proposalId, consentId: approved.consentId });
    assert.ok(status.runId); return status.runId;
  };
  const effects = () => calls.filter(call => call.name === 'start_stop_play');
  const close = async () => {
    await control.lifecycle.shutdown(); await ledger.close(); await client.close(); await server.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('arcane-studio-controller-'));
    await rm(root, { recursive: true, force: true });
  };
  return { root, ledger, scheduler, state, calls, server, client, adapter, control, trustedHuman, confirmations, statuses, proposal, approve, launch, effects, close };
}
