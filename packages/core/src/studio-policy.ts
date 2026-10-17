import { ArcaneError } from '../../protocol/src/providers.js';
import { instanceRef, jsonObject, object, textField, studioImportContextObservation, STUDIO_RECONSTRUCTION_LIMITS, type StudioImportContextObservation, type StudioCommand, type Json, type StudioMethod, type StudioSession, type StudioRoot, ROOTS, isWrite, SCENE_BUILD_LIMITS, ENVIRONMENT_LIMITS } from '../../protocol/src/studio.js';

export const MATERIALS = ['Plastic', 'SmoothPlastic', 'Metal', 'Wood', 'WoodPlanks', 'Concrete', 'Brick', 'Glass', 'Neon', 'Slate', 'Sand', 'Fabric', 'Grass', 'Ground', 'Rock', 'Cobblestone', 'Asphalt', 'Marble', 'Granite', 'Limestone', 'Sandstone', 'Basalt', 'Pebble', 'LeafyGrass', 'Mud', 'Snow', 'Ice', 'Pavement', 'Plaster', 'DiamondPlate', 'CorrodedMetal', 'Foil'] as const;
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
/** Physical classes a scene.build may allocate; containers are Model/Folder and welds are WeldConstraint. */
export const BUILD_PART_CLASSES = ['Part', 'WedgePart', 'CornerWedgePart', 'SpawnLocation'] as const;
export const BUILD_GROUP_CLASSES = ['Model', 'Folder'] as const;
const BUILD_KEY = /^[A-Za-z0-9_-]{1,64}$/;
function finiteIn(value: unknown, low: number, high: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new ArcaneError('INPUT', `${label} must be ${low}..${high}.`);
  return value;
}
function triple(value: unknown, low: number, high: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 3) throw new ArcaneError('INPUT', `${label} needs three numbers.`);
  return value.map(n => finiteIn(n, low, high, label));
}
function tagged(properties: Record<string, Json>, key: string): number[] | undefined {
  const v = properties[key] as { value?: number[] } | undefined;
  return v && Array.isArray(v.value) ? v.value : undefined;
}
/** Counts every Instance a validated scene.build creates (root, groups, parts, placement Models and welds). */
export function sceneBuildInstanceCount(args: Record<string, Json>): number {
  const prototypes = (args.prototypes ?? []) as { parts: unknown[]; weld: boolean }[];
  let count = 1;
  for (const item of args.items as { kind: string; template?: number }[]) {
    if (item.kind !== 'place') { count++; continue; }
    const proto = prototypes[(item.template as number) - 1]!, parts = proto.parts.length;
    count += parts === 1 ? 1 : 1 + parts + (proto.weld ? parts - 1 : 0);
  }
  return count;
}
/** Strict wire contract for one atomic hierarchy. The MCP tool compiles compact
 * templates/scatter into this form; the plugin re-validates and performs the same placement math. */
