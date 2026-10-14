import { ArcaneError } from '../../protocol/src/providers.js';
import { instanceRef, jsonObject, object, textField, studioImportContextObservation, type StudioImportContextObservation, type StudioCommand, type Json, type StudioMethod, type StudioSession, type StudioRoot, ROOTS, isWrite } from '../../protocol/src/studio.js';

export const MATERIALS = ['Plastic', 'SmoothPlastic', 'Metal', 'Wood', 'WoodPlanks', 'Concrete', 'Brick', 'Glass', 'Neon', 'Slate', 'Sand', 'Fabric', 'Grass', 'Ground', 'Rock', 'Cobblestone', 'Asphalt'] as const;
export const CREATE_CLASSES = ['Folder', 'Model', 'Part', 'Script', 'LocalScript', 'ModuleScript'] as const;
// Keep the legacy six-class contract for existing generated models.
export const GEOMETRY_CREATE_CLASSES = ['WedgePart', 'CornerWedgePart', 'SpawnLocation'] as const;
export const SAFE_CREATE_CLASSES = [...CREATE_CLASSES, ...GEOMETRY_CREATE_CLASSES] as const;
export const SHAPES = ['Block', 'Ball', 'Cylinder'] as const;
export const PART_SHAPE_CLASSES = ['Part', 'FlagStand', 'Platform', 'Seat', 'SkateboardPlatform', 'SpawnLocation'] as const;
export const BASE_PART_CLASSES = [...PART_SHAPE_CLASSES, 'MeshPart', 'UnionOperation', 'NegateOperation', 'IntersectOperation', 'WedgePart', 'CornerWedgePart', 'TrussPart', 'VehicleSeat'] as const;
export const MAX_PROPERTIES = 12;
const PART_PROPERTIES = new Set(['Size', 'Position', 'Orientation', 'Color', 'Anchored', 'CanCollide', 'CastShadow', 'Transparency', 'Reflectance', 'Material', 'Shape']);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
function keys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new ArcaneError('INPUT', 'Unexpected command field.');
}
function source(value: unknown): void {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 100 * 1024) throw new ArcaneError('INPUT', 'Script source must be at most 100 KiB, without NUL bytes.');
}
function ref(value: unknown, session: StudioSession): ReturnType<typeof instanceRef> {
  const r = instanceRef(value);
  if (r.sessionId !== session.id || !session.allowedRoots.includes(r.root)) throw new ArcaneError('SCOPE', 'Instance reference is outside this exact paired Studio scope.');
  return r;
}
function root(value: unknown, session: StudioSession): void {
  if (!ROOTS.includes(value as StudioRoot) || !session.allowedRoots.includes(value as StudioRoot)) throw new ArcaneError('SCOPE', 'Root is outside the pairing grant.');
}
export function validateProperties(value: unknown, className: string, allowName: boolean): Record<string, Json> {
  const properties = jsonObject(value);
  if (Object.keys(properties).length > MAX_PROPERTIES) throw new ArcaneError('INPUT', 'Too many properties.');
  for (const [key, v] of Object.entries(properties)) {
    if (key === 'Name' && allowName) { textField(v, 'name', 100); continue; }
    if (!(BASE_PART_CLASSES as readonly string[]).includes(className) || !PART_PROPERTIES.has(key)) throw new ArcaneError('PROPERTY', 'Property is not writable by the safe bridge.');
    if (key === 'Shape') {
      if (!(PART_SHAPE_CLASSES as readonly string[]).includes(className) || !SHAPES.includes(v as typeof SHAPES[number])) throw new ArcaneError('PROPERTY', 'Shape requires a Part and must be Block, Ball or Cylinder.');
      continue;
    }
    if (key === 'Anchored' || key === 'CanCollide' || key === 'CastShadow') { if (typeof v !== 'boolean') throw new ArcaneError('PROPERTY', 'Expected boolean.'); continue; }
    if (key === 'Transparency' || key === 'Reflectance') { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new ArcaneError('PROPERTY', `${key} must be 0..1.`); continue; }
    if (key === 'Material') { if (!MATERIALS.includes(v as typeof MATERIALS[number])) throw new ArcaneError('PROPERTY', 'Unsupported material.'); continue; }
    const tagged = object(v, 'tagged property'); keys(tagged, ['type', 'value']);
    if (tagged.type !== (key === 'Color' ? 'Color3' : 'Vector3') || !Array.isArray(tagged.value) || tagged.value.length !== 3 || tagged.value.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100000)) throw new ArcaneError('PROPERTY', 'Expected a bounded tagged three-component value.');
    if (key === 'Color' && tagged.value.some(n => (n as number) < 0 || (n as number) > 1)) throw new ArcaneError('PROPERTY', 'Color channels must be 0..1.');
    if (key === 'Size' && tagged.value.some(n => (n as number) < 0.05 || (n as number) > 2048)) throw new ArcaneError('PROPERTY', 'Part dimensions must be 0.05..2048 studs.');
    if (key === 'Orientation' && tagged.value.some(n => (n as number) < -360 || (n as number) > 360)) throw new ArcaneError('PROPERTY', 'Orientation channels must be -360..360 degrees.');
  }
  return properties;
}
export function engineProperties(value: Record<string, Json>): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const [key, v] of Object.entries(value)) {
    if (['Size', 'Position', 'Orientation', 'Color'].includes(key) && v && typeof v === 'object' && !Array.isArray(v)) {
      const tagged = v as { type: string; value: number[] };
      result[key] = { type: tagged.type, value: tagged.value.map(Math.fround) };
    } else result[key] = ['Transparency', 'Reflectance'].includes(key) && typeof v === 'number' ? Math.fround(v) : v;
  }
  return result;
}
export function validateCommandArgs(method: StudioMethod, value: unknown, session: StudioSession, internalRestore = false): Record<string, Json> {
  if (method === 'scene.import_context') {
    const input = object(value), prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(input).length !== 0) throw new ArcaneError('INPUT', 'Import context arguments must be an empty JSON object.');
  }
  const a = jsonObject(value);
  if (isWrite(method) && !session.allowWrites) throw new ArcaneError('READ_ONLY', 'This Studio pairing is read-only. Create an explicit writable pairing to edit.');
  if (!session.capabilities.includes(method)) throw new ArcaneError('CAPABILITY', 'This exact plugin session does not support this method.');
  switch (method) {
    case 'asset.stage_packet': {
      keys(a, ['expected', 'packet', 'target', 'continuity']);
      const expected = object(a.expected), target = object(a.target), continuity = object(a.continuity);
      keys(expected, ['digest', 'payloadDigest', 'manifestDigest']);
      for (const key of ['digest', 'payloadDigest', 'manifestDigest']) if (typeof expected[key] !== 'string' || !/^[a-f0-9]{64}$/.test(expected[key])) throw new ArcaneError('INPUT', 'Expected complete asset staging digests.');
      textField(a.packet, 'asset packet', 256 * 1024);
      let packet: Record<string, unknown>;
      try {packet = object(JSON.parse(a.packet as string));} catch {throw new ArcaneError('INPUT', 'Expected a bounded JSON asset packet.');}
      if (packet.formatVersion !== 1 || packet.payloadDigest !== expected.payloadDigest || packet.manifestDigest !== expected.manifestDigest
        || !Number.isInteger(packet.ordinal) || (packet.ordinal as number) < 0 || (packet.ordinal as number) >= 512
        || !['begin', 'object', 'chunk', 'seal'].includes(packet.kind as string)) throw new ArcaneError('INPUT', 'Asset packet does not match its fixed staging envelope.');
      keys(target, ['sessionId', 'placeId', 'universeId', 'root', 'parentRef', 'creator']); root(target.root, session);
      if (target.root !== 'Workspace' || target.sessionId !== session.id || target.placeId !== session.placeId || target.universeId !== session.universeId) throw new ArcaneError('SCOPE', 'Asset staging targets another paired Workspace.');
      textField(target.parentRef, 'parent reference');
      const creator = object(target.creator); keys(creator, ['kind', 'id']);
      if ((creator.kind !== 'user' && creator.kind !== 'group') || typeof creator.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(creator.id) || !Number.isSafeInteger(Number(creator.id))) throw new ArcaneError('INPUT', 'Invalid observed asset creator.');
      keys(continuity, ['clientLifetimeId', 'pluginArtifactHash', 'playEpoch']);
      const proof = session.proof;
      if (!proof || continuity.clientLifetimeId !== session.clientSessionId || continuity.pluginArtifactHash !== proof.pluginArtifactHash || continuity.playEpoch !== proof.playEpoch || proof.mode !== 'Edit' || !proof.connected || !proof.continuitySupported) throw new ArcaneError('SCOPE', 'Asset staging requires exact Edit continuity.');
      break;
    }
    case 'scene.import_context':
      keys(a, []); root('Workspace', session); break;
    case 'scene.children':
      keys(a, ['root', 'ref', 'limit']); root(a.root, session);
      if (a.ref) { const r = ref(a.ref, session); if (r.root !== a.root) throw new ArcaneError('SCOPE', 'Root/ref mismatch.'); }
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 200)) throw new ArcaneError('INPUT', 'Limit must be 1..200.'); break;
    case 'scene.search':
      keys(a, ['root', 'query', 'limit']); root(a.root, session); textField(a.query, 'search query', 100);
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 200)) throw new ArcaneError('INPUT', 'Limit must be 1..200.'); break;
    case 'selection.read': keys(a, []); break;
    case 'scene.inspect': case 'script.read': keys(a, ['ref']); ref(a.ref, session); break;
    case 'script.update': keys(a, ['ref', 'expectedSource', 'source']); ref(a.ref, session); source(a.expectedSource); source(a.source); break;
    case 'script.set_enabled': {
      keys(a, ['ref', 'expectedSource', 'expectedEnabled', 'enabled']);
      const r = ref(a.ref, session);
      if (r.className !== 'Script' && r.className !== 'LocalScript') throw new ArcaneError('CLASS', 'Only Script and LocalScript have an execution state.');
      source(a.expectedSource);
      if (typeof a.expectedEnabled !== 'boolean' || typeof a.enabled !== 'boolean') throw new ArcaneError('INPUT', 'Execution state and its exact baseline must be booleans.');
      if (a.enabled && !(a.expectedSource as string).trim()) throw new ArcaneError('SOURCE_EMPTY', 'An empty placeholder script cannot be activated.');
      break;
    }
    case 'scene.create': {
      keys(a, ['parent', 'className', 'name', 'properties']); ref(a.parent, session); textField(a.name, 'instance name', 100);
      if (!SAFE_CREATE_CLASSES.includes(a.className as typeof SAFE_CREATE_CLASSES[number])) throw new ArcaneError('CLASS', 'Unsupported creation class.');
      a.properties = engineProperties(validateProperties(a.properties ?? {}, a.className as string, false)); break;
    }
    case 'scene.update': {
      keys(a, ['ref', 'expected', 'properties']); const r = ref(a.ref, session);
      const p = validateProperties(a.properties, r.className, r.pathSegments.length > 0);
      const e = validateProperties(a.expected, r.className, r.pathSegments.length > 0);
      if (!Object.keys(p).length || canonical(Object.keys(p).sort()) !== canonical(Object.keys(e).sort())) throw new ArcaneError('BASELINE', 'Expected values must cover exactly every changed property.'); a.expected = engineProperties(e); a.properties = engineProperties(p); break;
    }
    case 'scene.restore':
      if (!internalRestore) throw new ArcaneError('RESTORE', 'Use the receipt restoration endpoint; arbitrary inverse payloads are refused.');
      keys(a, ['receiptCommandId', 'mutation']); textField(a.receiptCommandId, 'receipt ID');
      ref(object(a.mutation).ref, session); break;
  }
  return a;
}

/** Consume only a completed command from the trusted host receipt store. The
 * selector/ledger still owns freshness, continuity and permission admission. */
export function validateStudioImportContextReceipt(command: StudioCommand, session: StudioSession): StudioImportContextObservation {
  if (command.method !== 'scene.import_context' || command.protocolVersion !== 1 || command.state !== 'succeeded'
    || command.error !== null || session.revokedAt !== null || command.sessionId !== session.id
    || command.clientSessionId !== session.clientSessionId || command.allowWrites !== session.allowWrites
    || canonical([...command.allowedRoots].sort()) !== canonical([...session.allowedRoots].sort())) {
    throw new ArcaneError('SCOPE', 'Import context requires a succeeded receipt from this exact live Studio session.');
  }
  validateCommandArgs('scene.import_context', command.args, session);
  const observation = studioImportContextObservation(command.result);
  if (observation.sessionId !== session.id || observation.placeId !== session.placeId || observation.universeId !== session.universeId) {
    throw new ArcaneError('SCOPE', 'Import context identity differs from the paired Studio session.');
  }
  return observation;
}
