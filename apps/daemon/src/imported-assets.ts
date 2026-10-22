/**
 * Imported assets: local 3D models and Roblox effect packages the person chose in the desktop file picker or dropped
 * on the preview ("Imported by you"). This is a store of its own, separate from generated asset jobs. An import has no
 * job id, manifest, model review, provenance record or Studio placement, so it can never stand in for a generated
 * model, and nothing here uploads to Roblox or talks to Studio.
 *
 * POST /v1/imports/upload?format=glb|gltf|rbxmx&name=<file name>
 *      Raw file bytes. Needs the human launcher bearer AND a single-use import consent that the desktop main process
 *      delivered over the private child IPC channel just before (the renderer, agents and models cannot reach it).
 * GET  /v1/imports                     Every import, newest first.
 * GET  /v1/imports/file?id=<uuid>      The stored bytes: model/gltf-binary for models, application/xml for effects.
 * POST /v1/imports/remove {"id"}       Deletes one import (from the workspace page only).
 *
 * Files live under <state>/imported-assets/<uuid>/ as record.json plus asset.glb or effect.rbxmx. A .gltf is stored
 * packed into one GLB. Every model passes the same GLB preflight as the viewer; every effect package is parsed with a
 * bounded scanner (no DTDs, entities or external references) and only Arcane's effect allowlist is kept.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateGlb, GLB_PREFLIGHT_LIMITS, type GlbMetadata } from '../../desktop/src/glb-preflight.js';
import { EFFECT_PROPERTIES } from '../../../packages/core/src/studio-policy.js';
import { noLinks } from '../../../packages/asset-pipeline/src/paths.js';

export const IMPORT_CONSENT_MESSAGE = 'arcane-asset-import-consent';
export const IMPORT_LIMITS = Object.freeze({
  modelBytes: GLB_PREFLIGHT_LIMITS.bytes, gltfBytes: 96 * 1024 * 1024, effectBytes: 8 * 1024 * 1024,
  imports: 128, totalBytes: 1024 * 1024 * 1024, recordBytes: 512 * 1024, consents: 8, consentMs: 60_000, consentWaitMs: 2000,
  xmlDepth: 96, xmlItems: 8192, effectItems: 64, nameLength: 80,
});
export type ImportFormat = 'glb' | 'gltf' | 'rbxmx';
export type ImportKind = 'model' | 'effect';
export interface ImportedModelStats { triangles: number; meshes: number; materials: number; textures: number; animations: number; nodes: number }
export type EffectValue = boolean | number | string | number[] | { min: number; max: number } | { keys: number[][] } | { colors: number[][] };
export interface ImportedEffectItem {
  className: string; name: string; parent: string | null;
  /** Emitter origin in studs (attachment or host part centre), and the host part's size for area emitters. */
  position: [number, number, number]; area: [number, number, number] | null;
  props: Record<string, EffectValue>;
}
export interface ImportedEffect { items: ImportedEffectItem[]; scripts: number; otherClasses: string[]; clamped: string[]; truncated: boolean }
export interface ImportedAssetRecord {
  schemaVersion: 1; id: string; source: 'imported'; kind: ImportKind; format: ImportFormat;
  name: string; fileName: string; bytes: number; sha256: string; importedAt: string;
  model: ImportedModelStats | null; effect: ImportedEffect | null;
}
export class ImportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'ImportError'; }
}
const refuse = (code: string, message: string, status = 400): never => { throw new ImportError(code, message, status); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** Display name from the chosen file name: no folders, controls or bidi overrides, bounded. */
export function importDisplayName(fileName: unknown): { name: string; fileName: string } {
  if (typeof fileName !== 'string') refuse('INPUT', 'The file name is missing.');
  const leaf = (fileName as string).split(/[\\/]/).pop() ?? '';
  const clean = leaf.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!clean || clean === '.' || clean === '..') refuse('INPUT', 'The file name is missing.');
  const stem = clean.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_]+/g, ' ').trim() || clean;
  return { name: stem.slice(0, IMPORT_LIMITS.nameLength), fileName: clean };
}