function validateSceneBuild(a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  keys(a, ['parent', 'container', 'prototypes', 'items']); ref(a.parent, session);
  const rootSpec = object(a.container, 'build container'); keys(rootSpec, ['className', 'name']);
  if (!BUILD_GROUP_CLASSES.includes(rootSpec.className as typeof BUILD_GROUP_CLASSES[number])) throw new ArcaneError('CLASS', 'The build root must be a Model or Folder.');
  textField(rootSpec.name, 'build root name', 100);
  const prototypes = a.prototypes === undefined ? [] : a.prototypes;
  if (!Array.isArray(prototypes) || prototypes.length > SCENE_BUILD_LIMITS.prototypes) throw new ArcaneError('INPUT', `Use at most ${SCENE_BUILD_LIMITS.prototypes} prototypes.`);
  const protoParts: { size: number[]; position: number[] }[][] = [];
  const normalizedPrototypes = prototypes.map(value => {
    const proto = object(value, 'prototype'); keys(proto, ['name', 'weld', 'parts']); textField(proto.name, 'prototype name', 100);
    if (typeof proto.weld !== 'boolean') throw new ArcaneError('INPUT', 'Prototype weld must be a boolean.');
    if (!Array.isArray(proto.parts) || proto.parts.length < 1 || proto.parts.length > SCENE_BUILD_LIMITS.prototypeParts) throw new ArcaneError('INPUT', `A prototype needs 1..${SCENE_BUILD_LIMITS.prototypeParts} parts.`);
    const geometry: { size: number[]; position: number[] }[] = [];
    const parts = proto.parts.map(raw => {
      const part = object(raw, 'prototype part'); keys(part, ['className', 'name', 'properties', 'tint']);
      if (!BUILD_PART_CLASSES.includes(part.className as typeof BUILD_PART_CLASSES[number])) throw new ArcaneError('CLASS', 'Unsupported build part class.');
      textField(part.name, 'part name', 100);
      if (typeof part.tint !== 'boolean') throw new ArcaneError('INPUT', 'Prototype part tint must be a boolean.');
      const properties = buildPartProperties(part.properties, part.className as string);
      geometry.push({ size: tagged(properties, 'Size') ?? [4, 1, 2], position: tagged(properties, 'Position') ?? [0, 0, 0] });
      return { className: part.className, name: part.name, properties: engineProperties(properties), tint: part.tint } as Json;
    });
    protoParts.push(geometry);
    return { name: proto.name, weld: proto.weld, parts } as Json;
  });
  const items = a.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > SCENE_BUILD_LIMITS.items) throw new ArcaneError('INPUT', `A build needs 1..${SCENE_BUILD_LIMITS.items} items.`);
  const kinds: string[] = [], seenKeys = new Set<string>();
  const normalizedItems = items.map((raw, index) => {
    const item = object(raw, 'build item');
    const parent = item.parent;
    if (!Number.isInteger(parent) || (parent as number) < 0 || (parent as number) > index) throw new ArcaneError('INPUT', 'Item parent must be 0 (the build root) or an earlier group item index.');
    if ((parent as number) > 0 && kinds[(parent as number) - 1] !== 'group') throw new ArcaneError('INPUT', 'Only group items can contain other items.');
    if (item.key !== undefined) {
      if (typeof item.key !== 'string' || !BUILD_KEY.test(item.key) || seenKeys.has(item.key)) throw new ArcaneError('INPUT', 'Item keys must be unique [A-Za-z0-9_-]{1,64}.');
      seenKeys.add(item.key);
      if (seenKeys.size > SCENE_BUILD_LIMITS.keys) throw new ArcaneError('INPUT', `At most ${SCENE_BUILD_LIMITS.keys} keyed items return references.`);
    }
    textField(item.name, 'item name', 100);
    kinds.push(String(item.kind));
    if (item.kind === 'group') {
      keys(item, ['kind', 'className', 'name', 'parent', 'key']);
      if (!BUILD_GROUP_CLASSES.includes(item.className as typeof BUILD_GROUP_CLASSES[number])) throw new ArcaneError('CLASS', 'Group items must be Model or Folder.');
      return item as Json;
    }
    if (item.kind === 'part') {
      keys(item, ['kind', 'className', 'name', 'parent', 'properties', 'key']);
      if (!BUILD_PART_CLASSES.includes(item.className as typeof BUILD_PART_CLASSES[number])) throw new ArcaneError('CLASS', 'Unsupported build part class.');
      return { ...item, properties: engineProperties(buildPartProperties(item.properties, item.className as string)) } as Json;
    }
    if (item.kind !== 'place') throw new ArcaneError('INPUT', 'Item kind must be group, part or place.');
    keys(item, ['kind', 'template', 'name', 'parent', 'at', 'yaw', 'scale', 'tint', 'ground', 'key']);
    if (item.ground !== undefined && typeof item.ground !== 'boolean') throw new ArcaneError('INPUT', 'Placement ground must be a boolean.');
    if (!Number.isInteger(item.template) || (item.template as number) < 1 || (item.template as number) > normalizedPrototypes.length) throw new ArcaneError('INPUT', 'Placement names an unknown prototype index.');
    const at = triple(item.at, -100000, 100000, 'Placement position');
    finiteIn(item.yaw, -360, 360, 'Placement yaw');
    const scale = finiteIn(item.scale, 0.1, 20, 'Placement scale');
    if (item.tint !== null) triple(item.tint, 0, 2, 'Placement tint');
    for (const part of protoParts[(item.template as number) - 1]!) {
      if (part.size.some(n => n * scale < 0.05 || n * scale > 2048)) throw new ArcaneError('PROPERTY', 'A scaled prototype part must stay 0.05..2048 studs.');
      const reach = Math.hypot(...part.position) * scale;
      if (at.some(n => Math.abs(n) + reach + 1000 > 100000)) throw new ArcaneError('PROPERTY', 'A placed prototype part must stay within ±100000 studs.');
    }
    return item as Json;
  });
  const result: Record<string, Json> = { parent: a.parent as Json, container: { className: rootSpec.className, name: rootSpec.name } as Json, prototypes: normalizedPrototypes, items: normalizedItems };
  if (sceneBuildInstanceCount(result) > SCENE_BUILD_LIMITS.instances) throw new ArcaneError('BODY_LIMIT', `A build may create at most ${SCENE_BUILD_LIMITS.instances} instances; split it into a few builds.`);
  return result;
}
function buildPartProperties(value: unknown, className: string): Record<string, Json> {
  const properties = validateProperties(value ?? {}, className, false);
  if (Object.hasOwn(properties, 'Name')) throw new ArcaneError('PROPERTY', 'Use the item name field.');
  const size = tagged(properties, 'Size');
  if (properties.Shape === 'Ball' && size && (size[0] !== size[1] || size[1] !== size[2])) throw new ArcaneError('PROPERTY', 'A Ball needs equal Size channels.');
  return properties;
}

