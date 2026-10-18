import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpstream, UpstreamError, type UpstreamEvent } from '../src/providers.ts';
import { testConfig } from './helpers.ts';

const sse = (events: unknown[], raw: string[] = []) => new Response(new ReadableStream({
  start(controller) {
    // Split across chunk boundaries on purpose.
    const text = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + raw.join('');
    for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7)));
    controller.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

async function collect(stream: AsyncGenerator<UpstreamEvent>) { const out: UpstreamEvent[] = []; for await (const event of stream) out.push(event); return out; }

test('anthropic-style adapter uses the server key and maps text deltas and usage (mocked stream)', async () => {
  const config = testConfig({ ANTHROPIC_API_KEY: 'server-side-key-a' });
  const calls: { url: string; init: RequestInit }[] = [];
  const upstream = createUpstream((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]);
  }) as unknown as typeof fetch);
  const model = { ...config.models[0], provider: 'anthropic' as const, upstream: 'upstream-a' };
  const out = await collect(upstream(config, model, [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Hello' }], 64, AbortSignal.timeout(5000)));
  assert.equal(out.filter(e => e.type === 'delta').map(e => (e as any).text).join(''), 'Hi there');
  assert.deepEqual(out.filter(e => e.type === 'usage'), [{ type: 'usage', inputTokens: 42, outputTokens: 1 }, { type: 'usage', outputTokens: 7 }]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'server-side-key-a');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.system, 'Be brief'); assert.equal(body.max_tokens, 64); assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
  assert.equal(calls[0].init.redirect, 'error');
});

test('openai-style adapter maps chunks, usage and [DONE] (mocked stream)', async () => {
  const config = testConfig({ OPENAI_API_KEY: 'server-side-key-b' });
  let seen: RequestInit | null = null;
  const upstream = createUpstream((async (_url: string, init: RequestInit) => {
    seen = init;
    return sse([{ choices: [{ delta: { content: 'One' } }] }, { choices: [{ delta: { content: ' two' } }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }], ['data: [DONE]\n\n']);
  }) as unknown as typeof fetch);
  const out = await collect(upstream(config, config.models[1], [{ role: 'user', content: 'Count' }], 32, AbortSignal.timeout(5000)));
  assert.deepEqual(out, [{ type: 'delta', text: 'One' }, { type: 'delta', text: ' two' }, { type: 'usage', inputTokens: 9, outputTokens: 3 }]);
  assert.equal((seen!.headers as Record<string, string>).Authorization, 'Bearer server-side-key-b');
});

test('missing server key or upstream error status fails closed', async () => {
  const config = testConfig();
  const upstream = createUpstream((async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
  await assert.rejects(collect(upstream(config, config.models[1], [{ role: 'user', content: 'x' }], 8, AbortSignal.timeout(5000))), UpstreamError);
  const keyed = testConfig({ OPENAI_API_KEY: 'k' });
  await assert.rejects(collect(upstream(keyed, keyed.models[1], [{ role: 'user', content: 'x' }], 8, AbortSignal.timeout(5000))), /failed \(500\)/);
});
