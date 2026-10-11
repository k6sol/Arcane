import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnNative, type ProcessSpec } from './process.js';
import { ArcaneError, object } from '../../protocol/src/providers.js';

const READ_METHODS = new Set(['initialize', 'account/read', 'model/list']);
interface Pending { resolve(value: unknown): void; reject(error: ArcaneError): void; timer: NodeJS.Timeout }
export class ReadonlyCodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private total = 0;
  private closed = false;
  constructor(spec: ProcessSpec, private timeoutMs = 8000, private maxLineBytes = 1048576) {
    this.child = spawnNative(spec);
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    this.child.stderr.on('data', (data: Buffer) => {
      this.total += data.length;
      if (this.total > 16777216) this.close(new ArcaneError('RPC_LIMIT', 'Native RPC output exceeded its bound.'));
    });
    this.child.stdin.on('error', () => this.close(new ArcaneError('RPC_IO', 'Native RPC input closed.')));
    this.child.on('error', () => this.close(new ArcaneError('RPC_START', 'Native RPC could not start.')));
    this.child.on('close', () => this.close(new ArcaneError('RPC_CLOSED', 'Native RPC disconnected.')));
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'arcane', title: 'Arcane', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    this.write({ method: 'initialized' });
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (!READ_METHODS.has(method)) return Promise.reject(new ArcaneError('READ_ONLY', 'This connector cannot run turns, tools, login or configuration writes.'));
    if (method === 'account/read' && object(params).refreshToken !== false) return Promise.reject(new ArcaneError('READ_ONLY', 'Authentication probes do not refresh credentials.'));
    if (this.closed) return Promise.reject(new ArcaneError('RPC_CLOSED', 'Native RPC is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new ArcaneError('RPC_TIMEOUT', 'Native RPC probe timed out.')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { this.close(new ArcaneError('RPC_IO', 'Native RPC input failed.')); }
    });
  }
  private write(value: unknown): void {
    if (this.closed) throw new ArcaneError('RPC_CLOSED', 'Native RPC is closed.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private receive(data: Buffer): void {
    if (this.closed) return;
    this.total += data.length;
    if (this.total > 16777216) return this.close(new ArcaneError('RPC_LIMIT', 'Native RPC output exceeded its bound.'));
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > this.maxLineBytes) return this.close(new ArcaneError('RPC_LIMIT', 'Native RPC frame exceeded its bound.'));
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      try { this.message(object(JSON.parse(line))); }
      catch { return this.close(new ArcaneError('RPC_PROTOCOL', 'Native RPC returned an invalid frame.')); }
    }
    if (this.buffer.length > this.maxLineBytes) this.close(new ArcaneError('RPC_LIMIT', 'Native RPC frame exceeded its bound.'));
  }
  private message(message: Record<string, unknown>): void {
    // Refuse all provider-initiated actions, even if a future CLI asks for approval.
    if (typeof message.method === 'string' && message.id !== undefined) {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported by read-only Arcane discovery.' } }); return;
    }
    if (typeof message.id !== 'number') return; // notifications never imply completion
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new ArcaneError('RPC_REMOTE', 'Native CLI rejected the discovery request.'));
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(new ArcaneError('RPC_PROTOCOL', 'Native RPC response is incomplete.'));
  }
  close(reason = new ArcaneError('RPC_CLOSED', 'Native RPC closed.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
    this.pending.clear();
    this.child.stdin.end(); this.child.kill();
  }
}

