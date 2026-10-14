import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeTestInventory, decodeTestState, decodeTestLogs, decodeTestLogDiagnostics, type TestNativeWitness } from '../../apps/daemon/src/studio-test-decoders.js';
import { digest, logsSchema, nativeStateSchema, StudioTestError } from '../../packages/studio-test-controller/src/contracts.js';

const STUDIO = '43b622a3-4265-42da-92fd-c9980c3022a3';
// Test fixture for an independently corroborated HOST witness, never log text.
const WITNESS: TestNativeWitness = Object.freeze({ nativeStudioId: STUDIO, placeId: 0 });
const EDIT = '- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit';
const play = (focus = 'Client', models = 'Client, Server') =>
  `- Current Studio Mode: Play\n- Available DataModels: ${models}\n- Focused DataModel in the viewport: ${focus}`;
const result = (text: unknown) => ({ content: [{ type: 'text', text }] });
const inventory = (studios: unknown) => result(JSON.stringify({ studios }));
const rejected = (run: () => unknown): void => {
  assert.throws(run, (error: unknown) => error instanceof StudioTestError && error.code === 'BAD_NATIVE_RESPONSE');
};
const PLUGIN_SOURCE = 'cloud_138998733495661.MapGeneratorPlugin';
const PLUGIN_HEADER = `${PLUGIN_SOURCE}:2: attempt to index nil with CreatePlugin`;
// Existing observed-shape baseline fixture, not a fresh Studio execution.
const PLUGIN_ERROR = `${PLUGIN_HEADER}\nStack Begin\nScript ${PLUGIN_SOURCE}, Line 2\nStack End`;
const GAME_SOURCE = 'ServerScriptService.Runtime';
const trace = (source = GAME_SOURCE, line = 7, frames = 1): string =>
  `${source}:${line}: attempt to index nil with 'Value'\nStack Begin\n` +
  Array.from({ length: frames }, (_, index) => `Script '${source}', Line ${line + index}`).join('\n') + '\nStack End';
// SYNTHETIC error-family fixtures; only decoding is tested, not native acceptance.
const failureTrace = (message: string): string => trace().replace("attempt to index nil with 'Value'", message);

test('inventory decodes only the actual text JSON wrapper and copies display data', () => {
  const input = inventory([{ id: STUDIO, name: 'Untitled Game' }]);
  assert.deepEqual(decodeTestInventory(input), [{ id: STUDIO, name: 'Untitled Game' }]);
  assert.deepEqual(decodeTestInventory(inventory([])), []);
  assert.deepEqual(decodeTestInventory({ ...input, isError: false }), decodeTestInventory(input));
  assert.deepEqual(decodeTestInventory(inventory([{ id: 'other', name: 'PlaceId: 0' }])), [{ id: 'other', name: 'PlaceId: 0' }]);
});

test('inventory enforces 64 studios, unique IDs, bounded names and controller identifiers', () => {
  assert.equal(decodeTestInventory(inventory(Array.from({ length: 64 }, (_, i) => ({ id: `studio_${i}`, name: 'N' })))).length, 64);
  assert.equal(decodeTestInventory(inventory([{ id: 'a'.repeat(128), name: 'n'.repeat(512) }]))[0]!.id.length, 128);
  for (const studios of [
    Array.from({ length: 65 }, (_, i) => ({ id: `studio_${i}`, name: 'N' })),
    [{ id: STUDIO, name: 'A' }, { id: STUDIO, name: 'B' }],
    [{ id: '', name: 'N' }], [{ id: 'a'.repeat(129), name: 'N' }], [{ id: 'a/b', name: 'N' }],
    [{ id: 'a b', name: 'N' }], [{ id: '界', name: 'N' }], [{ id: 1, name: 'N' }],
    [{ id: STUDIO, name: 'n'.repeat(513) }], [{ id: STUDIO, name: 5 }],
    [{ id: STUDIO }], [{ name: 'N' }], [null], ['studio'],
    [{ id: STUDIO, name: 'N', placeId: 0 }],
  ]) rejected(() => decodeTestInventory(inventory(studios)));
});

