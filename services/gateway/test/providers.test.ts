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

test('anthropic-style adapter translates tools, tool turns and streamed tool_use blocks', async () => {
  const config = testConfig({ ANTHROPIC_API_KEY: 'server-side-key-a' });
  let body: any = null;
  const upstream = createUpstream((async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'scene_read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Workspace"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]);
  }) as unknown as typeof fetch);
  const model = { ...config.models[0], provider: 'anthropic' as const, upstream: 'upstream-a' };
  const tools = [{ name: 'scene_read', description: 'Read.', inputSchema: { type: 'object' } }];
  const out = await collect(upstream(config, model, [{ role: 'user', content: 'Go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_00', name: 'scene_read', arguments: {} }] },
    { role: 'tool', toolCallId: 'toolu_00', content: 'first', isError: true }, { role: 'tool', toolCallId: 'toolu_00b', content: 'second' }], 64, AbortSignal.timeout(5000), tools));
  assert.deepEqual(body.tools, [{ name: 'scene_read', description: 'Read.', input_schema: { type: 'object' } }]);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_00', name: 'scene_read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_00', content: 'first', is_error: true }, { type: 'tool_result', tool_use_id: 'toolu_00b', content: 'second' }] }]);
  assert.deepEqual(out.filter(e => e.type === 'tool_call' || e.type === 'stop'), [{ type: 'tool_call', id: 'toolu_01', name: 'scene_read', arguments: { path: 'Workspace' } }, { type: 'stop', reason: 'tool_use' }]);
});

test('openai-style adapter translates tools and accumulates streamed function calls', async () => {
  const config = testConfig({ OPENAI_API_KEY: 'server-side-key-b' });
  let body: any = null;
  const upstream = createUpstream((async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'scene_read', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"Lighting"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } }], ['data: [DONE]\n\n']);
  }) as unknown as typeof fetch);
  const tools = [{ name: 'scene_read', description: 'Read.', inputSchema: { type: 'object' } }];
  const out = await collect(upstream(config, config.models[1], [{ role: 'user', content: 'Go' },
    { role: 'assistant', content: 'Sure.', toolCalls: [{ id: 'call_0', name: 'scene_read', arguments: { path: 'x' } }] }, { role: 'tool', toolCallId: 'call_0', content: 'ok' }], 32, AbortSignal.timeout(5000), tools));
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'scene_read', description: 'Read.', parameters: { type: 'object' } } }]);
  assert.deepEqual(body.messages.slice(1), [{ role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'scene_read', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'ok' }]);
  assert.deepEqual(out, [{ type: 'tool_call', id: 'call_a', name: 'scene_read', arguments: { path: 'Lighting' } }, { type: 'stop', reason: 'tool_use' }, { type: 'usage', inputTokens: 30, outputTokens: 9 }]);
});

test('unreadable streamed tool arguments fail closed', async () => {
  const config = testConfig({ OPENAI_API_KEY: 'k' });
  const upstream = createUpstream((async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'scene_read', arguments: '{nope' } }] }, finish_reason: 'tool_calls' }] }])) as unknown as typeof fetch);
  await assert.rejects(collect(upstream(config, config.models[1], [{ role: 'user', content: 'Go' }], 8, AbortSignal.timeout(5000), [{ name: 'scene_read', description: '', inputSchema: {} }])), UpstreamError);
});
