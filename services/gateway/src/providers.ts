/**
 * Upstream model streaming with SERVER-SIDE keys. Each adapter turns the provider's event stream into
 * `delta` text chunks, finished `tool_call`s, a `stop` reason and `usage` reports. Keys never leave this process and are
 * never logged.
 *
 * Function calling uses ONE provider-neutral shape on the wire to Arcane (tools: {name, description, inputSchema};
 * assistant messages may carry toolCalls: {id, name, arguments}; role 'tool' messages answer one call by toolCallId).
 * Each adapter translates it to and from the provider's own function-calling format. The gateway never runs a tool.
 */
import type { GatewayConfig, ModelEntry } from './config.ts';

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'; content: string;
  /** Assistant only: the function calls this assistant turn made. */
  toolCalls?: ToolCall[];
  /** Tool only: the call this result answers, and whether the tool failed. */
  toolCallId?: string; isError?: boolean;
}
export type StopReason = 'end' | 'tool_use' | 'max_tokens';
export type UpstreamEvent = { type: 'delta'; text: string } | { type: 'usage'; inputTokens?: number; outputTokens?: number } |
  { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> } | { type: 'stop'; reason: StopReason };
export class UpstreamError extends Error {}
/** Streamed function-call arguments are bounded before parsing. */
const MAX_TOOL_JSON = 256 * 1024;
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/, TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
function toolArguments(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  let value: unknown; try { value = JSON.parse(json); } catch { throw new UpstreamError('The model sent unreadable tool arguments.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpstreamError('The model sent unreadable tool arguments.');
  return value as Record<string, unknown>;
}
function finishedCall(id: unknown, name: unknown, json: string): UpstreamEvent {
  if (typeof id !== 'string' || !TOOL_CALL_ID.test(id) || typeof name !== 'string' || !TOOL_NAME.test(name)) throw new UpstreamError('The model sent an unreadable tool call.');
  return { type: 'tool_call', id, name, arguments: toolArguments(json) };
}

const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;

/** Parses a Server-Sent Events body into `data:` payload strings. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength; if (bytes > MAX_UPSTREAM_BYTES) throw new UpstreamError('Upstream stream too large.');
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;

async function open(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const response = await doFetch(url, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers }, body: JSON.stringify(body) });
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new UpstreamError('Upstream model request failed (' + response.status + ').'); }
  return response.body;
}

/** Neutral messages in the Messages API shape: tool calls are tool_use blocks, consecutive tool results share one user turn. */
export function anthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: { role: string; content: string | Record<string, unknown>[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) };
      const last = out.at(-1);
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every(item => item.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({ role: 'assistant', content: [...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))] });
    } else out.push({ role: message.role, content: message.content });
  }
  return out;
}

async function* anthropic(config: GatewayConfig, model: ModelEntry, messages: ChatMessage[], maxTokens: number, signal: AbortSignal, doFetch: typeof fetch, tools: ToolSpec[]): AsyncGenerator<UpstreamEvent> {
  if (!config.providers.anthropicKey) throw new UpstreamError('This model is not configured on the gateway.');
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const body = { model: model.upstream, max_tokens: maxTokens, stream: true, ...(system ? { system } : {}), messages: anthropicMessages(messages),
    ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}) };
  const stream = await open(doFetch, config.providers.anthropicBase + '/v1/messages', { 'x-api-key': config.providers.anthropicKey, 'anthropic-version': '2023-06-01' }, body, signal);
  const blocks = new Map<number, { id: unknown; name: unknown; json: string }>();
  for await (const data of sseData(stream)) {
    let event: Record<string, any>; try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'message_start') yield { type: 'usage', inputTokens: count(event.message?.usage?.input_tokens), outputTokens: count(event.message?.usage?.output_tokens) };
    else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && Number.isSafeInteger(event.index) && blocks.size < 64)
      blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
    else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') yield { type: 'delta', text: event.delta.text };
    else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
      const block = blocks.get(event.index); if (!block) continue;
      block.json += event.delta.partial_json; if (block.json.length > MAX_TOOL_JSON) throw new UpstreamError('The model sent oversized tool arguments.');
    } else if (event.type === 'content_block_stop' && blocks.has(event.index)) {
      const block = blocks.get(event.index)!; blocks.delete(event.index);
      yield finishedCall(block.id, block.name, block.json);
    } else if (event.type === 'message_delta') {
      yield { type: 'usage', outputTokens: count(event.usage?.output_tokens) };
      const reason = event.delta?.stop_reason;
      if (typeof reason === 'string') yield { type: 'stop', reason: reason === 'tool_use' ? 'tool_use' : reason === 'max_tokens' ? 'max_tokens' : 'end' };
    }
    else if (event.type === 'error') throw new UpstreamError('The model stopped with an error.');
    else if (event.type === 'message_stop') return;
  }
}