// ---- Models -------------------------------------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
function glbJson(bytes: Uint8Array): Json {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(12, true);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + length));
  const value = JSON.parse(text) as unknown; if (!isObject(value)) refuse('MODEL', 'The model file is not a glTF scene.');
  return value as Json;
}
/** GLB bytes -> preflight metadata and the facts the viewer shows. Refuses anything the viewer would refuse. */
export function readImportedModel(bytes: Uint8Array): { metadata: GlbMetadata; stats: ImportedModelStats } {
  if (bytes.byteLength < 20 || bytes.byteLength > IMPORT_LIMITS.modelBytes) refuse('MODEL', 'The model is empty or larger than 64 MB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) refuse('MODEL', 'This is not a GLB file. Its first bytes are not a glTF binary header.');
  if (view.getUint32(4, true) !== 2) refuse('MODEL', 'Only glTF 2.0 models can be imported.');
  let metadata: GlbMetadata;
  try { metadata = validateGlb(bytes); }
  catch { return refuse('MODEL', 'Arcane can’t preview this model safely. Re-export it as a GLB with embedded textures and no compression.'); }
  const json = glbJson(bytes), length = (key: string) => Array.isArray(json[key]) ? (json[key] as unknown[]).length : 0;
  return { metadata, stats: { triangles: metadata.triangleEstimate, meshes: metadata.meshCount, materials: length('materials'), textures: length('images'), animations: metadata.animations, nodes: metadata.nodeCount } };
}
const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+)?(;[a-z0-9-]+=[^;,]*)*;base64,/i;
function decodeDataUri(uri: string, what: string): { mime: string; bytes: Buffer } {
  const head = DATA_URI.exec(uri);
  if (!head) return refuse('MODEL', 'This .gltf links to a ' + what + ' Arcane could not include. Export it as a GLB.');
  const body = uri.slice(head[0].length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) refuse('MODEL', 'This .gltf has a damaged embedded ' + what + '.');
  return { mime: (head[1] ?? 'application/octet-stream').toLowerCase(), bytes: Buffer.from(body, 'base64') };
}
const align4 = (n: number) => (n + 3) & ~3;
/** A .gltf whose buffers and images are embedded data URIs (the desktop host inlines sibling files) -> one GLB. */
export function packGltf(input: Uint8Array): Uint8Array {
  if (input.byteLength < 2 || input.byteLength > IMPORT_LIMITS.gltfBytes) refuse('MODEL', 'The .gltf and its files are larger than 96 MB together.');
  let json: Json;
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)) as unknown; if (!isObject(value)) throw new Error(); json = value; }
  catch { return refuse('MODEL', 'This .gltf file is not valid JSON.'); }
  const asset = json.asset; if (!isObject(asset) || asset.version !== '2.0') refuse('MODEL', 'Only glTF 2.0 models can be imported.');
  const buffers = Array.isArray(json.buffers) ? json.buffers : [], views = Array.isArray(json.bufferViews) ? json.bufferViews : [], images = Array.isArray(json.images) ? json.images : [];
  if (buffers.length > 64 || images.length > GLB_PREFLIGHT_LIMITS.images || views.length > GLB_PREFLIGHT_LIMITS.bufferViews) refuse('MODEL', 'This .gltf has more buffers or images than Arcane previews.');
  const parts: Buffer[] = [], bases: number[] = []; let total = 0;
  const append = (bytes: Buffer) => { const base = total; parts.push(bytes); total += bytes.length; const pad = align4(total) - total; if (pad) { parts.push(Buffer.alloc(pad)); total += pad; } return base; };
  for (const [index, buffer] of buffers.entries()) {
    if (!isObject(buffer) || typeof buffer.uri !== 'string' || !Number.isSafeInteger(buffer.byteLength)) refuse('MODEL', 'This .gltf has a buffer Arcane could not include. Export it as a GLB.');
    const { bytes } = decodeDataUri((buffer as Json).uri as string, 'buffer');
    if (bytes.length < (buffer as { byteLength: number }).byteLength) refuse('MODEL', 'Buffer ' + index + ' of this .gltf is shorter than it says.');
    bases.push(append(bytes));
  }
  for (const view of views) {
    if (!isObject(view) || !Number.isSafeInteger(view.buffer) || (view.buffer as number) < 0 || (view.buffer as number) >= bases.length) refuse('MODEL', 'This .gltf has a broken buffer view.');
    const offset = view.byteOffset === undefined ? 0 : view.byteOffset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) refuse('MODEL', 'This .gltf has a broken buffer view.');
    view.byteOffset = bases[view.buffer as number]! + (offset as number); view.buffer = 0;
  }
  for (const image of images) {
    if (!isObject(image) || image.uri === undefined) continue;
    if (typeof image.uri !== 'string') refuse('MODEL', 'This .gltf has a broken image.');
    const { mime, bytes } = decodeDataUri(image.uri as string, 'texture');
    const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) refuse('MODEL', 'Textures must be PNG or JPEG. ' + (mime.startsWith('image/') ? 'This one is ' + mime.slice(6).toUpperCase() + '.' : ''));
    const base = append(bytes);
    views.push({ buffer: 0, byteOffset: base, byteLength: bytes.length });
    delete image.uri; image.bufferView = views.length - 1; image.mimeType = png ? 'image/png' : 'image/jpeg';
  }
  if (views.length) json.bufferViews = views;
  if (total) json.buffers = [{ byteLength: total }]; else delete json.buffers;
  const text = Buffer.from(JSON.stringify(json), 'utf8'), jsonLength = align4(text.length), binLength = align4(total);
  const length = 12 + 8 + jsonLength + (total ? 8 + binLength : 0);
  if (length > IMPORT_LIMITS.modelBytes) refuse('MODEL', 'The packed model is larger than 64 MB.');
  const out = Buffer.alloc(length, 0), view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, GLB_MAGIC, true); view.setUint32(4, 2, true); view.setUint32(8, length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, JSON_CHUNK, true); text.copy(out, 20); out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (total) {
    const at = 20 + jsonLength; view.setUint32(at, binLength, true); view.setUint32(at + 4, BIN_CHUNK, true);
    let cursor = at + 8; for (const part of parts) { part.copy(out, cursor); cursor += part.length; }
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

// ---- Effects (Roblox XML model files) -------------------------------------------------------------------------------

interface XmlNode { tag: string; attrs: Record<string, string>; text: string; children: XmlNode[] }
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function entities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, body: string) => {
    if (body.startsWith('#')) { const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }
    return ENTITIES[body] ?? whole;
  });
}
/** Bounded XML scanner for Roblox .rbxmx: elements, attributes, text and CDATA. DTDs and entity declarations are refused. */
export function parseRobloxXml(text: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, text: '', children: [] }, stack: XmlNode[] = [root];
  let index = 0, elements = 0;
  const fail = (): never => refuse('EFFECT', 'This .rbxmx file is damaged or is not a Roblox model file.');
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    if (lt < 0) { stack[stack.length - 1]!.text += entities(text.slice(index)); break; }
    if (lt > index) { const top = stack[stack.length - 1]!; if (top.text.length < 1_000_000) top.text += entities(text.slice(index, lt)); }
    if (text.startsWith('<!--', lt)) { const end = text.indexOf('-->', lt + 4); if (end < 0) fail(); index = end + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const end = text.indexOf(']]>', lt + 9); if (end < 0) fail(); const top = stack[stack.length - 1]!; if (top.text.length < 1_000_000) top.text += text.slice(lt + 9, end); index = end + 3; continue; }
    if (text.startsWith('<?', lt)) { const end = text.indexOf('?>', lt + 2); if (end < 0) fail(); index = end + 2; continue; }
    if (text.startsWith('<!', lt)) refuse('EFFECT', 'This .rbxmx declares a document type. Arcane does not read those.');
    const gt = text.indexOf('>', lt); if (gt < 0) fail();
    const body = text.slice(lt + 1, gt);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim(), top = stack.pop();
      if (!top || top.tag !== name || !stack.length) fail();
      index = gt + 1; continue;
    }
    const selfClosing = body.endsWith('/'), inner = selfClosing ? body.slice(0, -1) : body;
    const match = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(inner); if (!match) fail();
    const attrs: Record<string, string> = {}, pattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let rest = match![2]!, consumed = 0, attr: RegExpExecArray | null;
    while ((attr = pattern.exec(rest))) { if (attr.index !== consumed) fail(); attrs[attr[1]!] = entities(attr[3] ?? attr[4] ?? ''); consumed = pattern.lastIndex; }
    if (rest.slice(consumed).trim()) fail();
    if (++elements > IMPORT_LIMITS.xmlItems * 64) refuse('EFFECT', 'This .rbxmx file is too large to read.');
    const node: XmlNode = { tag: match![1]!, attrs, text: '', children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) { stack.push(node); if (stack.length > IMPORT_LIMITS.xmlDepth) refuse('EFFECT', 'This .rbxmx file nests too deeply to read.'); }
    index = gt + 1;
  }
  if (stack.length !== 1) fail();
  const top = root.children.filter(node => node.tag === 'roblox');
  if (top.length !== 1 || root.children.length !== 1) fail();
  return top[0]!;
}
const ENUMS: Record<string, string[]> = {
  NormalId: ['Right', 'Top', 'Back', 'Left', 'Bottom', 'Front'],
  ParticleOrientation: ['FacingCamera', 'FacingCameraWorldUp', 'VelocityParallel', 'VelocityPerpendicular'],
  ParticleEmitterShape: ['Box', 'Sphere', 'Cylinder', 'Disc'],
  ParticleEmitterShapeStyle: ['Volume', 'Surface'],
  ParticleEmitterShapeInOut: ['Outward', 'Inward', 'InAndOut'],
  TextureMode: ['Stretch', 'Wrap', 'Static'],
  HighlightDepthMode: ['AlwaysOnTop', 'Occluded'],
};
type Spec = string | readonly unknown[];
const PREVIEW_CLASSES = new Set(['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'SurfaceLight', 'Fire', 'Smoke', 'Sparkles', 'Highlight']);
const SCRIPTS = new Set(['Script', 'LocalScript', 'ModuleScript']);
const numbers = (text: string): number[] => text.trim() ? text.trim().split(/\s+/).map(Number) : [];
const finite = (values: number[]) => values.every(Number.isFinite);
const child = (node: XmlNode, tag: string) => node.children.find(item => item.tag === tag);
const props = (item: XmlNode) => new Map((child(item, 'Properties')?.children ?? []).map(node => [node.attrs.name ?? '', node] as const));
function vectorOf(node: XmlNode | undefined, keys: string[]): number[] | null {
  if (!node) return null;
  const values = keys.map(key => Number(child(node, key)?.text.trim()));
  return values.length && finite(values) ? values : null;
}
/** CFrame -> position and rotation rows (R00..R22), or null. */
function frameOf(node: XmlNode | undefined): { p: number[]; r: number[] } | null {
  const p = vectorOf(node, ['X', 'Y', 'Z']), r = vectorOf(node, ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']);
  return p ? { p, r: r ?? [1, 0, 0, 0, 1, 0, 0, 0, 1] } : null;
}
function colourOf(node: XmlNode): number[] | null {
  if (node.tag === 'Color3uint8') { const packed = Number(node.text.trim()); if (!Number.isSafeInteger(packed) || packed < 0) return null; return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255].map(v => v / 255); }
  const rgb = vectorOf(node, ['R', 'G', 'B']); return rgb && rgb.every(v => v >= 0 && v <= 1) ? rgb : null;
}
const clampTo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** One property, converted to Arcane's effect shapes and limits (EFFECT_PROPERTIES). Null when absent or unreadable. */
function propertyOf(node: XmlNode, spec: Spec, note: (what: string) => void): EffectValue | null {
  const kind = typeof spec === 'string' ? spec : spec[0] as string, min = typeof spec === 'string' ? -Infinity : Number(spec[1]), max = typeof spec === 'string' ? Infinity : Number(spec[2]);
  const bounded = (value: number) => { const out = clampTo(value, min, max); if (out !== value) note('out'); return out; };
  switch (kind) {
    case 'boolean': return node.text.trim() === 'true' ? true : node.text.trim() === 'false' ? false : null;
    case 'number': case 'integer': { const value = Number(node.text.trim()); return Number.isFinite(value) ? bounded(kind === 'integer' ? Math.round(value) : value) : null; }
    case 'range': { const [a, b] = numbers(node.text); return a !== undefined && b !== undefined && finite([a, b]) ? { min: bounded(Math.min(a, b)), max: bounded(Math.max(a, b)) } : null; }
    case 'vector2': { const v = vectorOf(node, ['X', 'Y']); return v ? v.map(bounded) : null; }
    case 'vector3': { const v = vectorOf(node, ['X', 'Y', 'Z']); return v ? v.map(bounded) : null; }
    case 'color': return colourOf(node);
    case 'sequence': {
      const values = numbers(node.text); if (values.length < 6 || values.length % 3 || values.length > 60 || !finite(values)) return null;
      const keys: number[][] = []; for (let i = 0; i < values.length; i += 3) keys.push([clampTo(values[i]!, 0, 1), bounded(values[i + 1]!), Math.abs(values[i + 2]!)]);
      return { keys };
    }
    case 'colorSequence': {
      const values = numbers(node.text); if (values.length < 10 || values.length % 5 || values.length > 100 || !finite(values)) return null;
      const colors: number[][] = []; for (let i = 0; i < values.length; i += 5) colors.push([clampTo(values[i]!, 0, 1), ...[values[i + 1]!, values[i + 2]!, values[i + 3]!].map(v => clampTo(v, 0, 1))]);
      return { colors };
    }
    case 'enum': {
      const names = ENUMS[String((spec as readonly unknown[])[1])], token = Number(node.text.trim());
      return names && Number.isSafeInteger(token) && names[token] ? names[token] : null;
    }
    case 'content': {
      const url = (child(node, 'url')?.text ?? node.text).trim();
      return /^(?:rbxasset:\/\/[A-Za-z0-9_./-]{1,200}|rbxassetid:\/\/[0-9]{1,20})$/.test(url) ? url : null;
    }
    default: return null;
  }
}
/** .rbxmx text -> Arcane's effect description: allowlisted classes and properties, emitter positions, honest notes. */
export function readImportedEffect(bytes: Uint8Array): ImportedEffect {
  if (bytes.byteLength < 8 || bytes.byteLength > IMPORT_LIMITS.effectBytes) refuse('EFFECT', 'The effect file is empty or larger than 8 MB.');
  if (Buffer.from(bytes.subarray(0, 8)).toString('latin1') === '<roblox!') refuse('EFFECT', 'This is a binary .rbxm file. In Roblox Studio, save the effect as a .rbxmx (XML) file and import that.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { return refuse('EFFECT', 'This .rbxmx file is not readable text.'); }
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<roblox[\s>]/.test(text)) refuse('EFFECT', 'This is not a Roblox model file. Its first element is not <roblox>.');
  const root = parseRobloxXml(text), items: ImportedEffectItem[] = [], other = new Set<string>(), clamped = new Set<string>();
  let scripts = 0, seen = 0, truncated = false;
  const walk = (node: XmlNode, frame: { p: number[]; r: number[] }, parent: { name: string; size: number[] | null } | null) => {
    for (const item of node.children) {
      if (item.tag !== 'Item') continue;
      if (++seen > IMPORT_LIMITS.xmlItems) { truncated = true; return; }
      const className = item.attrs.class ?? '', p = props(item), name = (p.get('Name')?.text ?? className).replace(UNSAFE, ' ').trim().slice(0, 80) || className;
      let next = frame, host = parent;
      if (SCRIPTS.has(className)) scripts++;
      if (className === 'Attachment') {
        const local = frameOf(p.get('CFrame')) ?? { p: vectorOf(p.get('Position'), ['X', 'Y', 'Z']) ?? [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
        const r = frame.r, l = local.p;
        next = { p: [0, 1, 2].map(i => frame.p[i]! + r[i * 3]! * l[0]! + r[i * 3 + 1]! * l[1]! + r[i * 3 + 2]! * l[2]!), r: frame.r };
        host = { name, size: null };
      } else if (p.has('CFrame') && (p.has('size') || p.has('Size'))) {
        next = frameOf(p.get('CFrame')) ?? frame;
        host = { name, size: vectorOf(p.get('size') ?? p.get('Size'), ['X', 'Y', 'Z']) };
      }
      if (PREVIEW_CLASSES.has(className)) {
        if (items.length >= IMPORT_LIMITS.effectItems) truncated = true;
        else {
          const allowed = EFFECT_PROPERTIES[className as keyof typeof EFFECT_PROPERTIES] as unknown as Record<string, Spec>, values: Record<string, EffectValue> = {};
          for (const [key, spec] of Object.entries(allowed)) {
            const node = p.get(key); if (!node) continue;
            const value = propertyOf(node, spec, () => clamped.add(className + '.' + key)); if (value !== null) values[key] = value;
          }
          const position = next.p.map(v => Number.isFinite(v) && Math.abs(v) < 1e6 ? v : 0) as [number, number, number];
          const area = host?.size && host.size.every(v => Number.isFinite(v) && v >= 0 && v < 1e5) ? host.size as [number, number, number] : null;
          items.push({ className, name, parent: host?.name ?? null, position, area, props: values });
        }
      } else if (!SCRIPTS.has(className) && !['Part', 'MeshPart', 'Model', 'Folder', 'Attachment', 'WedgePart', 'UnionOperation'].includes(className) && other.size < 16 && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(className)) other.add(className);
      walk(item, next, host);
    }
  };
  walk(root, { p: [0, 0, 0], r: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, null);
  if (!items.length) refuse('EFFECT', 'This file has no particle emitters, beams, trails or lights to preview.');
  return { items, scripts, otherClasses: [...other].sort(), clamped: [...clamped].sort().slice(0, 32), truncated };
}

// ---- Store and routes -------------------------------------------------------------------------------------------------

function readRecord(value: unknown, id: string): ImportedAssetRecord | null {
  if (!isObject(value)) return null;
  const r = value as Partial<ImportedAssetRecord> & Json;
  if (r.schemaVersion !== 1 || r.id !== id || r.source !== 'imported' || (r.kind !== 'model' && r.kind !== 'effect') || !['glb', 'gltf', 'rbxmx'].includes(String(r.format))
    || typeof r.name !== 'string' || typeof r.fileName !== 'string' || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 1 || typeof r.sha256 !== 'string' || !HEX64.test(r.sha256)
    || typeof r.importedAt !== 'string' || !Number.isFinite(Date.parse(r.importedAt)) || (r.kind === 'model') !== isObject(r.model) || (r.kind === 'effect') !== isObject(r.effect)) return null;
  return r as ImportedAssetRecord;
}
const fileOf = (kind: ImportKind) => kind === 'model' ? 'asset.glb' : 'effect.rbxmx';
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit) refuse('STORE', 'A stored import is missing or damaged.', 409);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); if (stat.ino !== before.ino || stat.size !== before.size) refuse('STORE', 'A stored import changed while reading.', 409);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) refuse('STORE', 'A stored import changed while reading.', 409); offset += bytesRead; }
    return bytes;
  } finally { await handle.close(); }
}

