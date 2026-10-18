/**
 * Upstream model streaming with SERVER-SIDE keys. Each adapter turns the provider's event stream into
 * `delta` text chunks and a final `usage` report. Keys never leave this process and are never logged.
 */
import type { GatewayConfig, ModelEntry } from './config.ts';

export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string }
export type UpstreamEvent = { type: 'delta'; text: string } | { type: 'usage'; inputTokens?: number; outputTokens?: number };
export class UpstreamError extends Error {}

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

async function* anthropic(config: GatewayConfig, model: ModelEntry, messages: ChatMessage[], maxTokens: number, signal: AbortSignal, doFetch: typeof fetch): AsyncGenerator<UpstreamEvent> {
  if (!config.providers.anthropicKey) throw new UpstreamError('This model is not configured on the gateway.');
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const body = { model: model.upstream, max_tokens: maxTokens, stream: true, ...(system ? { system } : {}),
    messages: messages.filter(message => message.role !== 'system').map(message => ({ role: message.role, content: message.content })) };
  const stream = await open(doFetch, config.providers.anthropicBase + '/v1/messages', { 'x-api-key': config.providers.anthropicKey, 'anthropic-version': '2023-06-01' }, body, signal);
  for await (const data of sseData(stream)) {
    let event: Record<string, any>; try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'message_start') yield { type: 'usage', inputTokens: count(event.message?.usage?.input_tokens), outputTokens: count(event.message?.usage?.output_tokens) };
    else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') yield { type: 'delta', text: event.delta.text };
    else if (event.type === 'message_delta') yield { type: 'usage', outputTokens: count(event.usage?.output_tokens) };
    else if (event.type === 'error') throw new UpstreamError('The model stopped with an error.');
    else if (event.type === 'message_stop') return;
  }
}

async function* openai(config: GatewayConfig, model: ModelEntry, messages: ChatMessage[], maxTokens: number, signal: AbortSignal, doFetch: typeof fetch): AsyncGenerator<UpstreamEvent> {
  if (!config.providers.openaiKey) throw new UpstreamError('This model is not configured on the gateway.');
  const body = { model: model.upstream, stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxTokens,
    messages: messages.map(message => ({ role: message.role, content: message.content })) };
  const stream = await open(doFetch, config.providers.openaiBase + '/v1/chat/completions', { Authorization: 'Bearer ' + config.providers.openaiKey }, body, signal);
  for await (const data of sseData(stream)) {
    if (data === '[DONE]') return;
    let event: Record<string, any>; try { event = JSON.parse(data); } catch { continue; }
    if (event.error) throw new UpstreamError('The model stopped with an error.');
    const text = event.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) yield { type: 'delta', text };
    if (event.usage) yield { type: 'usage', inputTokens: count(event.usage.prompt_tokens), outputTokens: count(event.usage.completion_tokens) };
  }
}

/** Development-only echo model (refused in production by config validation). */
async function* mock(_config: GatewayConfig, _model: ModelEntry, messages: ChatMessage[]): AsyncGenerator<UpstreamEvent> {
  const last = messages.at(-1)?.content ?? '';
  yield { type: 'usage', inputTokens: Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4) };
  for (const word of ('Echo: ' + last).split(/(?<= )/)) yield { type: 'delta', text: word };
  yield { type: 'usage', outputTokens: Math.ceil((last.length + 6) / 4) };
}

export type UpstreamStreamer = (config: GatewayConfig, model: ModelEntry, messages: ChatMessage[], maxTokens: number, signal: AbortSignal) => AsyncGenerator<UpstreamEvent>;

export function createUpstream(doFetch: typeof fetch = globalThis.fetch): UpstreamStreamer {
  return (config, model, messages, maxTokens, signal) =>
    model.provider === 'anthropic' ? anthropic(config, model, messages, maxTokens, signal, doFetch)
      : model.provider === 'openai' ? openai(config, model, messages, maxTokens, signal, doFetch)
      : mock(config, model, messages);
}
