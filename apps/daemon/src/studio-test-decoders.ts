import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, identifier, type NativeTestState } from '../../../packages/studio-test-controller/src/contracts.js';

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;
const MAX_MESSAGE = 2048;
const MAX_TRACE_FRAMES = 32;
const responseSchema = z.strictObject({
  content: z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).length(1),
  isError: z.literal(false).optional(),
});
const inventorySchema = z.strictObject({
  studios: z.array(z.strictObject({ id: identifier, name: z.string().max(512) })).max(64),
});
const witnessSchema = z.strictObject({ nativeStudioId: identifier, placeId: z.literal(0) });

export type TestNativeWitness = Readonly<{ nativeStudioId: string; placeId: 0 }>;
export interface DecodedTestLogs {
  entries: { id: string; level: 'info' | 'error'; message: string }[];
  truncated: boolean;
}

function dataRecord(value: unknown, required: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return required.every(key => Object.hasOwn(fields, key)) &&
    Object.values(fields).every(field => Object.hasOwn(field, 'value'));
}

function validText(text: string): boolean {
  // In Unicode mode this surrogate range matches ONLY unpaired surrogates.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(text);
}

/** Only the observed single successful text envelope is supported. No alternate
 * structured, resource, image, HTML, or fenced response supplies evidence. The
 * aggregate text payload is limited to 64 KiB of UTF-8, before normalization. */
function responseText(result: unknown): string {
  if (!dataRecord(result, ['content']) ||
      (Object.hasOwn(result, 'isError') && result.isError !== false) ||
      !Array.isArray(result.content) || result.content.length !== 1) fail('BAD_NATIVE_RESPONSE');
  const item = Object.getOwnPropertyDescriptor(result.content, '0');
  if (!item || !Object.hasOwn(item, 'value') || !dataRecord(item.value, ['type', 'text'])) fail('BAD_NATIVE_RESPONSE');
  const parsed = responseSchema.safeParse(result);
  if (!parsed.success) fail('BAD_NATIVE_RESPONSE');
  const text = parsed.data.content[0]!.text;
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES || !validText(text) ||
      /\r(?!\n)/u.test(text) ||
      /<\/?(?:html|head|body|script|title|div|span|p|pre|h[1-6])(?:\s|>)/iu.test(text) ||
      /<!doctype\s+html\b|<\?xml\b/iu.test(text)) fail('BAD_NATIVE_RESPONSE');
  return text.replace(/\r\n/gu, '\n');
}

/** JSON.parse otherwise silently accepts duplicate keys, including escaped key
 * spellings. Scan already valid JSON, skipping string values and their escapes. */
function rejectDuplicateKeys(text: string): void {
  const objects: Set<string>[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '{') objects.push(new Set());
    else if (char === '}') objects.pop();
    else if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index++;
        index++;
      }
      let next = index + 1;
      while (/\s/u.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        const keys = objects.at(-1);
        if (typeof key !== 'string' || !keys || keys.has(key)) fail('BAD_NATIVE_RESPONSE');
        keys.add(key);
      }
    }
  }
}

/** Decode the native {studios:[{id,name}]} text JSON. Names are display data;
 * neither a name nor inventory membership corroborates a place ID. */
export function decodeTestInventory(result: unknown): { id: string; name: string }[] {
  const text = responseText(result);
  let json: unknown;
  try { json = JSON.parse(text); } catch { fail('BAD_NATIVE_RESPONSE'); }
  const parsed = inventorySchema.safeParse(json);
  if (!parsed.success) fail('BAD_NATIVE_RESPONSE');
  rejectDuplicateKeys(text);
  const studios = parsed.data.studios;
  if (new Set(studios.map(studio => studio.id)).size !== studios.length ||
      studios.some(studio => !validText(studio.name))) fail('BAD_NATIVE_RESPONSE');
  return studios;
}

/** TRUSTED HOST ARGUMENT: the parent service must independently corroborate the
 * exact nativeStudioId and actualPlaceId using its fixed native Lua metadata
 * read, then bind this witness in a constructor closure for that exact request.
 * A request body, selected Studio, window name, or the state text cannot supply
 * it. Shape validation here cannot authenticate provenance or check freshness.
 * There is deliberately no missing-witness/default-place fallback. */