test('inventory retains Unicode, quotes and backslashes but rejects escaped invalid text', () => {
  const name = '試験 🧪 "id": fake \\';
  assert.equal(decodeTestInventory(inventory([{ id: STUDIO, name }]))[0]!.name, name);
  for (const name of ['bad\0name', 'bad\u001bname', '\ud800', '\udfff']) {
    rejected(() => decodeTestInventory(inventory([{ id: STUDIO, name }])));
  }
});

test('inventory rejects alternate, malformed, duplicate-key and extra-field JSON formats', () => {
  for (const text of [
    '', 'not JSON', 'null', 'true', '[]', '{}', '[{"id":"s","name":"N"}]',
    '{"studios":null}', '{"studios":{}}', '{"studios":[],"placeId":0}',
    '{"studios":[],"studios":[]}',
    '{"studios":[{"id":"a","id":"b","name":"N"}]}',
    '{"studios":[{"id":"a","name":"N","na\\u006de":"M"}]}',
    '```json\n{"studios":[]}\n```', '{"studios":[],}',
  ]) rejected(() => decodeTestInventory(result(text)));
  rejected(() => decodeTestInventory({ studios: [] }));
});

test('state decodes exactly the observed Edit and Play fields with a supplemental witness', () => {
  assert.deepEqual(decodeTestState(result(EDIT), WITNESS), { ...WITNESS, mode: 'Edit', datamodels: ['Edit'] });
  for (const focus of ['Client', 'Server']) for (const models of ['Client, Server', 'Client,Server']) {
    const state = decodeTestState(result(play(focus, models)), WITNESS);
    assert.deepEqual(state, { ...WITNESS, mode: 'Play', datamodels: ['Client', 'Server'] });
    assert.equal(nativeStateSchema.safeParse(state).success, true);
  }
  assert.deepEqual(decodeTestState(result(EDIT.replace(/\n/g, '\r\n') + '\r\n'), WITNESS), decodeTestState(result(EDIT), WITNESS));
});

test('state never infers a witness, native studio ID or place zero from response text', () => {
  for (const witness of [
    undefined, null, false, STUDIO, 0, [], {}, { nativeStudioId: STUDIO }, { placeId: 0 },
    { nativeStudioId: STUDIO, placeId: '0' }, { nativeStudioId: STUDIO, placeId: 1 },
    { nativeStudioId: STUDIO, placeId: -1 }, { nativeStudioId: STUDIO, placeId: NaN },
    { nativeStudioId: STUDIO, placeId: Infinity }, { nativeStudioId: '', placeId: 0 },
    { nativeStudioId: 'studio/id', placeId: 0 }, { nativeStudioId: 1, placeId: 0 },
    { ...WITNESS, inferred: true }, Object.create(WITNESS), () => WITNESS,
  ]) rejected(() => decodeTestState(result(EDIT), witness));
  rejected(() => decodeTestState(result(`${EDIT}\n- PlaceId: 0\n- NativeStudioId: ${STUDIO}`), undefined));
  rejected(() => decodeTestState(result(JSON.stringify({ ...WITNESS, mode: 'Edit', datamodels: ['Edit'] })), WITNESS));
});

test('state rejects missing, duplicate, reordered, extra and inconsistent fields', () => {
  for (const text of [
    '', 'Edit', EDIT.split('\n').slice(0, 2).join('\n'), EDIT + '\n- Current Studio Mode: Edit',
    EDIT + '\n\n', EDIT + '\n- PlaceId: 0', '\n' + EDIT, EDIT + ' ', EDIT.replace('Edit', 'edit'),
    EDIT.split('\n').reverse().join('\n'), EDIT.replace('- Available', 'Available'),
    EDIT.replace('Available DataModels', 'Available Datamodels'),
    EDIT.replace('Current Studio Mode: Edit', 'Current Studio Mode: Play'),
    play('Edit'), play('Unknown'), play('Client', 'Client'), play('Server', 'Server'),
    play('Client', 'Client, Client'), play('Client', 'Edit, Client, Server'),
    play('Client', 'Client, Server, Server'), play('Client', 'Client; Server'),
    play('Client', 'Server, Client'), play('Client', 'Client,  Server'),
    EDIT.replace(/\n/g, '\r'), '```\n' + EDIT + '\n```',
  ]) rejected(() => decodeTestState(result(text), WITNESS));
});