export const TERRAIN_MATERIALS = ['Air', 'Grass', 'LeafyGrass', 'Ground', 'Mud', 'Rock', 'Slate', 'Sand', 'Sandstone', 'Limestone', 'Basalt', 'Granite', 'Pebble',
  'Snow', 'Ice', 'Glacier', 'Salt', 'Cobblestone', 'Asphalt', 'Concrete', 'Brick', 'WoodPlanks', 'CrackedLava', 'Water'] as const;
export const TERRAIN_SHAPES = ['Block', 'Ball', 'Cylinder', 'Wedge'] as const;
/** Fixed Lighting/effect allowlist: numeric [low, high], 'color' (0..1 RGB) or 'boolean'. */
export const ENVIRONMENT_PROPERTIES = Object.freeze({
  lighting: { ClockTime: [0, 24], Brightness: [0, 10], ExposureCompensation: [-3, 3], EnvironmentDiffuseScale: [0, 1], EnvironmentSpecularScale: [0, 1],
    ShadowSoftness: [0, 1], FogStart: [0, 100000], FogEnd: [0, 100000], Ambient: 'color', OutdoorAmbient: 'color', ColorShift_Top: 'color', FogColor: 'color', GlobalShadows: 'boolean' },
  atmosphere: { Density: [0, 1], Offset: [0, 1], Haze: [0, 10], Glare: [0, 10], Color: 'color', Decay: 'color' },
  bloom: { Intensity: [0, 2], Size: [0, 56], Threshold: [0, 4] },
  colorCorrection: { Brightness: [-1, 1], Contrast: [-1, 1], Saturation: [-1, 1], TintColor: 'color' },
  sunRays: { Intensity: [0, 1], Spread: [0, 1] },
} as const);
export type EnvironmentSection = keyof typeof ENVIRONMENT_PROPERTIES;
function validateEnvironment(a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  const sections = Object.keys(ENVIRONMENT_PROPERTIES) as EnvironmentSection[];
  keys(a, ['terrain', ...sections]);
  if (!Object.keys(a).length) throw new ArcaneError('INPUT', 'Choose terrain shapes or lighting/effect settings.');
  if (a.terrain !== undefined) {
    if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Terrain requires the Workspace grant.');
    if (!Array.isArray(a.terrain) || a.terrain.length < 1 || a.terrain.length > ENVIRONMENT_LIMITS.terrainShapes) throw new ArcaneError('INPUT', `Use 1..${ENVIRONMENT_LIMITS.terrainShapes} terrain shapes.`);
    let volume = 0;
    for (const raw of a.terrain) {
      const shape = object(raw, 'terrain shape');
      if (!TERRAIN_SHAPES.includes(shape.shape as typeof TERRAIN_SHAPES[number])) throw new ArcaneError('INPUT', 'Terrain shape must be Block, Ball, Cylinder or Wedge.');
      if (!TERRAIN_MATERIALS.includes(shape.material as typeof TERRAIN_MATERIALS[number])) throw new ArcaneError('PROPERTY', 'Unsupported terrain material.');
      triple(shape.center, -100000, 100000, 'Terrain center');
      const extent = ENVIRONMENT_LIMITS.extent;
      if (shape.shape === 'Ball') {
        keys(shape, ['shape', 'material', 'center', 'radius']);
        const r = finiteIn(shape.radius, 1, extent / 2, 'Terrain radius'); volume += (4 / 3) * Math.PI * r ** 3;
      } else if (shape.shape === 'Cylinder') {
        keys(shape, ['shape', 'material', 'center', 'radius', 'height', 'orientation']);
        const r = finiteIn(shape.radius, 1, extent / 2, 'Terrain radius'), h = finiteIn(shape.height, 1, extent, 'Terrain height');
        volume += Math.PI * r * r * h;
        if (shape.orientation !== undefined) triple(shape.orientation, -360, 360, 'Terrain orientation');
      } else {
        keys(shape, ['shape', 'material', 'center', 'size', 'orientation']);
        const size = triple(shape.size, 1, extent, 'Terrain size'); volume += size[0]! * size[1]! * size[2]!;
        if (shape.orientation !== undefined) triple(shape.orientation, -360, 360, 'Terrain orientation');
      }
    }
    if (volume > ENVIRONMENT_LIMITS.volume) throw new ArcaneError('BODY_LIMIT', 'Terrain fills exceed the bounded volume; split the work.');
  }
  for (const section of sections) {
    if (a[section] === undefined) continue;
    if (!session.allowedRoots.includes('Lighting')) throw new ArcaneError('SCOPE', 'Lighting and effects require the Lighting grant.');
    const values = object(a[section], section), spec = ENVIRONMENT_PROPERTIES[section] as Record<string, readonly [number, number] | 'color' | 'boolean'>;
    keys(values, Object.keys(spec));
    if (!Object.keys(values).length) throw new ArcaneError('INPUT', `Set at least one ${section} property.`);
    for (const [key, v] of Object.entries(values)) {
      const kind = spec[key]!;
      if (kind === 'boolean') { if (typeof v !== 'boolean') throw new ArcaneError('PROPERTY', `${key} must be a boolean.`); }
      else if (kind === 'color') triple(v, 0, 1, key);
      else finiteIn(v, kind[0], kind[1], key);
    }
  }
  return a;
}