export function decodeTestState(result: unknown, witness: unknown): NativeTestState {
  if (!dataRecord(witness, ['nativeStudioId', 'placeId'])) fail('BAD_NATIVE_RESPONSE');
  const parsedWitness = witnessSchema.safeParse(witness);
  if (!parsedWitness.success) fail('BAD_NATIVE_RESPONSE');
  return { ...parsedWitness.data, ...decodeTestMode(result) };
}
/** Mode-only parsing supplies no place identity or permission. */
export function decodeTestMode(result: unknown): Pick<NativeTestState,'mode'|'datamodels'> {
  const text = responseText(result);
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const prefixes = ['- Current Studio Mode: ', '- Available DataModels: ', '- Focused DataModel in the viewport: '];
  if (lines.length !== 3 || lines.some((line, index) => !line.startsWith(prefixes[index]!))) fail('BAD_NATIVE_RESPONSE');
  const mode = lines[0]!.slice(prefixes[0]!.length);
  const available = lines[1]!.slice(prefixes[1]!.length);
  const focused = lines[2]!.slice(prefixes[2]!.length);
  let datamodels: NativeTestState['datamodels'];
  if (mode === 'Edit' && available === 'Edit' && focused === 'Edit') datamodels = ['Edit'];
  else if (mode === 'Play' && /^(?:Client, Server|Client,Server)$/u.test(available) &&
           (focused === 'Client' || focused === 'Server')) datamodels = ['Client', 'Server'];
  else fail('BAD_NATIVE_RESPONSE');
  return { mode, datamodels };
}

// HOST classification of untrusted text, never native severity metadata. A
// source/line header plus matching first stack frame also recognizes custom
// error()/assert() messages. Familiar Luau failures can appear without a stack
// (notably syntax errors); arbitrary source/line messages alone remain unknown.
// MCP docs promise output retrieval, not a severity or completeness contract:
// https://create.roblox.com/docs/studio/mcp
const errorHeader = /^([^\s:\n][^:\n]{0,511}):([1-9][0-9]{0,8}): ([^\n]+)$/u;
const failureMessage = /^(?:attempt to (?:index|call|perform arithmetic|compare|concatenate|get length|iterate)\b|(?:invalid|bad) argument #[1-9][0-9]*\b|assertion failed(?:!|:|$)|(?:C )?stack overflow\b|maximum recursion depth exceeded\b|Requested module experienced an error while loading\b|Module code did not return exactly one value\b|[^\n]{1,512} is not a valid member of\b|Expected (?:identifier\b|expression\b|["']|<eof>)|Incomplete statement:|(?:Malformed|Unfinished) (?:string|number)\b|Unexpected (?:symbol|token)\b|Ambiguous syntax\b|Cannot use ['"]\.\.\.['"] outside|[Ss]yntax error\b)/u;
const stackFrame = /^Script (?:'([^'\n]{1,512})'|([^'\n]{1,512})), Line ([1-9][0-9]{0,8})(?: - function [A-Za-z_][A-Za-z0-9_.:]*)?$/u;

function diagnosticAt(lines: readonly string[], start: number): {
  end: number; message: string; fullMessage: string; truncated: boolean;
} | undefined {
  const header = errorHeader.exec(lines[start]!);
  if (!header) return undefined;
  const knownFailure = failureMessage.test(header[3]!);
  const first = stackFrame.exec(lines[start + 2] ?? '');
  const hasStack = lines[start + 1] === 'Stack Begin' && first &&
    (first[1] ?? first[2]) === header[1] && first[3] === header[2];
  if (!hasStack) {
    if (!knownFailure) return undefined;
    return { end: start, message: lines[start]!, fullMessage: lines[start]!,
      truncated: lines[start + 1] === 'Stack Begin' };
  }
  let index = start + 2, count = 0;
  // Scan work remains bounded by the validated 64-KiB input. Only 32 frames
  // are retained, while the HOST ID hashes the complete original diagnostic.
  while (index < lines.length) {
    const line = lines[index]!;
    const frame = stackFrame.exec(line);
    if (!frame) break;
    count++;
    index++;
    if (lines[index] === 'Stack End') break;
  }
  const complete = lines[index] === 'Stack End';
  const end = complete ? index : index - 1;
  const retained = lines.slice(start, start + 2 + Math.min(count, MAX_TRACE_FRAMES));
  if (complete) retained.push('Stack End');
  return { end, message: retained.join('\n'), fullMessage: lines.slice(start, end + 1).join('\n'),
    truncated: !complete || count > MAX_TRACE_FRAMES };
}