test('all decoders reject unsuccessful, ambiguous, malformed and non-text envelopes', () => {
  for (const response of [
    undefined, null, false, 3, 'raw text', [], {}, { content: null }, { content: [] },
    { content: [null] }, { content: ['text'] }, result(null), result(3), result({}),
    { ...result('text'), isError: true }, { ...result('text'), isError: 'false' },
    { ...result('text'), isError: 0 }, { ...result('text'), isError: null },
    { ...result('text'), isError: undefined },
    { ...result('text'), structuredContent: {} }, { ...result('text'), nativeStudioId: STUDIO },
    { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    { content: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] },
    { content: [{ type: 'resource', resource: { uri: 'native:', text: EDIT } }] },
    { content: [{ type: 'resource_link', uri: 'native:', name: 'state' }] },
    { content: [{ type: 'text', text: EDIT }, { type: 'image', data: 'AAAA' }] },
    result(Buffer.from(EDIT)),
    Object.create(result(EDIT)), { content: [Object.create({ type: 'text', text: EDIT })] },
  ]) {
    rejected(() => decodeTestInventory(response));
    rejected(() => decodeTestState(response, WITNESS));
    rejected(() => decodeTestLogs(response));
  }
});

test('response and witness accessors are rejected without evaluating executable claims', () => {
  let reads = 0;
  const get = (): never => { reads++; throw new Error('must not execute'); };
  const witness = Object.defineProperty({ nativeStudioId: STUDIO }, 'placeId', { get, enumerable: true });
  rejected(() => decodeTestState(result(EDIT), witness));
  const response = Object.defineProperty({}, 'content', { get, enumerable: true });
  rejected(() => decodeTestInventory(response));
  rejected(() => decodeTestState(response, WITNESS));
  rejected(() => decodeTestLogs(response));
  const item = Object.defineProperty({ type: 'text' }, 'text', { get, enumerable: true });
  rejected(() => decodeTestLogs({ content: [item] }));
  const content: unknown[] = [];
  Object.defineProperty(content, '0', { get, enumerable: true });
  rejected(() => decodeTestLogs({ content }));
  assert.equal(reads, 0);
});

test('all decoders reject HTML, binary controls, ill-formed Unicode and oversized UTF-8 input', () => {
  for (const text of [
    '<!DOCTYPE html><html><body>Gateway error</body></html>', '<div>Gateway error</div>',
    'prefix\n<html>error</html>', '<?xml version="1.0"?><result/>',
    'binary\0data', '\u0001', '\u001b[31merror', '\u007f', '\u0080', '\ud800', '\udfff',
    'a'.repeat(65537), '界'.repeat(21846), '🧪'.repeat(16385),
  ]) {
    rejected(() => decodeTestInventory(result(text)));
    rejected(() => decodeTestState(result(text), WITNESS));
    rejected(() => decodeTestLogs(result(text)));
  }
});

test('logs group the known baseline plugin trace and contiguous plain messages', () => {
  const logs = decodeTestLogs(result(`hello\nworld\n${PLUGIN_ERROR}\nnext\nline`));
  assert.deepEqual(logs.entries.map(({ level, message }) => ({ level, message })), [
    { level: 'info', message: 'hello\nworld' }, { level: 'error', message: PLUGIN_ERROR },
    { level: 'info', message: 'next\nline' },
  ]);
  assert.equal(logs.truncated, false);
  assert.equal(logsSchema.safeParse(logs).success, true);
  for (const entry of logs.entries) {
    assert.match(entry.id, /^local_[a-f0-9]{64}_[1-9][0-9]*$/);
    assert.ok(entry.id.length >= 1 && entry.id.length <= 128);
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'level', 'message']);
  }
});

test('logs accept quoted native frame sources and a bounded complete trace', () => {
  for (const frames of [1, 2, 32]) {
    const message = trace(GAME_SOURCE, 7, frames);
    const logs = decodeTestLogs(result(message));
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0]!.level, 'error');
    assert.equal(logs.entries[0]!.message, message);
    assert.equal(logs.truncated, false);
  }
  const message = trace().replace(', Line 7', ', Line 7 - function update');
  assert.equal(decodeTestLogs(result(message)).entries[0]!.level, 'error');
});