/** Neutral messages in the Chat Completions shape: tool calls are function tool_calls, results are role 'tool'. */
export function openaiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map(message => message.role === 'tool' ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    : message.role === 'assistant' && message.toolCalls?.length ? { role: 'assistant', content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
    : { role: message.role, content: message.content });
}

async function* openai(config: GatewayConfig, model: ModelEntry, messages: ChatMessage[], maxTokens: number, signal: AbortSignal, doFetch: typeof fetch, tools: ToolSpec[]): AsyncGenerator<UpstreamEvent> {
  if (!config.providers.openaiKey) throw new UpstreamError('This model is not configured on the gateway.');
  const body = { model: model.upstream, stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxTokens, messages: openaiMessages(messages),
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) };
  const stream = await open(doFetch, config.providers.openaiBase + '/v1/chat/completions', { Authorization: 'Bearer ' + config.providers.openaiKey }, body, signal);
  const calls = new Map<number, { id: unknown; name: unknown; json: string }>();
  const flush = function* (): Generator<UpstreamEvent> {
    for (const index of [...calls.keys()].sort((a, b) => a - b)) { const call = calls.get(index)!; yield finishedCall(call.id, call.name, call.json); }
    calls.clear();
  };
  for await (const data of sseData(stream)) {
    if (data === '[DONE]') { yield* flush(); return; }
    let event: Record<string, any>; try { event = JSON.parse(data); } catch { continue; }
    if (event.error) throw new UpstreamError('The model stopped with an error.');
    const choice = event.choices?.[0], text = choice?.delta?.content;
    if (typeof text === 'string' && text) yield { type: 'delta', text };
    if (Array.isArray(choice?.delta?.tool_calls)) for (const part of choice.delta.tool_calls.slice(0, 64)) {
      if (!Number.isSafeInteger(part?.index)) continue;
      const call = calls.get(part.index) ?? (calls.size < 64 ? { id: undefined, name: undefined, json: '' } : null); if (!call) continue;
      if (typeof part.id === 'string') call.id = part.id;
      if (typeof part.function?.name === 'string') call.name = part.function.name;
      if (typeof part.function?.arguments === 'string') { call.json += part.function.arguments; if (call.json.length > MAX_TOOL_JSON) throw new UpstreamError('The model sent oversized tool arguments.'); }
      calls.set(part.index, call);
    }
    if (typeof choice?.finish_reason === 'string') {
      yield* flush();
      yield { type: 'stop', reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end' };
    }
    if (event.usage) yield { type: 'usage', inputTokens: count(event.usage.prompt_tokens), outputTokens: count(event.usage.completion_tokens) };
  }
}

/**
 * Development-only echo model (refused in production by config validation). With tools offered, a user message
 * `/tool <name> {json}` asks for that tool once, and a tool result is echoed back, so the desktop loop can be tried locally.
 */
async function* mock(_config: GatewayConfig, _model: ModelEntry, messages: ChatMessage[], tools: ToolSpec[] = []): AsyncGenerator<UpstreamEvent> {
  const lastMessage = messages.at(-1), last = lastMessage?.content ?? '';
  const asked = lastMessage?.role === 'user' ? /^\/tool ([A-Za-z0-9_-]{1,64})(?:\s+(\{[\s\S]*\}))?\s*$/.exec(last) : null;
  if (asked && tools.some(tool => tool.name === asked[1])) {
    yield { type: 'usage', inputTokens: Math.ceil(last.length / 4) + 8 };
    yield finishedCall('mock_call_' + messages.length, asked[1], asked[2] ?? '');
    yield { type: 'usage', outputTokens: 8 }; yield { type: 'stop', reason: 'tool_use' };
    return;
  }
  yield { type: 'usage', inputTokens: Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4) };
  for (const word of ('Echo: ' + last).split(/(?<= )/)) yield { type: 'delta', text: word };
  yield { type: 'usage', outputTokens: Math.ceil((last.length + 6) / 4) };
}

export type UpstreamStreamer = (config: GatewayConfig, model: ModelEntry, messages: ChatMessage[], maxTokens: number, signal: AbortSignal, tools?: ToolSpec[]) => AsyncGenerator<UpstreamEvent>;

export function createUpstream(doFetch: typeof fetch = globalThis.fetch): UpstreamStreamer {
  return (config, model, messages, maxTokens, signal, tools = []) =>
    model.provider === 'anthropic' ? anthropic(config, model, messages, maxTokens, signal, doFetch, tools)
      : model.provider === 'openai' ? openai(config, model, messages, maxTokens, signal, doFetch, tools)
      : mock(config, model, messages, tools);
}
