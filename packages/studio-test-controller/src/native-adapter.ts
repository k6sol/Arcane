import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema, ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bindingSchema, bounded, digest, fail, freeze, identifier, logsSchema, nativeStateSchema, parse,
  proofSchema, sameBinding, systemScheduler, type PairedProofReader, type PairedTestProof, type Scheduler,
  type TestAdapter, type TestBinding, type TestObservation } from './contracts.js';

/** Decode VERIFIED native response formats. This port cannot fill absent place,
 * session or state evidence using window names, selected-tab state, or defaults.
 * It is injected by trusted integration code, never supplied by a test request. */
export interface NativeObservationDecoder {
  inventory(result: CallToolResult): unknown;
  state(result: CallToolResult, requestedStudioId: string): unknown;
  logs(result: CallToolResult): unknown;
}
const inventorySchema = z.array(z.strictObject({ id: identifier, name: z.string().max(512) })).max(64);
const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'title', 'examples', 'default'].includes(key)).map(([key, item]) => [key, strip(item)])) : value;
// Reviewed schemas from the recorded 2026-10-13 inventory, NOT live proof.
export const reviewedTestTools: readonly Tool[] = freeze([
  { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ...['get_studio_state', 'get_console_output'].map(name => ({ name, inputSchema: { type: 'object' as const,
    properties: { studio_id: { type: 'string' } }, required: ['studio_id'] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })),
  { name: 'start_stop_play', inputSchema: { type: 'object', properties: { is_start: { type: 'boolean' }, studio_id: { type: 'string' } },
    required: ['is_start', 'studio_id'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
]);
type Ownership = { runId: string; binding: TestBinding; epoch: number };
export interface NativeTestAdapterOptions {
  client: Client; pairedProof: PairedProofReader; decoder: NativeObservationDecoder;
  evidence: 'fixture' | 'native'; scheduler?: Scheduler; requestTimeoutMs?: number; proofMaxAgeMs?: number;
  onDisconnect?: () => void;
}
/** Own a SEPARATE already-connected vetted SDK client. Does not spawn, pair, open
 * places, install, use input APIs, or widen NativeStudioSession's read surface. */
export class NativeTestAdapter implements TestAdapter {
  readonly evidence: 'fixture' | 'native'; readonly #options: NativeTestAdapterOptions;
  readonly #scheduler: Scheduler; readonly #timeout: number; readonly #freshness: number;
  #tools: readonly Tool[] = []; #generation = 0; #loadedGeneration = -1;
  #requests = 0; #busy = false; #idle: Promise<unknown> = Promise.resolve();
  #owned: Ownership | null = null; #effectUnknown = false; #disconnected = false;
  constructor(options: NativeTestAdapterOptions) {
    this.#options = Object.freeze({ ...options }); this.evidence = options.evidence;
    if (options.evidence === 'native' && options.client.getServerVersion()?.name !== 'RobloxStudio') fail('BAD_NATIVE_RESPONSE');
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#timeout = options.requestTimeoutMs ?? 1000; this.#freshness = options.proofMaxAgeMs ?? 1000;
    for (const value of [this.#timeout, this.#freshness]) if (!Number.isInteger(value) || value < 1 || value > 15_000) fail('INVALID_REQUEST');
    options.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.#generation++; });
    const priorClose = options.client.onclose;
    options.client.onclose = () => { this.#disconnected = true; priorClose?.(); options.onDisconnect?.(); };
  }
  async #exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.#busy) fail('BUSY');
    this.#busy = true;
    const work = Promise.resolve().then(action); this.#idle = work;
    try { return await work; } finally { this.#busy = false; }
  }
  async #request<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disconnected) fail('DISCONNECTED');
    if (++this.#requests > 4096) fail('UNSUPPORTED_TOOL');
    const result = await bounded(this.#scheduler, this.#timeout, signal, action);
    if (Buffer.byteLength(JSON.stringify(result) ?? '') > 256 * 1024) fail('BAD_NATIVE_RESPONSE');
    return result;
  }
  async #loadTools(signal: AbortSignal): Promise<void> {
    if (this.#loadedGeneration === this.#generation) return;
    const generation = this.#generation, names = new Set<string>(), cursors = new Set<string>(), tools: Tool[] = [];
    let cursor: string | undefined, bytes = 0, complete = false;
    for (let page = 0; page < 8; page++) {
      const result = await this.#request(signal, local => this.#options.client.listTools(cursor ? { cursor } : {}, {
        signal: local, timeout: this.#timeout, maxTotalTimeout: this.#timeout, resetTimeoutOnProgress: false,
      }));
      bytes += Buffer.byteLength(JSON.stringify(result)); if (bytes > 256 * 1024) fail('UNSUPPORTED_TOOL');
      for (const raw of result.tools) {
        const tool = parse(ToolSchema, raw, 'UNSUPPORTED_TOOL');
        if (names.has(tool.name) || tools.length >= 128) fail('UNSUPPORTED_TOOL'); names.add(tool.name); tools.push(tool);
      }
      if (!result.nextCursor) { complete = true; break; }
      if (result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) fail('UNSUPPORTED_TOOL');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    if (!complete || generation !== this.#generation) fail('UNSUPPORTED_TOOL');
    for (const baseline of reviewedTestTools) {
      const actual = tools.find(tool => tool.name === baseline.name);
      if (!actual || digest(strip(actual.inputSchema)) !== digest(baseline.inputSchema) ||
          actual.annotations?.readOnlyHint !== baseline.annotations?.readOnlyHint ||
          actual.annotations?.destructiveHint !== false || actual.annotations?.openWorldHint !== false) fail('UNSUPPORTED_TOOL');
    }
    this.#tools = tools; this.#loadedGeneration = generation;
  }
  #assertTool(name: string): void {
    if (this.#generation !== this.#loadedGeneration || !this.#tools.some(tool => tool.name === name)) fail('UNSUPPORTED_TOOL');
  }
  async #call(name: string, args: Record<string, unknown>, signal: AbortSignal, mutation = false): Promise<CallToolResult> {
    this.#assertTool(name);
    const result = await this.#request(signal, local => this.#options.client.callTool({ name, arguments: args }, CallToolResultSchema, {
      ...(mutation ? {} : { signal: local }), timeout: this.#timeout, maxTotalTimeout: this.#timeout, resetTimeoutOnProgress: false,
    }));
    const parsed = parse(CallToolResultSchema, result, 'BAD_NATIVE_RESPONSE');
    if (parsed.isError || parsed.content.some(item => item.type !== 'text')) fail(mutation ? 'EFFECT_UNKNOWN' : 'BAD_NATIVE_RESPONSE');
    return parsed;
  }
  async #proof(binding: TestBinding, signal: AbortSignal, cleanup: boolean): Promise<PairedTestProof> {
    const value = await this.#request(signal, local => this.#options.pairedProof.read(binding, local));
    const proof = parse(proofSchema, value, 'BINDING_CHANGED'), now = this.#scheduler.now();
    if (!sameBinding(proof.binding, binding, cleanup)) fail('BINDING_CHANGED');
    if (proof.observedAt > now || now - proof.observedAt > this.#freshness || proof.expiresAt <= now) fail('STALE_PROOF');
    if (!proof.connected || !proof.continuitySupported) fail('DISCONNECTED');
    if (proof.protectedPlace || (!cleanup && (proof.revoked || !proof.testActionsAllowed))) fail('PLACE_DENIED');
    return proof;
  }
  async #observe(binding: TestBinding, signal: AbortSignal, cleanup: boolean): Promise<TestObservation> {
    parse(bindingSchema, binding); await this.#loadTools(signal);
    const generation = this.#generation, before = await this.#proof(binding, signal, cleanup);
    const inventory = parse(inventorySchema, this.#options.decoder.inventory(await this.#call('list_roblox_studios', {}, signal)), 'BAD_NATIVE_RESPONSE');
    if (new Set(inventory.map(item => item.id)).size !== inventory.length || inventory.filter(item => item.id === binding.nativeStudioId).length !== 1) fail('BINDING_CHANGED');
    const state = parse(nativeStateSchema, this.#options.decoder.state(await this.#call('get_studio_state', { studio_id: binding.nativeStudioId }, signal), binding.nativeStudioId), 'PLACE_DENIED');
    if (state.nativeStudioId !== binding.nativeStudioId) fail('BINDING_CHANGED');
    if (!state.datamodels.includes(state.mode === 'Edit' ? 'Edit' : 'Client') || new Set(state.datamodels).size !== state.datamodels.length) fail('MODE_MISMATCH');
    const logs = parse(logsSchema, this.#options.decoder.logs(await this.#call('get_console_output', { studio_id: binding.nativeStudioId }, signal)), 'BAD_NATIVE_RESPONSE');
    if (new Set(logs.entries.map(log => log.id)).size !== logs.entries.length) fail('BAD_NATIVE_RESPONSE');
    const after = await this.#proof(binding, signal, cleanup);
    if (digest({ ...before, observedAt: 0, expiresAt: 0 }) !== digest({ ...after, observedAt: 0, expiresAt: 0 }) || generation !== this.#generation) fail('BINDING_CHANGED');
    return freeze({ binding: after.binding, mode: state.mode, playEpoch: after.playEpoch,
      observedAt: Math.min(before.observedAt, after.observedAt), expiresAt: Math.min(before.expiresAt, after.expiresAt),
      logs: logs.entries.map(log => ({ idDigest: digest(log.id), digest: digest(log), level: log.level, bytes: Buffer.byteLength(log.message) })),
      logsTruncated: logs.truncated });
  }
  observe(binding: TestBinding, signal: AbortSignal, cleanup = false): Promise<TestObservation> {
    return this.#exclusive(async () => {
      const observation = await this.#observe(binding, signal, cleanup);
      if (this.#owned && (observation.mode !== 'Play' || observation.playEpoch !== this.#owned.epoch || !sameBinding(observation.binding, this.#owned.binding, true))) fail('NOT_OWNED_PLAY');
      return observation;
    });
  }
  start(binding: TestBinding, runId: string, deadline: number, signal: AbortSignal): Promise<void> {
    parse(identifier, runId);
    return this.#exclusive(async () => {
      if (this.#owned || this.#effectUnknown) fail('FENCED');
      const before = await this.#observe(binding, signal, false);
      if (before.mode !== 'Edit') fail('MODE_MISMATCH');
      if (signal.aborted || deadline <= this.#scheduler.now()) fail('CANCELLED');
      this.#assertTool('start_stop_play');
      // After dispatch, caller cancellation does not prove physical cancellation.
      // Keep the whole ACK/postcheck path alive; settle waits for this original work.
      const independent = new AbortController().signal;
      try {
        await this.#call('start_stop_play', { studio_id: binding.nativeStudioId, is_start: true }, independent, true);
        const after = await this.#observe(binding, independent, true);
        if (after.mode !== 'Play' || after.playEpoch !== before.playEpoch + 1 || !sameBinding(after.binding, binding, true)) fail('EFFECT_UNKNOWN');
        this.#owned = freeze({ runId, binding, epoch: after.playEpoch });
      } catch (error) { this.#effectUnknown = true; throw error; }
    });
  }
  stop(binding: TestBinding, runId: string, deadline: number, signal: AbortSignal): Promise<void> {
    parse(identifier, runId);
    return this.#exclusive(async () => {
      if (this.#effectUnknown) fail('EFFECT_UNKNOWN');
      const before = await this.#observe(binding, signal, true), owned = this.#owned;
      if (!owned) { if (before.mode === 'Edit') return; fail('NOT_OWNED_PLAY'); }
      if (owned.runId !== runId || !sameBinding(owned.binding, binding, true) || before.mode !== 'Play' || before.playEpoch !== owned.epoch) fail('NOT_OWNED_PLAY');
      if (signal.aborted || deadline <= this.#scheduler.now()) fail('TIMEOUT');
      this.#assertTool('start_stop_play');
      const independent = new AbortController().signal;
      try {
        await this.#call('start_stop_play', { studio_id: binding.nativeStudioId, is_start: false }, independent, true);
        const after = await this.#observe(binding, independent, true);
        if (after.mode !== 'Edit' || after.playEpoch !== owned.epoch + 1) fail('EFFECT_UNKNOWN');
        this.#owned = null;
      } catch (error) { this.#effectUnknown = true; throw error; }
    });
  }
  async settle(signal: AbortSignal): Promise<boolean> {
    try { await bounded(this.#scheduler, this.#timeout, signal, () => this.#idle.catch(() => {})); }
    catch { return false; }
    return !this.#busy && !this.#effectUnknown;
  }
}