export function validateCommandArgs(method: StudioMethod, value: unknown, session: StudioSession, internalRestore = false): Record<string, Json> {
  if (method === 'scene.import_context' || method === 'scene.upload_context') {
    const input = object(value), prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(input).length !== 0) throw new ArcaneError('INPUT', 'Import context arguments must be an empty JSON object.');
  }
  const a = jsonObject(value);
  if (isWrite(method) && !session.allowWrites) throw new ArcaneError('READ_ONLY', 'This Studio pairing is read-only. Create an explicit writable pairing to edit.');
  if (!session.capabilities.includes(method)) {
    if (method === 'scene.build' || method === 'environment.apply') throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `The connected Arcane Studio plugin (${session.pluginVersion}) predates batch building and environment tools. Update the Studio plugin from Arcane, restart Studio and connect again; until then use scene_create. No command was queued.`);
    throw new ArcaneError('CAPABILITY', 'This exact plugin session does not support this method.');
  }
  switch (method) {
    case 'asset.stage_packet': case 'asset.reconstruct': {
      keys(a, method === 'asset.stage_packet' ? ['expected', 'packet', 'target', 'continuity'] : ['runId','expected','packetCount','byteLength','objects','target','continuity']);
      const expected = object(a.expected), target = object(a.target), continuity = object(a.continuity);
      keys(expected, ['digest', 'payloadDigest', 'manifestDigest']);
      for (const key of ['digest', 'payloadDigest', 'manifestDigest']) if (typeof expected[key] !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(expected[key])) throw new ArcaneError('INPUT', 'Expected complete asset staging digests.');
      if(method==='asset.stage_packet') {
      textField(a.packet, 'asset packet', 256 * 1024);
      let packet: Record<string, unknown>;
      try {packet = object(JSON.parse(a.packet as string));} catch {throw new ArcaneError('INPUT', 'Expected a bounded JSON asset packet.');}
      if (packet.formatVersion !== 1 || packet.payloadDigest !== expected.payloadDigest || packet.manifestDigest !== expected.manifestDigest
        || !Number.isInteger(packet.ordinal) || (packet.ordinal as number) < 0 || (packet.ordinal as number) >= 512
        || !['begin', 'object', 'chunk', 'seal'].includes(packet.kind as string)) throw new ArcaneError('INPUT', 'Asset packet does not match its fixed staging envelope.');
      } else {
        if(typeof a.runId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(a.runId)||!Number.isSafeInteger(a.packetCount)||Number(a.packetCount)<1||Number(a.packetCount)>512
          ||!Number.isSafeInteger(a.byteLength)||Number(a.byteLength)<Number(a.packetCount)||Number(a.byteLength)>8*1024*1024
          ||!Array.isArray(a.objects)||a.objects.length<1||a.objects.length>STUDIO_RECONSTRUCTION_LIMITS.objects)throw new ArcaneError('INPUT','Invalid bounded reconstruction metadata.');
        let vertices=0,triangles=0;const ids=new Set<string>();
        for(const value of a.objects){
          const item=object(value);keys(item,['sourceObjectId','meshExportSha256','vertexCount','triangleCount']);
          const id=textField(item.sourceObjectId,'source object',128);
          if(ids.has(id)||typeof item.meshExportSha256!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(item.meshExportSha256)
            ||!Number.isSafeInteger(item.vertexCount)||Number(item.vertexCount)<1||Number(item.vertexCount)>60000
            ||!Number.isSafeInteger(item.triangleCount)||Number(item.triangleCount)<1||Number(item.triangleCount)>20000)throw new ArcaneError('INPUT','Invalid reconstructed source metadata.');
          ids.add(id);vertices+=Number(item.vertexCount);triangles+=Number(item.triangleCount);
        }
        if(vertices>STUDIO_RECONSTRUCTION_LIMITS.vertices||triangles>STUDIO_RECONSTRUCTION_LIMITS.triangles)throw new ArcaneError('BODY_LIMIT','Reconstruction exceeds aggregate resource limits.');
      }
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
    case 'scene.import_context': case 'scene.upload_context':
      keys(a, []); root('Workspace', session); break;
    case 'scene.children':
      keys(a, ['root', 'ref', 'limit']); root(a.root, session);
      if (a.ref) { const r = ref(a.ref, session); if (r.root !== a.root) throw new ArcaneError('SCOPE', 'Root/ref mismatch.'); }
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 200)) throw new ArcaneError('INPUT', 'Limit must be 1..200.'); break;
    case 'scene.search':
      keys(a, ['root', 'query', 'limit']); root(a.root, session); textField(a.query, 'search query', 100);
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 200)) throw new ArcaneError('INPUT', 'Limit must be 1..200.'); break;
    case 'script.search': {
      keys(a, ['root', 'ref', 'query', 'limit', 'caseSensitive']); root(a.root, session);
      if (a.ref !== undefined) { const r = ref(a.ref, session); if (r.root !== a.root) throw new ArcaneError('SCOPE', 'Root/ref mismatch.'); }
      if (typeof a.query !== 'string' || !a.query.length || Buffer.byteLength(a.query, 'utf8') > 256 || /[\x00-\x1f\x7f]/.test(a.query) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(a.query)) throw new ArcaneError('INPUT', 'Use a literal single-line query of at most 256 UTF-8 bytes.');
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 100)) throw new ArcaneError('INPUT', 'Limit must be 1..100.');
      if (a.caseSensitive !== undefined && typeof a.caseSensitive !== 'boolean') throw new ArcaneError('INPUT', 'caseSensitive must be a boolean.');
      break;
    }
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
    case 'scene.build': return validateSceneBuild(a, session);
    case 'environment.apply': return validateEnvironment(a, session);
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