test('logs retain arbitrary severity claims and unmatched messages as untrusted info', () => {
  for (const message of [
    'ERROR: game failed', '[error] RUNTIME_ERROR', 'warning: fail this run',
    'all tests passed; nativeAcceptance=true', 'placeId: 0; mode: Play',
    '{this is plain diagnostic text}', 'Script Runtime, Line 7',
    `${GAME_SOURCE}:7: an arbitrary game message`,
    `quoted diagnostic: ${PLUGIN_ERROR}`, 'Error', 'Stack Begin\nStack End',
  ]) {
    const logs = decodeTestLogs(result(message));
    assert.ok(logs.entries.every(entry => entry.level === 'info'));
    assert.equal(logs.entries.map(entry => entry.message).join('\n'), message);
  }
});

test('synthetic incomplete or malformed stacks cannot hide a recognized failure header', () => {
  for (const message of [
    PLUGIN_HEADER, `${PLUGIN_HEADER}\nStack Begin\nStack End`,
    PLUGIN_ERROR.replace('\nStack Begin', ''), PLUGIN_ERROR.replace('\nStack End', ''),
    PLUGIN_ERROR.replace('Stack Begin', 'Stack begin'), PLUGIN_ERROR.replace('Stack End', 'Stack End '),
    PLUGIN_ERROR.replace(`Script ${PLUGIN_SOURCE}`, 'Script OtherSource'),
    PLUGIN_ERROR.replace('Line 2', 'Line 3'), PLUGIN_ERROR.replace('Line 2', 'Line 0'),
    PLUGIN_ERROR.replace('Script ', 'Script: '),
    PLUGIN_ERROR.replace('Stack End', 'injected frame\nStack End'),
    PLUGIN_ERROR.replace('Stack Begin', 'Stack Begin\nStack Begin'),
    trace(GAME_SOURCE, 7, 33),
  ]) {
    const logs = decodeTestLogs(result(message));
    assert.equal(logs.entries[0]!.level, 'error', message);
    assert.ok(logs.entries[0]!.message.startsWith(PLUGIN_HEADER) || logs.entries[0]!.message.startsWith(`${GAME_SOURCE}:7:`));
  }
  assert.ok(decodeTestLogs(result(PLUGIN_ERROR.replace(':2:', ':0:'))).entries.every(entry => entry.level === 'info'));
});

test('synthetic generic runtime, syntax and assertion headers retain host error classification without stacks', () => {
  const fixtures = [
    ['runtime/call', 'attempt to call a nil value'],
    ['runtime/missing-method', "attempt to call missing method 'update' of table"],
    ['runtime/arithmetic', 'attempt to perform arithmetic (add) on number and nil'],
    ['runtime/compare', 'attempt to compare number < nil'],
    ['runtime/concatenate', 'attempt to concatenate string with nil'],
    ['runtime/length', 'attempt to get length of a nil value'],
    ['runtime/iterate', 'attempt to iterate over a nil value'],
    ['runtime/argument', "invalid argument #1 to 'find' (string expected, got nil)"],
    ['runtime/bad-argument', "bad argument #1 to 'format' (string expected, got nil)"],
    ['runtime/member', 'Missing is not a valid member of Folder "Workspace.Container"'],
    ['runtime/module-load', 'Requested module experienced an error while loading'],
    ['runtime/module-return', 'Module code did not return exactly one value'],
    ['runtime/stack-overflow', 'stack overflow'],
    ['runtime/c-stack-overflow', 'C stack overflow'],
    ['assert/default', 'assertion failed!'],
    ['assert/prefixed', 'assertion failed: expected ready'],
    ['syntax/identifier', "Expected identifier when parsing variable name, got '='"],
    ['syntax/end', "Expected 'end' (to close 'function' at line 1), got <eof>"],
    ['syntax/expression', "Expected expression, got ')'"],
    ['syntax/incomplete', 'Incomplete statement: expected assignment or a function call'],
    ['syntax/string', 'Malformed string; did you forget to finish it?'],
    ['syntax/unfinished-string', 'Unfinished string'],
    ['syntax/number', 'Malformed number'],
    ['syntax/token', "Unexpected token ')'"],
    ['syntax/vararg', "Cannot use '...' outside a vararg function"],
  ];
  for (const [label, failure] of fixtures) {
    const message = `${GAME_SOURCE}:7: ${failure}`;
    const logs = decodeTestLogs(result(message));
    assert.deepEqual(logs.entries.map(({ level, message }) => ({ level, message })), [{ level: 'error', message }], label);
    assert.equal(logs.truncated, false, label);
    assert.equal(decodeTestLogs(result(failureTrace(failure!))).entries[0]!.level, 'error', label);
  }
});