function clipMessage(message: string): string {
  let end = Math.min(message.length, MAX_MESSAGE);
  // Match the controller's UTF-16 length limit without bisecting a scalar value.
  if (end < message.length && /[\ud800-\udbff]/u.test(message[end - 1]!)) end--;
  return message.slice(0, end);
}

/** Native plain text carries NO severity, timestamps, message boundaries or
 * vendor IDs. Recognized Luau failures and matching traces are error diagnostics;
 * contiguous remaining nonblank lines form info diagnostics (severity unknown).
 * Even a recognized trace is untrusted console text, NOT authoritative evidence
 * of a game error: scripts/plugins can print a convincing trace themselves.
 *
 * IDs are LOCAL synthetic SHA-256(level + full normalized block) + per-content
 * occurrence, not vendor IDs/cursors. They are deterministic for repeated
 * snapshots, preserve duplicate occurrences, and do not depend on other blocks
 * or on clipping. A changed/rolling partial block has no native continuity proof.
 * Any message, frame or entry cap, or incomplete stack, sets truncated;
 * over-64-KiB input is rejected. No snapshot establishes exhaustive coverage. */
export function decodeTestLogs(result: unknown): DecodedTestLogs {
  const text = responseText(result);
  if (/^\s*```/u.test(text)) fail('BAD_NATIVE_RESPONSE');
  if (/^\s*[\[{]/u.test(text)) {
    let json: unknown;
    try { json = JSON.parse(text); } catch { /* A bracketed plain message is diagnostic text. */ }
    if (json !== null && typeof json === 'object') fail('BAD_NATIVE_RESPONSE');
  }
  const lines = text.split('\n');
  const entries: DecodedTestLogs['entries'] = [];
  const occurrences = new Map<string, number>();
  let truncated = false;
  const add = (level: 'info' | 'error', message: string, fullMessage = message): void => {
    if (entries.length === MAX_ENTRIES) { truncated = true; return; }
    const hash = createHash('sha256').update(level).update('\0').update(fullMessage, 'utf8').digest('hex');
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    const clipped = clipMessage(message);
    truncated ||= clipped.length !== message.length;
    entries.push({ id: `local_${hash}_${occurrence}`, level, message: clipped });
  };
  let plainStart: number | undefined;
  const flushPlain = (end: number): void => {
    if (plainStart !== undefined) add('info', lines.slice(plainStart, end).join('\n'));
    plainStart = undefined;
  };
  for (let index = 0; index < lines.length; index++) {
    const diagnostic = diagnosticAt(lines, index);
    if (diagnostic) {
      flushPlain(index);
      truncated ||= diagnostic.truncated;
      add('error', diagnostic.message, diagnostic.fullMessage);
      index = diagnostic.end;
    } else if (lines[index]!.trim() === '') flushPlain(index);
    else plainStart ??= index;
  }
  flushPlain(lines.length);
  return { entries, truncated };
}

/** Companion for the main runner; the existing strict log contract stays intact.
 * This is a HOST coverage assessment, not metadata returned by Studio. Even an
 * empty snapshot or one consisting entirely of recognized failures lacks native
 * severity, message boundaries and proof of exhaustive console coverage. Keep
 * this flag when deciding whether an observation establishes a clean run. */
export function decodeTestLogDiagnostics(result: unknown): { logs: DecodedTestLogs; coverage: 'ambiguous' } {
  return { logs: decodeTestLogs(result), coverage: 'ambiguous' };
}