export function createImportedAssets(options: { stateDirectory: string; now?: () => number }) {
  const root = join(options.stateDirectory, 'imported-assets'), now = options.now ?? Date.now;
  const consents = new Map<string, number>(); let channel = false, queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next; };
  async function ensureRoot(): Promise<void> { await mkdir(root, { recursive: true }); await noLinks(root); }
  async function list(): Promise<ImportedAssetRecord[]> {
    await ensureRoot();
    const records: ImportedAssetRecord[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name) || records.length >= IMPORT_LIMITS.imports * 2) continue;
      try {
        const record = readRecord(JSON.parse((await readBounded(join(root, entry.name, 'record.json'), IMPORT_LIMITS.recordBytes)).toString('utf8')) as unknown, entry.name);
        if (record) records.push(record);
      } catch { /* A half-written or damaged import is skipped, never repaired from the request. */ }
    }
    return records.sort((a, b) => b.importedAt.localeCompare(a.importedAt) || a.id.localeCompare(b.id));
  }
  async function find(id: string): Promise<ImportedAssetRecord> {
    if (!UUID.test(id)) refuse('INPUT', 'Unknown import.', 404);
    const record = (await list()).find(item => item.id === id); if (!record) refuse('NOT_FOUND', 'That import was removed.', 404);
    return record!;
  }
  /** Validated bytes -> a new record (or the existing one for identical bytes). */
  async function add(format: ImportFormat, fileName: string, input: Uint8Array): Promise<{ record: ImportedAssetRecord; duplicate: boolean }> {
    const names = importDisplayName(fileName);
    const kind: ImportKind = format === 'rbxmx' ? 'effect' : 'model';
    const bytes = format === 'gltf' ? packGltf(input) : input;
    const model = kind === 'model' ? readImportedModel(bytes).stats : null, effect = kind === 'effect' ? readImportedEffect(bytes) : null;
    const digest = sha(bytes);
    return serial(async () => {
      const existing = await list(), same = existing.find(item => item.sha256 === digest && item.kind === kind);
      if (same) return { record: same, duplicate: true };
      if (existing.length >= IMPORT_LIMITS.imports) refuse('LIMIT', 'Arcane keeps up to ' + IMPORT_LIMITS.imports + ' imports. Remove some first.', 409);
      if (existing.reduce((sum, item) => sum + item.bytes, 0) + bytes.byteLength > IMPORT_LIMITS.totalBytes) refuse('LIMIT', 'Imports are limited to 1 GB in total. Remove some first.', 409);
      const id = randomUUID(), record: ImportedAssetRecord = { schemaVersion: 1, id, source: 'imported', kind, format, name: names.name, fileName: names.fileName,
        bytes: bytes.byteLength, sha256: digest, importedAt: new Date(now()).toISOString(), model, effect };
      const text = JSON.stringify(record); if (Buffer.byteLength(text) > IMPORT_LIMITS.recordBytes) refuse('EFFECT', 'This effect has more detail than Arcane can list.');
      const staging = join(root, '.staging-' + id);
      try {
        await mkdir(staging);
        await writeFile(join(staging, fileOf(kind)), bytes, { flag: 'wx' });
        await writeFile(join(staging, 'record.json'), text, { flag: 'wx' });
        await rename(staging, join(root, id));
      } catch (error) { await rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
      return { record, duplicate: false };
    });
  }
  async function remove(id: string): Promise<void> {
    await serial(async () => { const record = await find(id); await rm(join(root, record.id), { recursive: true, force: true }); });
  }
  async function file(id: string): Promise<{ record: ImportedAssetRecord; bytes: Buffer }> {
    const record = await find(id), bytes = await readBounded(join(root, id, fileOf(record.kind)), record.kind === 'model' ? IMPORT_LIMITS.modelBytes : IMPORT_LIMITS.effectBytes);
    if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) refuse('STORE', 'This import no longer matches what was imported. Remove it and import the file again.', 409);
    return { record, bytes };
  }

  /** Parent IPC only (product-main): the desktop main process announces one upload it is about to make. */
  function acceptConsent(message: unknown): boolean {
    if (!channel || !isObject(message)) return false;
    const m = message as Json;
    if (Object.keys(m).length !== 3 || m.type !== IMPORT_CONSENT_MESSAGE || m.protocolVersion !== 1 || typeof m.consent !== 'string' || !HEX64.test(m.consent)) return false;
    for (const [key, expires] of consents) if (expires <= now()) consents.delete(key);
    if (consents.size >= IMPORT_LIMITS.consents) return false;
    consents.set(sha(m.consent), now() + IMPORT_LIMITS.consentMs); return true;
  }
  async function takeConsent(supplied: string): Promise<void> {
    if (!HEX64.test(supplied)) refuse('IMPORT_CONSENT', 'Imports start from the Arcane file picker or a file dropped on the preview.', 403);
    const key = sha(supplied), deadline = now() + IMPORT_LIMITS.consentWaitMs;
    while (!consents.has(key) && now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const expires = consents.get(key); consents.delete(key);
    if (!expires || expires <= now()) refuse('IMPORT_CONSENT', 'Imports start from the Arcane file picker or a file dropped on the preview.', 403);
  }

  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(JSON.stringify(payload));
  };
  async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
    const length = request.headers['content-length'];
    if (!length || !/^\d{1,10}$/.test(length) || Number(length) < 1 || Number(length) > limit) refuse('BODY_LIMIT', 'The file is empty or too large to import.', 413);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string); bytes += chunk.length;
      if (bytes > Number(length)) refuse('BODY_LIMIT', 'The file is larger than it said.', 413);
      chunks.push(chunk);
    }
    if (bytes !== Number(length)) refuse('BODY', 'The file did not arrive completely.');
    return Buffer.concat(chunks, bytes);
  }
  /** Same literal-loopback, bearer and origin rules as the asset routes. */
  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, controlToken: string, origin: string): Promise<boolean> {
    if (url.pathname !== '/v1/imports' && !url.pathname.startsWith('/v1/imports/')) return false;
    try {
      const expected = new URL(origin), remote = request.socket.remoteAddress;
      if (request.headers.host !== expected.host || (remote && remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1')) refuse('HOST', 'Imports are available on this computer only.', 403);
      const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (!controlToken || Buffer.byteLength(supplied) !== Buffer.byteLength(controlToken) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(controlToken))) refuse('AUTH', 'Imports are available to the Arcane desktop only.', 401);
      if (request.headers.origin !== undefined && request.headers.origin !== origin) refuse('ORIGIN', 'Cross-origin access refused.', 403);
      const site = request.headers['sec-fetch-site']; if (site !== undefined && site !== 'same-origin' && site !== 'none') refuse('ORIGIN', 'Cross-site access refused.', 403);
      const route = url.pathname.slice('/v1/imports'.length), query = [...url.searchParams.keys()];
      const method = new Map([['', 'GET'], ['/file', 'GET'], ['/upload', 'POST'], ['/remove', 'POST']]).get(route);
      if (!method) refuse('NOT_FOUND', 'Unknown import endpoint.', 404);
      if (request.method !== method) { response.setHeader('Allow', method!); refuse('METHOD', 'Expected ' + method + '.', 405); }
      const allowed = route === '/file' ? ['id'] : route === '/upload' ? ['format', 'name'] : [];
      if (query.some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1) || allowed.some(key => !url.searchParams.has(key))) refuse('INPUT', 'Unexpected or missing query parameter.');
      if (route === '') { send(response, 200, { imports: await list(), limits: { imports: IMPORT_LIMITS.imports, modelBytes: IMPORT_LIMITS.modelBytes, effectBytes: IMPORT_LIMITS.effectBytes } }); return true; }
      if (route === '/file') {
        const { record, bytes } = await file(url.searchParams.get('id') ?? '');
        response.writeHead(200, { 'Content-Type': record.kind === 'model' ? 'model/gltf-binary' : 'application/xml', 'Content-Length': String(bytes.length),
          'Content-Disposition': 'attachment; filename="' + fileOf(record.kind) + '"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        response.end(bytes); return true;
      }
      if (route === '/remove') {
        if (request.headers.origin !== origin) refuse('ORIGIN', 'Remove imports from the Arcane workspace.', 403);
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') refuse('CONTENT_TYPE', 'Expected application/json.', 415);
        const raw = await body(request, 1024); let input: unknown;
        try { input = JSON.parse(raw.toString('utf8')); } catch { input = null; }
        if (!isObject(input) || Object.keys(input).length !== 1 || typeof input.id !== 'string') refuse('INPUT', 'Expected {"id"}.');
        await remove((input as { id: string }).id); send(response, 200, { removed: (input as { id: string }).id }); return true;
      }
      // Upload: the main process's one-time consent first, before reading any bytes.
      const format = url.searchParams.get('format') as ImportFormat;
      if (!['glb', 'gltf', 'rbxmx'].includes(format)) refuse('FORMAT', 'Arcane imports .glb, .gltf and .rbxmx files.', 415);
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream') refuse('CONTENT_TYPE', 'Expected application/octet-stream.', 415);
      const consent = request.headers['x-arcane-import-consent'];
      await takeConsent(typeof consent === 'string' ? consent : '');
      const bytes = await body(request, format === 'glb' ? IMPORT_LIMITS.modelBytes : format === 'gltf' ? IMPORT_LIMITS.gltfBytes : IMPORT_LIMITS.effectBytes);
      const result = await add(format, url.searchParams.get('name') ?? '', new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      send(response, result.duplicate ? 200 : 201, { import: result.record, duplicate: result.duplicate }); return true;
    } catch (error) {
      if (response.headersSent || response.destroyed) return true;
      if (error instanceof ImportError) { if (error.status >= 400 && !request.readableEnded) response.setHeader('Connection', 'close'); send(response, error.status, { error: error.code, message: error.message }); }
      else send(response, 500, { error: 'IMPORT', message: 'The import could not be saved. Nothing was changed.' });
      return true;
    }
  }
  return Object.freeze({ handle, list, add, remove, file, acceptConsent, enableConsentChannel() { channel = true; } });
}