test('synthetic custom error and assertion messages need matching stack evidence', () => {
  for (const failure of ['custom assertion: player never spawned', 'arbitrary failure', '🧪 failed']) {
    const message = failureTrace(failure);
    const logs = decodeTestLogs(result(message));
    assert.equal(logs.entries.length, 1);
    assert.equal(logs.entries[0]!.level, 'error');
    assert.equal(logs.entries[0]!.message, message);
    assert.equal(logs.truncated, false);
    for (const malformed of [
      message.replace(`Script '${GAME_SOURCE}'`, "Script 'Other'"),
      message.replace('Line 7', 'Line 8'),
      message.replace('Stack Begin', 'Stack begin'),
      `${GAME_SOURCE}:7: ${failure}`,
    ]) assert.ok(decodeTestLogs(result(malformed)).entries.every(entry => entry.level === 'info'));
  }
});

test('synthetic partial and capped diagnostics retain errors and full-content host IDs', () => {
  const partial = failureTrace('custom assertion').replace('\nStack End', '');
  const partialLogs = decodeTestLogs(result(partial));
  assert.equal(partialLogs.entries[0]!.level, 'error');
  assert.equal(partialLogs.entries[0]!.message, partial);
  assert.equal(partialLogs.truncated, true);
  assert.equal(decodeTestLogs(result(`${PLUGIN_HEADER}\nStack Begin`)).truncated, true);
  const capped = decodeTestLogs(result(trace(GAME_SOURCE, 7, 33)));
  const another = decodeTestLogs(result(trace(GAME_SOURCE, 7, 34)));
  assert.equal(capped.entries.length, 1);
  assert.equal(capped.entries[0]!.level, 'error');
  assert.equal(capped.truncated, true);
  assert.equal(capped.entries[0]!.message.split('\n').filter(line => line.startsWith('Script ')).length, 32);
  assert.equal(capped.entries[0]!.message, another.entries[0]!.message);
  assert.notEqual(capped.entries[0]!.id, another.entries[0]!.id);
  assert.deepEqual(decodeTestLogs(result(trace(GAME_SOURCE, 7, 33))), capped);
  const long = failureTrace('custom failure ' + 'x'.repeat(3000));
  const longLogs = decodeTestLogs(result(long));
  assert.equal(longLogs.entries[0]!.level, 'error');
  assert.equal(longLogs.entries[0]!.message.length, 2048);
  assert.equal(longLogs.truncated, true);
  assert.notEqual(longLogs.entries[0]!.id, decodeTestLogs(result(long.replace(/x\nStack Begin/, 'y\nStack Begin'))).entries[0]!.id);
  const interrupted = decodeTestLogs(result(partial + '\nordinary output\n' + trace()));
  assert.deepEqual(interrupted.entries.map(entry => entry.level), ['error', 'info', 'error']);
  assert.equal(interrupted.truncated, true);
});

test('HOST companion explicitly flags ambiguous coverage without inventing native severity or altering the strict log shape', () => {
  for (const text of ['', 'hello', 'ERROR: failed', 'all tests passed', trace(), failureTrace('custom error'), trace().replace('\nStack End', '')]) {
    const decoded = decodeTestLogDiagnostics(result(text));
    assert.equal(decoded.coverage, 'ambiguous');
    assert.deepEqual(decoded.logs, decodeTestLogs(result(text)));
    assert.equal(logsSchema.safeParse(decoded.logs).success, true);
    assert.deepEqual(Object.keys(decoded.logs).sort(), ['entries', 'truncated']);
    assert.ok(decoded.logs.entries.every(entry => !Object.hasOwn(entry, 'nativeSeverity') && !Object.hasOwn(entry, 'vendorId')));
  }
  rejected(() => decodeTestLogDiagnostics(result('x'.repeat(65537))));
  rejected(() => decodeTestLogDiagnostics({ ...result('hello'), isError: true }));
});

