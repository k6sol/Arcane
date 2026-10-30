/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import {readStudioStagingDiagnostic,studioStagingDiagnosticMessage,STUDIO_STAGING_PHASES,STUDIO_STAGING_REASONS} from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import { buildProgressSummary, compactCount, describeToolActivity, formatElapsed, inferToolFromResult, inferToolFromText, readToolResultText, retriedRows, toolFailureReason, toolResultFacts,
  toolResultImage, UNNAMED_TOOL_TEXT, type ChatState } from '../../apps/desktop/src/codex-chat.js';

// ---- Fact extraction: a few plain numbers from the compact results the Arcane tools really return ----
const outcome = (method: string, result: unknown, extra: Record<string, unknown> = {}) => ({ commandId: 'cmd-1', state: 'succeeded', terminal: true, command: { method, args: {}, result }, ...extra });
test('actual closed staging descriptors reach loaded-history and shared named-result reasons without confirmed failure or import',()=>{
  for(const phase of STUDIO_STAGING_PHASES)for(const reason of STUDIO_STAGING_REASONS){
    const diagnostic=readStudioStagingDiagnostic({schemaVersion:1,operation:'stage',phase,reason,packetOrdinal:phase==='packet-enqueue'||phase==='packet-receipt'?511:null})!;
    const value={state:'unknown',terminal:false,ambiguous:true,retry:false,error:{code:'STUDIO_STAGE_CONTINUITY',message:'private native-id source text',diagnostic}};
    const read=readToolResultText(JSON.stringify(value));assert.equal(read.name,'assets_stage_studio_import');assert.equal(read.state,'finished');
    for(const name of [read.name!,'mcp__arcane__assets_stage_studio_import']){
      const activity=describeToolActivity(name,null,read.result,'finished');assert.equal(activity.unconfirmed,true);assert.equal(activity.text,'Studio staging outcome unconfirmed');
      assert.equal(activity.reason,studioStagingDiagnosticMessage(diagnostic).replace(/^Studio staging outcome is unconfirmed\. /,''));
      assert.equal(activity.change,null);assert.deepEqual(activity.facts,[]);assert.doesNotMatch(activity.text+' '+activity.reason,/private native-id|source text/);
    }
  }
  assert.equal(describeToolActivity('assets_stage_studio_import',null,null,'started').unconfirmed,undefined,'identity-only live events cannot invent a result');
  const malformed={state:'unknown',terminal:false,ambiguous:true,retry:false,error:{code:'STUDIO_STAGE_CONTINUITY',diagnostic:{schemaVersion:1,operation:'stage',phase:'packet-receipt',reason:'private',packetOrdinal:0}}};
  assert.equal(describeToolActivity('assets_stage_studio_import',null,malformed,'finished').unconfirmed,undefined);
  assert.equal(readToolResultText(JSON.stringify({error:{code:'OTHER',message:'Original failure'}})).state,'failed');
});
const forestKit = { kind: 'forest', key: 'grove', parts: 0, triangles: 11500, placed: 240, requested: 260, originals: { oak: ['oak-1', 'oak-2'] } };
const plinthKit = { kind: 'plinth', key: 'spawn', parts: 14, triangles: 2400, top: 52.7, spawn: { at: [0, 52.7, 0], top: 53.2 } };

test('scene kits report trees placed and skipped, triangles, spawn height and Blender originals', () => {
  assert.deepEqual(toolResultFacts('scene_build', null, outcome('scene.build', { created: { count: 260 } }, { kits: [forestKit] })), ['240 placed', '20 skipped', '11.5k tris', 'Blender originals']);
  assert.deepEqual(toolResultFacts('scene_build', null, outcome('scene.build', null, { kits: [{ ...forestKit, placed: 2312, requested: 2340 }] })).slice(0, 2), ['2,312 placed', '28 skipped'], 'exact grouped counts, as the canvas reads them');
  assert.deepEqual(toolResultFacts('scene_build', null, outcome('scene.build', null, { kits: [plinthKit] })), ['spawn at 53 studs', '2.4k tris']);
  assert.deepEqual(toolResultFacts('scene_build', null, outcome('scene.build', null, { kits: [forestKit, plinthKit] })), ['240 placed', '20 skipped', 'spawn at 53 studs', '13.9k tris'], 'kit triangles add up');
  assert.deepEqual(toolResultFacts('scene_build', null, outcome('scene.build', { created: { count: 48 } }, { plannedInstances: 48, scatter: [{ requested: 40, placed: 36 }] })), ['48 instances', '36 scattered']);
  assert.deepEqual(toolResultFacts('scene_build', null, { plannedInstances: 1 }), ['1 instance']);
});

