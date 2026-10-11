import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema, type CallToolResult, type Implementation, type ServerCapabilities, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import type { NativeStudioExecutable } from './discovery.js';
import {
  NativeStudioError, NATIVE_STUDIO_LIMITS, parseReadArguments, sessionLimits, toolPolicy,
  type NativeStudioReadArgs, type NativeStudioReadMethod,
} from './policy.js';

export type NativeStudioProvenance = { kind: 'live'; executable: NativeStudioExecutable } | { kind: 'fixture'; label: string };
export interface NativeStudioInventoryItem { id: string; name: string }
export interface NativeStudioCapability {
  name: string; allowed: boolean; blockedReason: string | null;
  inputSchema: Tool['inputSchema']; annotations?: Tool['annotations'];
}
export interface NativeStudioMetadata {
  connected: boolean; evidenceKind: NativeStudioProvenance['kind']; observedAt: string; sdkVersion: '1.32.1'; transport: 'stdio' | 'in-memory-fixture';
  server: Implementation | undefined; serverCapabilities: ServerCapabilities | undefined;
  provenance: NativeStudioProvenance; tools: NativeStudioCapability[]; requestsUsed: number;
  limits: ReturnType<typeof sessionLimits> & typeof NATIVE_STUDIO_LIMITS;
}
/** Internal transport-injection seam for SDK fixture tests. Public entry point always vets/spawns StudioMCP.exe. */
export class NativeStudioSession {
  readonly #client = new Client({ name: 'arcane-read-only-studio', version: '0.1.0' }, { capabilities: {} });
  readonly #validator = new AjvJsonSchemaValidator();
  readonly #tools = new Map<string, Tool>();
  readonly #inputValidators = new Map<string, JsonSchemaValidator<Record<string, unknown>>>();
  readonly #limits;
  readonly #transport: Transport;
  readonly #provenance: NativeStudioProvenance;
  #requests = 0; #ready = false; #closed = false; #busy = false; #stale = false;
  #observedAt = ''; #closing: Promise<void> | undefined; #active: AbortController | undefined;
  constructor(transport: Transport, provenance: NativeStudioProvenance, limits: { timeoutMs?: number; maxRequests?: number } = {}) {
    this.#limits = sessionLimits(limits); this.#transport = transport; this.#provenance = structuredClone(provenance);
    this.#client.onclose = () => { this.#closed = true; this.#ready = false; };
    this.#client.onerror = () => { void this.close().catch(() => {}); }; // Never surface untrusted stderr/protocol error strings.
    this.#client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.#stale = true; });
  }
  async initialize(): Promise<void> {
    if (this.#ready || this.#closed || this.#busy) throw new NativeStudioError('STUDIO_STATE', 'Studio adapter cannot be initialized again.');
    await this.#exclusive(async () => {
      try {
        await this.#request(options => this.#client.connect(this.#transport, options));
        if (this.#provenance.kind === 'live' && this.#client.getServerVersion()?.name !== 'RobloxStudio')
          throw new NativeStudioError('STUDIO_SERVER', 'The executable did not identify itself as the official Roblox Studio MCP server.');
        await this.#refreshTools(); this.#ready = true;
      } catch (error) { await this.close(); throw error; }
    });
  }
  metadata(): NativeStudioMetadata {
    return structuredClone({
      connected: this.#ready && !this.#closed, evidenceKind: this.#provenance.kind, observedAt: this.#observedAt, sdkVersion: '1.32.1',
      transport: this.#provenance.kind === 'live' ? 'stdio' : 'in-memory-fixture',
      server: this.#client.getServerVersion(), serverCapabilities: this.#client.getServerCapabilities(),
      provenance: this.#provenance, tools: [...this.#tools.values()].map(tool => ({
        name: tool.name, allowed: toolPolicy(tool) === null, blockedReason: toolPolicy(tool),
        inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })), requestsUsed: this.#requests, limits: { ...NATIVE_STUDIO_LIMITS, ...this.#limits },
    });
  }
  async listStudios(): Promise<NativeStudioInventoryItem[]> {
    this.#assertReady();
    return this.#exclusive(async () => { if (this.#stale) await this.#refreshTools(); return this.#listStudios(); });
  }
  async read<K extends NativeStudioReadMethod>(method: K, input: NativeStudioReadArgs[K]): Promise<CallToolResult> {
    // Runtime checks precede all requests, even for JavaScript/untyped callers.
    const args = parseReadArguments(method, input);
    this.#assertReady();
    return this.#exclusive(async () => {
      if (this.#stale) await this.#refreshTools();
      this.#assertTool(method, args);
      if (this.#requests + 2 > this.#limits.maxRequests)
        throw new NativeStudioError('STUDIO_REQUEST_LIMIT', 'Studio adapter request budget exhausted; open a new explicit connection.');
      const inventory = await this.#listStudios();
      if (!inventory.some(studio => studio.id === args.studio_id))
        throw new NativeStudioError('STUDIO_NOT_FOUND', 'The exact requested studio_id is absent from the current Studio inventory. No fallback target was selected.');
      return this.#call(method, args);
    });
  }
  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#ready = false; this.#active?.abort();
    // SDK 1.32.1 stdio close: EOF, 2s grace, SIGTERM, 2s grace, SIGKILL.
    this.#closing = this.#client.close().finally(() => this.#transport.close());
    return this.#closing;
  }
  #assertReady() {
    if (!this.#ready || this.#closed) throw new NativeStudioError('STUDIO_CLOSED', 'Studio adapter is not connected. Establish a new explicit connection.');
  }
  async #exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new NativeStudioError('STUDIO_BUSY', 'Only one Studio adapter operation may be in flight.');
    this.#busy = true;
    try { return await action(); } finally { this.#busy = false; }
  }
  async #request<T>(operation: (options: RequestOptions) => Promise<T>): Promise<T> {
    if (this.#closed) throw new NativeStudioError('STUDIO_CLOSED', 'Studio adapter is closed.');
    if (this.#requests >= this.#limits.maxRequests)
      throw new NativeStudioError('STUDIO_REQUEST_LIMIT', 'Studio adapter request budget exhausted.');
    this.#requests++;
    const controller = new AbortController(); this.#active = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new NativeStudioError('STUDIO_TIMEOUT', 'Studio MCP request timed out. The connection is closed; no request was retried.'));
        controller.abort();
      }, this.#limits.timeoutMs);
    });
    try {
      const result = await Promise.race([operation({
        timeout: this.#limits.timeoutMs, maxTotalTimeout: this.#limits.timeoutMs,
        resetTimeoutOnProgress: false, signal: controller.signal,
      }), deadline]);
      if (result !== undefined && Buffer.byteLength(JSON.stringify(result), 'utf8') > NATIVE_STUDIO_LIMITS.resultBytes)
        throw new NativeStudioError('STUDIO_PAYLOAD_LIMIT', 'Studio MCP response exceeded the byte limit.');
      return result;
    } catch (error) {
      await this.close();
      if (error instanceof NativeStudioError) throw error;
      throw new NativeStudioError('STUDIO_REQUEST_FAILED', 'Studio MCP request failed and the connection was closed. No request was retried.');
    } finally { if (timer) clearTimeout(timer); this.#active = undefined; }
  }
  async #refreshTools() {
    try { await this.#loadTools(); }
    catch (error) { await this.close(); throw error; }
  }
  async #loadTools() {
    const tools = new Map<string, Tool>(); const cursors = new Set<string>();
    let cursor: string | undefined; let complete = false; let inventoryBytes = 0;
    for (let page = 0; page < NATIVE_STUDIO_LIMITS.toolPages; page++) {
      const result = await this.#request(options => this.#client.listTools(cursor ? { cursor } : {}, options));
      inventoryBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (inventoryBytes > NATIVE_STUDIO_LIMITS.capabilityBytes)
        throw new NativeStudioError('STUDIO_CAPABILITY_LIMIT', 'Studio capability inventory exceeded its combined byte limit.');
      for (const tool of result.tools) {
        if (tools.has(tool.name) || tools.size >= NATIVE_STUDIO_LIMITS.tools || !/^[a-z0-9_]{1,100}$/.test(tool.name))
          throw new NativeStudioError('STUDIO_CAPABILITY_LIMIT', 'Studio tool inventory is duplicate, malformed or exceeds its bound.');
        tools.set(tool.name, structuredClone(tool));
      }
      if (!result.nextCursor) { complete = true; break; }
      if (result.nextCursor.length > 1024 || cursors.has(result.nextCursor))
        throw new NativeStudioError('STUDIO_CAPABILITY_LIMIT', 'Studio tool inventory pagination is invalid.');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    if (!complete) throw new NativeStudioError('STUDIO_CAPABILITY_LIMIT', 'Studio tool inventory exceeded the page limit.');
    this.#tools.clear(); this.#inputValidators.clear();
    for (const [name, tool] of tools) {
      this.#tools.set(name, tool);
      if (toolPolicy(tool) === null) {
        try { this.#inputValidators.set(name, this.#validator.getValidator(tool.inputSchema as unknown as JsonSchemaType)); }
        catch { throw new NativeStudioError('STUDIO_CAPABILITY_SCHEMA', 'An allowlisted runtime input schema could not be validated.'); }
      }
    }
    this.#observedAt = new Date().toISOString(); this.#stale = false;
  }
  #assertTool(name: string, args: Record<string, unknown>) {
    const tool = this.#tools.get(name), validate = this.#inputValidators.get(name);
    if (!tool || toolPolicy(tool) !== null || !validate)
      throw new NativeStudioError('STUDIO_CAPABILITY_UNAVAILABLE', 'This allowlisted read is unavailable or incompatible in the actual runtime tool inventory.');
    if (!validate(args).valid)
      throw new NativeStudioError('STUDIO_CAPABILITY_SCHEMA', 'Read arguments do not match the actual Studio runtime schema.');
  }
  async #call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.#assertTool(name, args);
    const raw = await this.#request(options => this.#client.callTool({ name, arguments: args }, CallToolResultSchema, options));
    const parsed = CallToolResultSchema.safeParse(raw);
    if (!parsed.success) throw new NativeStudioError('STUDIO_RESPONSE', 'Studio read returned an unsupported response shape.');
    const result = parsed.data;
    if (result.content.some(item => item.type !== 'text'))
      throw new NativeStudioError('STUDIO_RESPONSE', 'An allowlisted Studio read returned unsupported non-text content.');
    if (name === 'script_read' && Buffer.byteLength(JSON.stringify(result), 'utf8') > NATIVE_STUDIO_LIMITS.sourceBytes)
      throw new NativeStudioError('STUDIO_SOURCE_LIMIT', 'Script read exceeded the 100 KiB source response limit; request a smaller line range.');
    return result;
  }
  async #listStudios(): Promise<NativeStudioInventoryItem[]> {
    const result = await this.#call('list_roblox_studios', {});
    if (result.isError || result.content.length !== 1 || result.content[0]?.type !== 'text')
      throw new NativeStudioError('STUDIO_INVENTORY', 'Studio inventory did not return one successful text response.');
    let data: unknown;
    try { data = JSON.parse(result.content[0].text); }
    catch { throw new NativeStudioError('STUDIO_INVENTORY', 'Studio inventory returned invalid JSON.'); }
    const items = (data as { studios?: unknown } | null)?.studios;
    if (!Array.isArray(items) || items.length > NATIVE_STUDIO_LIMITS.studios)
      throw new NativeStudioError('STUDIO_INVENTORY', 'Studio inventory is malformed or exceeds its bound.');
    const ids = new Set<string>();
    return items.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new NativeStudioError('STUDIO_INVENTORY', 'Studio inventory item is malformed.');
      const { id, name } = item as Record<string, unknown>;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof name !== 'string' || name.length > 512 || ids.has(id))
        throw new NativeStudioError('STUDIO_INVENTORY', 'Studio inventory identity is malformed or duplicated.');
      ids.add(id); return { id, name };
    });
  }
}