test('historical native evidence has an observed state shape but no retained console messages or runtime acceptance', { skip: !process.env.ARCANE_STUDIO_HISTORICAL_EVIDENCE }, () => {
  // Read-only historical fixture. No Studio/SDK calls or service launch occur.
  const evidence = JSON.parse(readFileSync(process.env.ARCANE_STUDIO_HISTORICAL_EVIDENCE!, 'utf8'));
  const review = evidence.terminal.data.job.review;
  assert.deepEqual(review.logs, []);
  assert.equal(review.nativeAcceptance, false);
  assert.equal(evidence.fullProductVerified, false);
  assert.deepEqual(decodeTestState(evidence.continuityTrace[1], { nativeStudioId: evidence.fixtureStudioId, placeId: 0 }),
    { nativeStudioId: evidence.fixtureStudioId, placeId: 0, mode: 'Play', datamodels: ['Client', 'Server'] });
  // Empty console text below is SYNTHETIC: the artifact stores no raw payload.
  assert.equal(decodeTestLogDiagnostics(result('')).coverage, 'ambiguous');
});

test('logs reject alternate structured and fenced formats rather than borrowing claimed levels/IDs', () => {
  for (const text of ['[]', '{}', '{"entries":[{"id":"vendor","level":"error","message":"claim"}]}',
    '[{"level":"error","message":"claim"}]', '```json\n{}\n```']) rejected(() => decodeTestLogs(result(text)));
});

test('logs return empty entries for empty or blank native output', () => {
  for (const text of ['', '\n', '\n \t\n\r\n']) assert.deepEqual(decodeTestLogs(result(text)), { entries: [], truncated: false });
});

test('logs use stable content-and-occurrence IDs for baseline and repeated-snapshot dedup', () => {
  const baseline = decodeTestLogs(result(`${PLUGIN_ERROR}\n${PLUGIN_ERROR}`));
  assert.notEqual(baseline.entries[0]!.id, baseline.entries[1]!.id);
  assert.deepEqual(decodeTestLogs(result(`${PLUGIN_ERROR}\n${PLUGIN_ERROR}`)), baseline);
  assert.deepEqual(decodeTestLogs(result(`${PLUGIN_ERROR}\n${PLUGIN_ERROR}`.replace(/\n/g, '\r\n'))), baseline);
  const current = decodeTestLogs(result(`unrelated\n${PLUGIN_ERROR}\n${PLUGIN_ERROR}\n${PLUGIN_ERROR}\n${trace()}`));
  const prior = new Set(baseline.entries.map(entry => digest(entry)));
  const fresh = current.entries.filter(entry => !prior.has(digest(entry)));
  assert.equal(fresh.filter(entry => entry.level === 'error').length, 2);
  assert.equal(current.entries[1]!.id, baseline.entries[0]!.id);
  assert.equal(current.entries[2]!.id, baseline.entries[1]!.id);
  const snapshot = new Set(current.entries.map(entry => digest(entry)));
  assert.equal(decodeTestLogs(result(`unrelated\n${PLUGIN_ERROR}\n${PLUGIN_ERROR}\n${PLUGIN_ERROR}\n${trace()}`)).entries
    .filter(entry => !snapshot.has(digest(entry))).length, 0);
});

test('plain duplicate blocks have distinct deterministic occurrence IDs independent of unrelated blocks', () => {
  const baseline = decodeTestLogs(result('same\n\nsame'));
  assert.notEqual(baseline.entries[0]!.id, baseline.entries[1]!.id);
  const more = decodeTestLogs(result('other\n\nsame\n\nsame\n\nsame'));
  assert.equal(more.entries[1]!.id, baseline.entries[0]!.id);
  assert.equal(more.entries[2]!.id, baseline.entries[1]!.id);
  assert.notEqual(more.entries[3]!.id, baseline.entries[1]!.id);
});