test('terrain, caves, Output, captures and Blender jobs read as short facts', () => {
  const terrain = outcome('terrain.generate', { mutation: { kind: 'terrain.generate', after: { region: {}, size: [1024, 256, 1024], features: 3, voxels: 9 } } },
    { caves: { nodes: 40, dropped: 0, mouths: [[1, 2, 3], [4, 5, 6]], chambers: [[0, 1, 0, 9], [5, 1, 5, 8], [9, 1, 9, 7]], fixtures: { name: 'f', prototypes: {}, items: [] } } });
  assert.deepEqual(toolResultFacts('terrain_generate', null, terrain), ['3 chambers', '2 entrances', '1024×1024 studs', '3 features']);
  assert.deepEqual(toolResultFacts('terrain_generate', null, outcome('terrain.generate', { mutation: { after: { size: [512, 128, 256], features: 0 } } })), ['512×256 studs']);
  const output = (kinds: string[]) => outcome('output.read', { entries: kinds.map((kind, seq) => ({ seq, kind, text: 'x' })), latest: kinds.length, omitted: 0 });
  assert.deepEqual(toolResultFacts('studio_output_read', null, output(['info', 'error', 'warning', 'error'])), ['4 lines', '2 errors']);
  assert.deepEqual(toolResultFacts('studio_output_read', null, output(['info'])), ['1 line', 'no errors']);
  assert.deepEqual(toolResultFacts('studio_viewport_capture', null, { viewport: { width: 768, height: 432, bytes: 9 } }), ['768×432']);
  assert.deepEqual(toolResultFacts('assets_jobs', null, { jobs: [{ state: 'running' }, { state: 'succeeded' }, { state: 'succeeded' }, { state: 'failed' }] }), ['1 running', '2 done', '1 failed']);
  assert.deepEqual(toolResultFacts('assets_preview', null, { jobId: 'j', previews: [{}, {}] }), ['2 renders']);
  assert.deepEqual(toolResultFacts('assets_stage_studio_import', null, { imported: 7 }), ['7 models'], 'imports count models');
  assert.deepEqual(toolResultFacts('scene_delete', null, outcome('scene.delete', { removed: 9 })), ['9 removed'], 'removals count objects');
});