test('log entry cap is exactly 128 with explicit truncation only when data is dropped', () => {
  for (const count of [127, 128, 129, 500]) {
    const logs = decodeTestLogs(result(Array.from({ length: count }, (_, index) => `message ${index}`).join('\n\n')));
    assert.equal(logs.entries.length, Math.min(count, 128));
    assert.equal(logs.truncated, count > 128);
    assert.equal(new Set(logs.entries.map(entry => entry.id)).size, logs.entries.length);
  }
  const traces = decodeTestLogs(result(Array.from({ length: 129 }, () => PLUGIN_ERROR).join('\n')));
  assert.equal(traces.entries.length, 128);
  assert.equal(traces.truncated, true);
});

test('line and grouped-message caps disclose truncation and preserve full-content IDs', () => {
  assert.equal(decodeTestLogs(result('a'.repeat(2048))).truncated, false);
  const first = decodeTestLogs(result('a'.repeat(2048) + 'one'));
  const second = decodeTestLogs(result('a'.repeat(2048) + 'two'));
  assert.equal(first.entries[0]!.message.length, 2048);
  assert.equal(first.truncated, true);
  assert.equal(first.entries[0]!.message, second.entries[0]!.message);
  assert.notEqual(first.entries[0]!.id, second.entries[0]!.id);
  assert.deepEqual(decodeTestLogs(result('a'.repeat(2048) + 'one')), first);
  const grouped = decodeTestLogs(result('a'.repeat(1024) + '\n' + 'b'.repeat(1024)));
  assert.equal(grouped.entries[0]!.message.length, 2048);
  assert.equal(grouped.truncated, true);
  const longTrace = trace('ServerScriptService.' + 'x'.repeat(480), 7, 5);
  const logs = decodeTestLogs(result(longTrace));
  assert.equal(logs.entries[0]!.level, 'error');
  assert.equal(logs.entries[0]!.message.length, 2048);
  assert.equal(logs.truncated, true);
});

test('Unicode clipping does not split surrogate pairs, normalize content or exceed byte limits', () => {
  const emoji = decodeTestLogs(result('🧪'.repeat(1024)));
  assert.equal(emoji.entries[0]!.message.length, 2048);
  assert.equal(emoji.truncated, false);
  const boundary = decodeTestLogs(result('x'.repeat(2047) + '🧪'));
  assert.equal(boundary.entries[0]!.message.length, 2047);
  assert.equal(boundary.truncated, true);
  assert.doesNotMatch(boundary.entries[0]!.message, /[\ud800-\udfff]/u);
  assert.notEqual(decodeTestLogs(result('é')).entries[0]!.id, decodeTestLogs(result('e\u0301')).entries[0]!.id);
  for (const text of ['a'.repeat(65536), '🧪'.repeat(16384)]) {
    const logs = decodeTestLogs(result(text));
    assert.equal(logs.truncated, true);
    assert.ok(logs.entries[0]!.message.length <= 2048);
    assert.equal(logsSchema.safeParse(logs).success, true);
  }
  const logs = decodeTestLogs(result(Array.from({ length: 128 }, () => '界'.repeat(160)).join('\n\n')));
  assert.equal(logs.entries.length, 128);
  assert.equal(logs.truncated, false);
  assert.ok(logs.entries.reduce((total, entry) => total + Buffer.byteLength(entry.message), 0) <= 65536);
});

test('decoders leave frozen response and witness inputs unchanged and return fresh values', () => {
  const input = Object.freeze({ content: Object.freeze([Object.freeze({ type: 'text', text: EDIT })]) });
  const first = decodeTestState(input, WITNESS);
  first.datamodels.push('Client');
  assert.deepEqual(decodeTestState(input, WITNESS), { ...WITNESS, mode: 'Edit', datamodels: ['Edit'] });
  const logInput = Object.freeze({ content: Object.freeze([Object.freeze({ type: 'text', text: PLUGIN_ERROR })]) });
  const logs = decodeTestLogs(logInput);
  logs.entries[0]!.message = 'changed';
  assert.equal(decodeTestLogs(logInput).entries[0]!.message, PLUGIN_ERROR);
});