test('unknown, malformed and mutation-only results give no facts and never raw JSON', () => {
  for (const value of [null, 'text', 42, [], {}, { kits: 'no' }, { kits: [{ kind: 'forest', placed: 'many' }] }, { caves: { chambers: 'x' } }])
    for (const tool of ['scene_build', 'terrain_generate', 'studio_output_read', 'studio_viewport_capture', 'scene_create', 'unknown_tool'])
      for (const fact of toolResultFacts(tool, null, value)) assert.doesNotMatch(fact, /[{}[\]"]/);
  assert.deepEqual(toolResultFacts('scene_create', null, outcome('scene.create', { ref: {} })), []);
  assert.deepEqual(toolResultFacts('scene_build', null, { kits: [{ kind: 'forest', placed: 'many', triangles: -4 }] }), []);
  assert.deepEqual(toolResultFacts('mystery', null, { triangles: 6000 }), ['6k tris']);
});

test('counts, times and the turn summary', () => {
  assert.deepEqual([240, 999, 1000, 11500, 99999, 240000, 2_500_000].map(compactCount), ['240', '999', '1k', '11.5k', '100k', '240k', '2.5M']);
  assert.deepEqual([400, 1000, 42_000, 134_000, 3_900_000, -1].map(formatElapsed), ['<1s', '1s', '42s', '2m 14s', '1h 05m', '']);
  const row = (tool: string, state: 'started' | 'finished' | 'failed', text = tool) => ({ tool, state, text });
  const rows = [row('studio_output_read', 'finished'), row('terrain_generate', 'finished'), row('scene_build', 'failed'), row('scene_build', 'finished'),
    row('environment_apply', 'finished'), row('studio_viewport_capture', 'finished'), row('assets_procedural', 'finished'), row('assets_jobs', 'finished'), row('skills_get', 'finished')];
  assert.deepEqual(buildProgressSummary(rows, false, 134_000), { title: 'Built in 2m 14s · 9 steps · 1 retried', meta: '', state: 'finished', steps: 9, done: 9, retried: 1, failed: 0 });
  assert.equal(buildProgressSummary(rows, false, null).title, 'Built · 9 steps · 1 retried', 'saved history has no observed time');
  const live = buildProgressSummary([...rows.slice(0, 3), row('scene_build', 'started', 'Placing forest on terrain…')], true, 62_000);
  assert.deepEqual([live.title, live.meta, live.state, live.done, live.steps], ['Build progress', 'Placing forest on terrain · 3 of 4 · 1 failed · 1m 02s', 'started', 3, 4], 'the running step, N of M ended, no ellipsis');
  assert.equal(buildProgressSummary([...rows.slice(0, 4), row('studio_viewport_capture', 'started', 'Capturing viewport…')], true, 128_000).meta, 'Capturing viewport · 4 of 5 · 1 retried · 2m 08s');
  assert.deepEqual([...retriedRows(rows)], [2], 'the failed forest build is the retried row');
  assert.equal(buildProgressSummary([row('script_read', 'finished'), row('scene_search', 'finished')], false, 4000).title, 'Done in 4s · 2 steps', 'read-only turns are not "built"');
  assert.deepEqual(buildProgressSummary([row('scene_build', 'failed'), row('terrain_generate', 'failed')], false, 3000), { title: 'Stopped in 3s · 2 steps · 2 failed', meta: '', state: 'failed', steps: 2, done: 2, retried: 0, failed: 2 });
  assert.equal(buildProgressSummary([row('scene_build', 'finished'), row('terrain_generate', 'started')], false, null).title, 'Incomplete · 2 steps · 1 unfinished');
});

test('completed progress is incomplete when failures remain after successful retries', () => {
  const row = (tool: string, state: 'started' | 'finished' | 'failed', text = tool) => ({ tool, state, text });
  const rows = [row('skills_recommend', 'failed'), row('terrain_generate', 'finished'), row('scene_build', 'failed'),
    row('scene_build', 'finished'), row('environment_apply', 'finished'), row('studio_viewport_capture', 'failed')];
  assert.deepEqual(buildProgressSummary(rows, false, 45_000), {
    title: 'Incomplete in 45s · 6 steps · 1 retried · 2 failed', meta: '', state: 'failed', steps: 6, done: 6, retried: 1, failed: 2,
  });
  assert.equal(buildProgressSummary(rows, false, null).title, 'Incomplete · 6 steps · 1 retried · 2 failed', 'history does not invent elapsed time');
  assert.deepEqual([...retriedRows(rows)], [2], 'the recovered build does not erase unrelated skill/capture failures');
  assert.deepEqual(buildProgressSummary(rows, true, 45_000), {
    title: 'Build progress', meta: '6 of 6 · 1 retried · 2 failed · 45s', state: 'started', steps: 6, done: 6, retried: 1, failed: 2,
  }, 'the live turn remains running even if every currently observed call has ended');
  assert.deepEqual(buildProgressSummary([row('skills_recommend', 'failed'), row('sessions', 'finished')], false, 5000), {
    title: 'Incomplete in 5s · 2 steps · 1 failed', meta: '', state: 'failed', steps: 2, done: 2, retried: 0, failed: 1,
  }, 'read-only failures also cannot claim Done');
  assert.deepEqual(buildProgressSummary([row('scene_build', 'finished'), row('studio_viewport_capture', 'started')], false, null), {
    title: 'Incomplete · 2 steps · 1 unfinished', meta: '', state: 'failed', steps: 2, done: 1, retried: 0, failed: 0,
  }, 'an ended turn does not manufacture completion of an unfinished call');
  assert.equal(buildProgressSummary([row('scene_build', 'failed'), row('scene_build', 'finished')], false, 5000).title,
    'Built in 5s · 2 steps · 1 retried', 'successful recovery keeps its existing Built summary');
  assert.equal(buildProgressSummary([row('skills_recommend', 'failed'), row('studio_viewport_capture', 'failed')], false, 5000).title,
    'Stopped in 5s · 2 steps · 2 failed', 'a wholly failed group retains Stopped');
  assert.equal(buildProgressSummary([row('sessions', 'finished'), row('script_read', 'finished')], false, 5000).title,
    'Done in 5s · 2 steps', 'successful read-only work retains Done');
});

test('friendly labels, failure reasons, images and shape-recognised results', () => {
  const label = (tool: string, input: unknown) => describeToolActivity('mcp__arcane__' + tool, input, null, 'started').text;
  assert.equal(label('terrain_generate', { caves: { at: [0, 0], chambers: 3 } }), 'Carving caves…');
  assert.equal(label('terrain_generate', { size: [512, 512] }), 'Generating terrain…');
  assert.equal(label('scene_build', { kits: [{ kind: 'forest' }] }), 'Placing forest on terrain…');
  assert.equal(label('scene_build', { kits: [{ kind: 'plinth' }] }), 'Building the spawn plinth…');
  assert.equal(label('assets_procedural', { name: 'oak-large', generator: { kind: 'tree', species: 'oak' } }), 'Generating oak model…');
  assert.equal(label('assets_procedural', { name: 'cliff', generator: { kind: 'rock' } }), 'Generating rock model…');
  assert.equal(label('environment_apply', { preset: 'forest-dawn' }), 'Applying forest lighting…');
  assert.equal(label('studio_output_read', {}), 'Reading Studio Output…');
  assert.equal(label('studio_viewport_capture', {}), 'Capturing viewport…');
  assert.equal(describeToolActivity('scene_build', { kits: [{ kind: 'forest' }] }, outcome('scene.build', null, { kits: [forestKit] }), 'finished').facts?.[0], '240 placed');
  assert.equal(describeToolActivity('scene_build', null, null, 'started').facts?.length, 0, 'no facts while running');
  assert.equal(toolFailureReason('Studio is not in edit mode. Stop the playtest first, then try again.'), 'Studio is not in edit mode.');
  assert.equal(toolFailureReason({ error: { code: 'INPUT', message: 'caves.at is inside a keep-out circle or pad (spawn clearing); move the outcrop away from it.' } }),
    'caves.at is inside a keep-out circle or pad (spawn clearing); move the outcrop away from it.');
  assert.equal(toolFailureReason({ commandId: 'c', state: 'failed', command: { error: 'x'.repeat(300) } })?.length, 96);
  assert.equal(toolFailureReason('{"raw":"json"}'), null, 'raw JSON is never a reason');
  assert.equal(describeToolActivity('scene_build', null, 'Studio is not in edit mode.', 'failed').reason, 'Studio is not in edit mode.');
  const png = makePng(4, 3, () => [10, 20, 30]);
  assert.equal(toolResultImage({ viewport: { width: 4, height: 3 }, data: png }), png);
  assert.equal(toolResultImage({ content: [{ type: 'text', text: '{}' }, { type: 'image', mimeType: 'image/png', data: png }] }), png);
  assert.equal(toolResultImage({ image: 'data:image/png;base64,' + png }), png);
  for (const bad of [{ data: png }, { viewport: {}, data: 'not base64!' }, { image: 'data:image/gif;base64,R0lGOD' }, { viewport: {}, data: 'QUJD' }]) assert.equal(toolResultImage(bad), null);
  // JPEG captures too, with the declared type matching the bytes, within 1.5 MiB; never a URL.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg fixture bytes!!')]).toString('base64');
  assert.equal(toolResultImage({ image: 'data:image/jpeg;base64,' + jpeg }), jpeg);
  assert.equal(toolResultImage({ content: [{ type: 'image', mimeType: 'image/jpeg', data: jpeg }] }), jpeg);
  const big = (bytes: number) => { const b = Buffer.alloc(bytes); Buffer.from(png, 'base64').copy(b); return b.toString('base64'); };
  assert.equal(toolResultImage({ image: 'data:image/png;base64,' + big(1536 * 1024) })?.length, Math.ceil(1536 * 1024 / 3) * 4);
  for (const bad of [{ image: 'data:image/png;base64,' + jpeg }, { image: 'data:image/jpeg;base64,' + png }, { content: [{ type: 'image', mimeType: 'image/jpeg', data: png }] },
    { image: 'data:image/png;base64,' + big(1536 * 1024 + 3) }, { image: 'https://example.invalid/capture.png' }, { image: 'blob:http://127.0.0.1/x' },
    { content: [{ type: 'image', mimeType: 'image/webp', data: png }] }]) assert.equal(toolResultImage(bad), null, JSON.stringify(bad).slice(0, 80));
  assert.equal(inferToolFromResult({ viewport: { width: 1 } }), 'studio_viewport_capture');
  assert.equal(inferToolFromResult({ kits: [] }), 'scene_build');
  assert.equal(inferToolFromResult({ entries: [], latest: 0 }), 'studio_output_read');
  assert.equal(inferToolFromResult({ ok: true }), null);
  assert.equal(readToolResultText(JSON.stringify(outcome('terrain.generate', {}))).name, 'terrain_generate', 'saved history names terrain, scene builds and lighting');
});

test('every step reads in plain words: Arcane tools, Claude Code tools and a verb fallback that never shows the raw id', () => {
  const label = (tool: string, input: unknown = null) => describeToolActivity(tool, input, null, 'finished').text;
  const ref = (...pathSegments: string[]) => ({ instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments, className: 'Folder' });
  assert.equal(label('mcp__arcane__assets_stage_studio_import'), 'Importing approved models');
  assert.equal(label('scene_delete', { targets: [ref('PlaceholderForest')] }), 'Removing Workspace.PlaceholderForest');
  assert.equal(label('scene_delete', { targets: [ref('A'), ref('B')] }), 'Removing 2 objects');
  assert.equal(label('scene_delete', { clearWorkspace: true }), 'Clearing the Workspace');
  assert.equal(describeToolActivity('studio_viewport_capture', null, null, 'started').text, 'Capturing viewport…');
  for (const [tool, text] of [['Bash', 'Running a command'], ['Edit', 'Editing a file'], ['Read', 'Reading a file'], ['TodoWrite', 'Updating the plan'], ['Task', 'Running a helper agent']] as const)
    assert.equal(label(tool), text, tool);
  for (const [tool, text] of [['scene_remove', 'Removing objects'], ['assets_import', 'Importing models'], ['assets_' + 'start', 'Modelling in Blender'],
    ['studio_capture_frame', 'Capturing viewport'], ['mystery_tool', UNNAMED_TOOL_TEXT], ['<b onmouseover=x>', UNNAMED_TOOL_TEXT]] as const) {
    assert.equal(label(tool), text, tool);
    assert.ok(!label(tool).includes(tool), 'the raw id never shows: ' + tool);
  }
});

test('saved history without a tool name is recognised by its result shape or text, then one neutral label', () => {
  assert.equal(inferToolFromResult({ sessions: [] }), 'sessions');
  assert.equal(inferToolFromResult({ jobId: 'j', state: 'queued' }), 'assets_procedural');
  assert.equal(inferToolFromResult({ skills: [] }), 'skills_get');
  assert.equal(inferToolFromText('A playtest operation is already in progress.', 'failed'), 'playtest_request');
  assert.equal(inferToolFromText('The viewport capture timed out.', 'failed'), 'studio_viewport_capture');
  assert.equal(inferToolFromText('ok', 'finished'), null);
  assert.equal(describeToolActivity('playtest_request', null, 'A playtest operation is already in progress.', 'failed').reason, 'A playtest operation is already in progress.');
  assert.equal(UNNAMED_TOOL_TEXT, 'Running a step');
});

// ---- A tiny real PNG (a stylised viewport: sky, hills and a row of trees) ----
function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return ~crc >>> 0;
}
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): string {
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
function viewportPng(): string {
  const w = 96, h = 54;
  return makePng(w, h, (x, y) => {
    const hill = 34 + Math.round(5 * Math.sin(x / 9)), tree = x % 12 < 5 && y > hill - 10 + Math.abs((x % 12) - 2) * 3 && y < hill + 2;
    if (tree) return [28, 64, 38];
    if (y >= hill) return y > 46 ? [92, 84, 70] : [58, 104, 52];
    const t = y / hill; return [Math.round(150 + 60 * t), Math.round(176 + 40 * t), Math.round(204 + 20 * t)];
  });
}

// ---- Edge: a long build turn in the shared transcript (Claude fixture; the ChatGPT and Arcane chats share the grouping) ----
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('Edge: build progress group, live and collapsed, with facts, retry, reason and a viewport thumbnail', { skip: !browserModule, timeout: 120000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/progress');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'claude-preferences', 'task-usage', 'task-usage-ui'];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat} from '/claude-chat.js';
    const f = window.fx = { calls: [] };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], defaultModel: 'opus', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, message: null }),
      list: async () => ({ conversations: [] }), history: async id => ({ conversationId: id, messages: [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-' + f.calls.length, conversationId: 'conv-forest' }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    setup.subscribeChatSurface(() => { if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); } else { claude.deactivate(); chat.yieldSurface(false); } });
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  const thread = { threadId: 'fixture-thread', sessionId: 'fixture-session', selection: { model: 'gpt-6.1-sol', effort: 'low' }, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' };
  const codexState = {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false }, nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'gpt-6.1-sol', id: 'opaque-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: { model: 'gpt-6.1-sol', effort: 'low' }, thread,
      operations: [], approvals: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null, events: [],
    },
  } as unknown as ChatState;
  const server = createServer((request, response) => { void (async () => {
    const url = request.url?.split('?')[0] ?? '';
    if (url === '/v1/codex/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: codexState })); return; }
    if (url === '/studio.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(fixture); return; }
    const file = url === '/studio' ? 'apps/desktop/public/studio.html' : url === '/studio.css' ? 'apps/desktop/public/studio.css'
      : url.endsWith('.js') && modules.includes(url.slice(1, -3)) ? join(build, 'apps/desktop/src', url.slice(1)) : null;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': url === '/studio' ? 'text/html' : url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    response.end(await readFile(resolve(file)));
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const png = viewportPng();
  assert.ok(png.length < 3500, 'the fixture capture fits a Claude tool result');
  for (const scheme of ['dark', 'light'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme }); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
    await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
    await page.waitForFunction(() => (window as any).fx?.ready === true);
    await page.evaluate(async()=>{
      const module=await import(new URL('/codex-chat.js',location.origin).href),value={state:'unknown',terminal:false,ambiguous:true,retry:false,
        error:{code:'STUDIO_STAGE_CONTINUITY',message:'untrusted text',diagnostic:{schemaVersion:1,operation:'stage',phase:'packet-receipt',reason:'proof-expired',packetOrdinal:12}}};
      const read=module.readToolResultText(JSON.stringify(value)),activity=module.describeToolActivity(read.name,null,read.result,read.state);
      const article=document.createElement('article');article.id='staging-diagnostic-proof';article.className='codex-message tool';
      article.append(...module.renderToolActivity(document,activity,read.state,module.toolDetailText([['Result',value]])));document.body.append(article);
    });
    const staging=page.locator('#staging-diagnostic-proof');
    assert.equal(await staging.locator('.tool-activity-mark').getAttribute('data-tool-state'),'unknown');
    assert.match(await staging.locator('.visually-hidden').innerText(),/Outcome unconfirmed/);
    assert.equal(await staging.locator('.tool-activity-reason').innerText(),'Packet receipt, packet 13: the Studio connection check expired.');
    assert.equal(await staging.locator('.tool-fact').count(),0);await staging.locator('.tool-activity').press('Enter');
    assert.equal(await staging.locator('details').evaluate(node=>(node as HTMLDetailsElement).open),true);
    assert.match(await staging.locator('pre').innerText(),/"state": "unknown"/);assert.doesNotMatch(await staging.locator('.message-text').innerText(),/Imported|Failed/);
    await staging.evaluate(node=>node.remove());
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
    await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
    await page.evaluate(() => (window as any).fx.refreshed);
    const composer = page.locator('#codex-composer');
    await composer.fill('Build a misty oak forest with caves and a spawn plinth'); await composer.press('Enter');
    await page.waitForFunction(() => (window as any).fx.calls.length === 1);
    await page.evaluate(() => {
      const fx = (window as any).fx;
      // The host's live tool event: bounded result text plus, for an Arcane capture, the image as a PNG/JPEG data URL.
      fx.tool = (id: string, name: string, status: string, input?: unknown, result?: unknown, image?: string) => fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'tool',
        message: { id, role: 'tool', text: name, at: status === 'started' ? new Date().toISOString() : '', tool: { name, status, ...(input ? { input: JSON.stringify(input) } : {}),
          ...(result === undefined ? {} : { result: typeof result === 'string' ? result : JSON.stringify(result) }), ...(image ? { image } : {}) } } });
      fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'message', message: { id: 'a0', role: 'assistant', text: 'I will read Output, shape the terrain and caves, grow the oaks, then place the forest and the spawn plinth.', at: '' } });
    });
    const parent = { instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments: ['Forest'], className: 'Folder' };
    const ok = (method: string, result: unknown, extra: Record<string, unknown> = {}) => ({ commandId: 'cmd-' + method, state: 'succeeded', terminal: true, command: { method, args: {}, result }, ...extra });
    const steps: [string, string, unknown, number, 'finished' | 'failed', unknown][] = [
      ['s1', 'studio_output_read', { limit: 50 }, 2000, 'finished', ok('output.read', { entries: [{ seq: 1, kind: 'info', text: 'Place loaded' }, { seq: 2, kind: 'warning', text: 'x' }], latest: 2, omitted: 0 })],
      ['s2', 'terrain_generate', { size: [1024, 1024], caves: { at: [180, -120], chambers: 3, entrances: 2 } }, 21000, 'finished',
        ok('terrain.generate', { mutation: { kind: 'terrain.generate', after: { size: [1024, 256, 1024], features: 3 } } }, { caves: { nodes: 40, dropped: 0, mouths: [[1, 2, 3], [4, 5, 6]], chambers: [[0, 1, 0, 9], [5, 1, 5, 8], [9, 1, 9, 7]] } })],
      ['s3', 'assets_procedural', { name: 'oak-large', generator: { kind: 'tree', species: 'oak' } }, 4000, 'finished', { jobId: 'job-oak', state: 'queued' }],
      ['s4', 'assets_jobs', { limit: 4 }, 38000, 'finished', { jobs: [{ jobId: 'job-oak', state: 'succeeded' }] }],
      ['s5', 'scene_build', { parent, kits: [{ kind: 'forest', seed: 7 }] }, 3000, 'failed', 'Studio is not in edit mode. Stop the playtest, then try again.'],
      ['s6', 'scene_build', { parent, kits: [{ kind: 'forest', seed: 7 }] }, 26000, 'finished', ok('scene.build', { created: { count: 262 } }, { kits: [{ kind: 'forest', key: 'grove', parts: 0, triangles: 11500, placed: 240, requested: 260, originals: { oak: ['oak-1'] } }] })],
      ['s7', 'scene_build', { parent, kits: [{ kind: 'plinth', seed: 2 }] }, 6000, 'finished', ok('scene.build', { created: { count: 14 } }, { kits: [{ kind: 'plinth', key: 'spawn', parts: 14, triangles: 2400, spawn: { at: [0, 52.7, 0], top: 53.2 } }] })],
      ['s8', 'environment_apply', { preset: 'forest-dawn' }, 3000, 'finished', ok('environment.apply', { mutation: { kind: 'environment.apply' } })],
      ['s9', 'studio_viewport_capture', { maxDimension: 768 }, 5000, 'finished', { viewport: { nativeStudioId: 'n', width: 768, height: 432, originalWidth: 1536, originalHeight: 864, downscaled: true, bytes: 1, sha256: 'a'.repeat(64), camera: 'restored', evidence: 'fixture' } }],
    ];
    const group = page.locator('#codex-messages .build-progress');
    for (const [index, [id, name, input, ms, state, result]] of steps.entries()) {
      await page.evaluate(([id, name, input]) => (window as any).fx.tool(id, name, 'started', input), [id, name, input] as const);
      await page.clock.runFor(ms);
      if (index === 5) {
        // Mid-build: the forest kit is running after a retried failure.
        await group.waitFor();
        assert.equal(await group.evaluate(node => (node as HTMLDetailsElement).open), true, 'open while the turn runs');
        assert.equal(await group.locator('.build-progress-title').innerText(), 'Build progress');
        assert.match(await group.locator('.build-progress-meta').innerText(), /^Placing forest on terrain · 5 of 6 · 1 failed · 1m \d\ds$/);
        assert.deepEqual(await group.locator('.build-progress-bar').evaluate(bar => [bar.getAttribute('role'), bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]), ['progressbar', '5', '6'], 'a thin bar: steps ended of steps started');
        assert.match(await group.locator('.codex-message.tool[data-tool-state=started] .tool-activity-time').innerText(), /^2[56]s$/, 'the running step shows its elapsed time');
        await group.screenshot({ path: join(shots, 'progress-live-' + scheme + '.png') });
      }
      const image = name === 'studio_viewport_capture' ? 'data:image/png;base64,' + png : undefined;
      await page.evaluate(([id, name, state, result, image]) => (window as any).fx.tool(id, name, state, undefined, result, image), [id, name, state, result, image] as const);
      await page.clock.runFor(1500);
    }
    assert.deepEqual(await group.locator('.build-progress-items .tool-activity-text').allInnerTexts(), ['Reading Studio Output', 'Carving caves', 'Generating oak model', 'Checking Blender progress',
      'Placing forest on terrain', 'Placing forest on terrain', 'Building the spawn plinth', 'Applying forest lighting', 'Capturing viewport']);
    assert.deepEqual(await group.locator('.build-progress-items .tool-fact').allInnerTexts(), ['2 lines', 'no errors', '3 chambers', '2 entrances', '1 done',
      '240 placed', '20 skipped', 'spawn at 53 studs', '2.4k tris', '768×432'], 'at most two chips per row');
    assert.equal(await group.locator('.tool-activity-reason').innerText(), 'Studio is not in edit mode. Retried below.');
    assert.equal(await group.locator('.tool-details[open]').count(), 0, 'raw details stay collapsed');
    assert.equal(await group.locator('.tool-details > summary').evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).getBoundingClientRect().height > 0).length), 0, 'no Details link on any row');
    // A row is its own disclosure: Enter opens its raw details under it, Enter again closes them.
    const firstRow = group.locator('.build-progress-items .tool-activity[role=button]').first();
    await firstRow.focus(); await page.keyboard.press('Enter');
    assert.equal(await firstRow.getAttribute('aria-expanded'), 'true');
    assert.ok(await group.locator('.tool-details[open] pre').first().isVisible(), 'the raw details show under the row');
    await page.keyboard.press('Enter'); assert.equal(await group.locator('.tool-details[open]').count(), 0);
    assert.doesNotMatch(await group.locator('.build-progress-items').evaluate(node => [...node.querySelectorAll('.tool-activity,.tool-activity-reason')].map(line => (line as HTMLElement).innerText).join('\n')), /[{}"]/, 'no raw JSON by default');
    const thumb = group.locator('.tool-thumb');
    assert.equal(await thumb.getAttribute('aria-label'), 'Enlarge Studio viewport capture (768×432)');
    assert.ok(await thumb.locator('img').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 96), 'the PNG decodes from a blob: URL');
    await page.evaluate(() => (window as any).fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'message', message: { id: 'a1', role: 'assistant', text: 'The misty oak forest is built: 240 oaks around three cave chambers, with the spawn plinth on the ridge.', at: '' } }));
    await page.clock.runFor(2000);
    await page.evaluate(() => (window as any).fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'done', ok: true, error: null, usage: { inputTokens: 52000, outputTokens: 4100, costUsd: 0.31 } }));
    await page.waitForFunction(() => (document.querySelector('#codex-messages .build-progress') as HTMLDetailsElement | null)?.open === false);
    const summary = await group.locator('.build-progress-title').innerText();
    assert.match(summary, /^Built in 2m \d\ds · 9 steps · 1 retried$/, summary);
    assert.equal(await group.getAttribute('data-tool-state'), 'finished');
    assert.deepEqual(await group.locator('.build-progress-facts .tool-fact').allInnerTexts(), ['3 chambers', '240 placed', 'spawn at 53 studs'], 'key facts stay visible when collapsed');
    assert.equal(await page.locator('#codex-messages > .codex-message.tool').count(), 0, 'every call is inside the group');
    assert.deepEqual(await page.locator('#codex-messages > :is(.codex-message,.build-progress)').evaluateAll(nodes => nodes.map(node => node.className)),
      ['codex-message human', 'codex-message codex', 'build-progress', 'codex-message codex'], 'the group sits where the first call appeared; replies keep their order');
    await page.locator('#codex-messages').screenshot({ path: join(shots, 'progress-collapsed-' + scheme + '.png') });
    // Keyboard: the summary is a real disclosure control.
    await group.locator('.build-progress-summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await group.evaluate(node => (node as HTMLDetailsElement).open), true, 'Enter expands');
    await thumb.focus(); await page.keyboard.press('Enter');
    assert.equal(await thumb.getAttribute('aria-expanded'), 'true', 'Enter enlarges the capture');
    assert.ok((await thumb.boundingBox())!.width > 400);
    await group.screenshot({ path: join(shots, 'progress-expanded-' + scheme + '.png') });
    await page.keyboard.press('Escape'); assert.equal(await thumb.getAttribute('aria-expanded'), 'false', 'Escape shrinks it');
    await group.locator('.build-progress-summary').focus(); await page.keyboard.press('Space');
    assert.equal(await group.evaluate(node => (node as HTMLDetailsElement).open), false, 'Space collapses');
    // Contrast of the small text on the card.
    const contrast = await group.evaluate(node => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]) => { const [r, g, b] = c.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
      const ratio = (a: string, b: string) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
      let host: Element | null = node, bg = 'rgba(0, 0, 0, 0)';
      while (host && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(host).backgroundColor; host = host.parentElement; }
      if (/rgba\(0, 0, 0, 0\)/.test(bg)) bg = getComputedStyle(document.body).backgroundColor;
      const pick = (selector: string) => getComputedStyle(node.querySelector(selector)!).color;
      return { bg, title: ratio(pick('.build-progress-title'), bg), fact: ratio(pick('.tool-fact'), bg), reason: ratio(pick('.tool-activity-reason'), bg), time: ratio(pick('.tool-activity-time'), bg) };
    });
    for (const key of ['title', 'fact', 'reason', 'time'] as const) assert.ok(contrast[key] >= 4.5, key + ' contrast ' + contrast[key].toFixed(2) + ' on ' + contrast.bg);
    // Reduced motion: nothing in the group animates or transitions.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await group.evaluate(node => [node, ...node.querySelectorAll('*')].every(el => { const s = getComputedStyle(el); return s.animationName === 'none' && /^0s(, 0s)*$/.test(s.transitionDuration); })), true);
    await page.emulateMedia({ reducedMotion: null });
    // Phone width: no horizontal scroll, the summary wraps.
    await page.setViewportSize({ width: 390, height: 844 });
    await group.locator('.build-progress-summary').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scroll at phone width');
    await group.screenshot({ path: join(shots, 'progress-phone-' + scheme + '.png') });
    if (scheme === 'dark') { await page.emulateMedia({ forcedColors: 'active' }); await group.screenshot({ path: join(shots, 'progress-forced-colors.png') }); await page.emulateMedia({ forcedColors: null }); }
    assert.deepEqual(errors, []);
    await page.close();
  }
});
