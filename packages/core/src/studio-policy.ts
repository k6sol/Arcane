import {createHash} from 'node:crypto';
import {types as observationTypes} from 'node:util';
import {STUDIO_IMPORT_OBSERVATION_LIMITS,type StudioAssetStageArgs,type InstanceRef,type StudioImportObservationSource,type StudioImportObservedChild,type StudioImportObservedNode,type StudioImportObservedObject,type StudioImportObservationArgs,type StudioImportObservationReceipt,type StudioImportObservationWitness,type StudioImportRevisionArgs,type StudioImportRevisionReceipt} from '../../protocol/src/studio.js';
import { ArcaneError } from '../../protocol/src/providers.js';
import { isAssetMethod, validateAssetCommand, validateBuildClone, validateBuildTemplates } from './studio-asset-policy.js';
import { validateTerrainGenerate } from './terrain-policy.js';
import { validateMeshKeep } from './mesh-keep-policy.js';
import { instanceRef, jsonObject, object, textField, studioImportContextObservation, STUDIO_ASSET_TRANSFER_LIMITS, STUDIO_RECONSTRUCTION_LIMITS, type StudioImportContextObservation, type StudioCommand, type Json, type StudioMethod, type StudioSession, type StudioRoot, ROOTS, isWrite, SCENE_BUILD_LIMITS, ENVIRONMENT_LIMITS, EFFECT_LIMITS, STUDIO_EFFECTS_CAPABILITY, STUDIO_GUI_CAPABILITY, STUDIO_GUI_FLEX_CAPABILITY, STUDIO_GUI_EDIT_CAPABILITY, STUDIO_CHARACTERS_CAPABILITY, GUI_LIMITS, STUDIO_SEARCH_CLASS_CAPABILITY, STUDIO_ENVIRONMENT_FOREST_CAPABILITY, OUTPUT_LEVELS, OUTPUT_READ_LIMITS } from '../../protocol/src/studio.js';
/** One engine class name for scene.search IsA filtering (never a path or expression). */
export const SEARCH_CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

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
  const prototypes = (args.prototypes ?? []) as { parts: unknown[]; weld: boolean; gui?: unknown[] }[];
  let count = 1;
  for (const item of args.items as { kind: string; template?: number }[]) {
    if (item.kind === 'stamp') { count += prototypes[(item.template as number) - 1]!.gui!.length; continue; }
    if (item.kind !== 'place') { count++; continue; }
    const proto = prototypes[(item.template as number) - 1]!, parts = proto.parts.length;
    count += parts === 1 ? 1 : 1 + parts + (proto.weld ? parts - 1 : 0);
  }
  return count;
}
/** Strict wire contract for one atomic hierarchy. The MCP tool compiles compact
 * templates/scatter into this form; the plugin re-validates and performs the same placement math. */
function validateSceneBuild(a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  keys(a, ['parent', 'container', 'prototypes', 'items', 'templates']); const parentRef = ref(a.parent, session);
  const templates = validateBuildTemplates(a.templates, session);
  const rootSpec = object(a.container, 'build container'); keys(rootSpec, ['className', 'name', 'properties']);
  // A ScreenGui root builds a whole screen UI atomically under StarterGui (or a Model/Folder template holder).
  const guiRoot = rootSpec.className === 'ScreenGui';
  if (!guiRoot && !BUILD_GROUP_CLASSES.includes(rootSpec.className as typeof BUILD_GROUP_CLASSES[number])) throw new ArcaneError('CLASS', 'The build root must be a Model, Folder or ScreenGui.');
  textField(rootSpec.name, 'build root name', 100);
  const container: Record<string, Json> = { className: rootSpec.className as string, name: rootSpec.name as string };
  if (guiRoot) {
    requireGui(session);
    const host = hostKind(parentRef.className, parentRef.pathSegments.length === 0);
    if (!host || !GUI_HOSTS.ScreenGui.includes(host as GuiHost)) throw hostError('ScreenGui');
    if (rootSpec.properties !== undefined) container.properties = validateGuiProperties(rootSpec.properties, 'ScreenGui');
  } else if (rootSpec.properties !== undefined) throw new ArcaneError('INPUT', 'Only a ScreenGui build root takes properties.');
  const prototypes = a.prototypes === undefined ? [] : a.prototypes;
  if (!Array.isArray(prototypes) || prototypes.length > SCENE_BUILD_LIMITS.prototypes) throw new ArcaneError('INPUT', `Use at most ${SCENE_BUILD_LIMITS.prototypes} prototypes.`);
  const protoParts: { size: number[]; position: number[] }[][] = [];
  const normalizedPrototypes = prototypes.map(value => {
    const proto = object(value, 'prototype');
    if (proto.gui !== undefined) {
      requireGui(session); keys(proto, ['name', 'gui']); textField(proto.name, 'prototype name', 100);
      protoParts.push([]);
      return { name: proto.name, gui: validateGuiPrototype(proto.gui, session) } as Json;
    }
    keys(proto, ['name', 'weld', 'parts']); textField(proto.name, 'prototype name', 100);
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
    const nested = item.kind === 'effect' || item.kind === 'gui' || item.kind === 'stamp';
    if ((parent as number) > 0 && kinds[(parent as number) - 1] !== 'group' && !nested) throw new ArcaneError('INPUT', 'Only group items can contain other items.');
    if (guiRoot && parent === 0 && item.kind !== 'gui' && item.kind !== 'stamp') throw new ArcaneError('INPUT', 'A ScreenGui build root holds only gui and stamp items.');
    if (item.key !== undefined) {
      if (typeof item.key !== 'string' || !BUILD_KEY.test(item.key) || seenKeys.has(item.key)) throw new ArcaneError('INPUT', 'Item keys must be unique [A-Za-z0-9_-]{1,64}.');
      seenKeys.add(item.key);
      if (seenKeys.size > SCENE_BUILD_LIMITS.keys) throw new ArcaneError('INPUT', `At most ${SCENE_BUILD_LIMITS.keys} keyed items return references.`);
    }
    textField(item.name, 'item name', 100);
    if (item.kind === 'gui' || item.kind === 'stamp') {
      // Host of the parent: the root (ScreenGui = layer), a group, a part, an Attachment or an earlier GUI host item.
      const parentKind = parent === 0 ? (guiRoot ? 'gui:ScreenGui' : 'group') : kinds[(parent as number) - 1]!;
      const tagged = /^(?:gui|stamp|effect):(.+)$/.exec(parentKind)?.[1];
      const host: EffectHost | null = parentKind === 'group' || parentKind === 'part' ? parentKind
        : tagged ? (Object.hasOwn(GUI_HOST_CLASSES, tagged) ? GUI_HOST_CLASSES[tagged]! : parentKind.startsWith('effect:') && tagged === 'Attachment' ? 'attachment' : null) : null;
      const result = item.kind === 'gui' ? validateBuildGui(item, host, session) : validateBuildStamp(item, host, normalizedPrototypes, session);
      const rootClass = item.kind === 'gui' ? String(item.className) : (normalizedPrototypes[(item.template as number) - 1] as { gui: { className: string }[] }).gui[0]!.className;
      kinds.push('gui:' + rootClass);
      return result;
    }
    kinds.push(item.kind === 'effect' ? 'effect:' + String(item.className) : String(item.kind));
    if (item.kind === 'effect') return validateBuildEffect(item, kinds, session);
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
    if (item.kind === 'clone') return validateBuildClone(item, templates.length);
    if (item.kind !== 'place') throw new ArcaneError('INPUT', 'Item kind must be group, part, effect, gui, stamp, place or clone.');
    keys(item, ['kind', 'template', 'name', 'parent', 'at', 'yaw', 'scale', 'tint', 'ground', 'key']);
    if (item.ground !== undefined && typeof item.ground !== 'boolean') throw new ArcaneError('INPUT', 'Placement ground must be a boolean.');
    if (!Number.isInteger(item.template) || (item.template as number) < 1 || (item.template as number) > normalizedPrototypes.length) throw new ArcaneError('INPUT', 'Placement names an unknown prototype index.');
    if ((normalizedPrototypes[(item.template as number) - 1] as { gui?: unknown }).gui) throw new ArcaneError('INPUT', 'GUI prototypes are stamped (kind stamp), not placed.');
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
  const result: Record<string, Json> = { parent: a.parent as Json, container, prototypes: normalizedPrototypes, items: normalizedItems };
  if (templates.length) result.templates = templates;
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

// ---- Effects classes (scene.create / scene.build). The plugin re-validates this exact table (Properties.luau). ----
export type EffectKind = readonly ['number' | 'integer' | 'vector3' | 'vector2' | 'range' | 'sequence', number, number]
  | readonly ['enum', string, readonly string[]] | 'boolean' | 'color' | 'colorSequence' | 'content' | 'audio' | EffectRefKind
  | 'udim2' | 'udim' | 'text' | 'font';
/** Ref-valued effect properties and the class each Ref must name. */
export type EffectRefKind = 'attachment' | 'soundGroup';
export const EFFECT_REF_CLASSES: Readonly<Record<EffectRefKind, string>> = Object.freeze({ attachment: 'Attachment', soundGroup: 'SoundGroup' });
const isRefKind = (spec: EffectKind): spec is EffectRefKind => spec === 'attachment' || spec === 'soundGroup';
const NORMAL_IDS = ['Top', 'Bottom', 'Left', 'Right', 'Front', 'Back'] as const;
const LIGHT = { Brightness: ['number', 0, 40], Range: ['number', 0, 60], Color: 'color', Shadows: 'boolean', Enabled: 'boolean' } as const;
const FACED_LIGHT = { ...LIGHT, Angle: ['number', 0, 180], Face: ['enum', 'NormalId', NORMAL_IDS] } as const;
const GLOW = { LightEmission: ['number', 0, 1], LightInfluence: ['number', 0, 1], Brightness: ['number', 0, 20] } as const;
const TEXTURE_MODE = ['enum', 'TextureMode', ['Stretch', 'Wrap', 'Static']] as const;
const DECAL = { Texture: 'content', Face: ['enum', 'NormalId', NORMAL_IDS], Color3: 'color', Transparency: ['number', 0, 1] } as const;
/** Fixed effects allowlist: class -> property -> kind. Ranges are inclusive bounds. */
export const EFFECT_PROPERTIES = Object.freeze({
  Attachment: { Position: ['vector3', -2048, 2048], Orientation: ['vector3', -360, 360] },
  ParticleEmitter: { Enabled: 'boolean', Rate: ['number', 0, 500], Lifetime: ['range', 0, 20], Speed: ['range', 0, 500], SpreadAngle: ['vector2', -360, 360],
    Acceleration: ['vector3', -500, 500], Drag: ['number', 0, 50], Size: ['sequence', 0, 100], Transparency: ['sequence', 0, 1], Squash: ['sequence', -3, 3],
    Color: 'colorSequence', Rotation: ['range', -360, 360], RotSpeed: ['range', -1000, 1000],
    Orientation: ['enum', 'ParticleOrientation', ['FacingCamera', 'FacingCameraWorldUp', 'VelocityParallel', 'VelocityPerpendicular']],
    EmissionDirection: ['enum', 'NormalId', NORMAL_IDS], Shape: ['enum', 'ParticleEmitterShape', ['Box', 'Sphere', 'Cylinder', 'Disc']],
    ShapeStyle: ['enum', 'ParticleEmitterShapeStyle', ['Volume', 'Surface']], ShapeInOut: ['enum', 'ParticleEmitterShapeInOut', ['Outward', 'Inward', 'InAndOut']],
    LockedToPart: 'boolean', ZOffset: ['number', -50, 50], TimeScale: ['number', 0, 1], Texture: 'content', ...GLOW },
  Beam: { Attachment0: 'attachment', Attachment1: 'attachment', Color: 'colorSequence', Transparency: ['sequence', 0, 1], Width0: ['number', 0, 100], Width1: ['number', 0, 100],
    CurveSize0: ['number', -100, 100], CurveSize1: ['number', -100, 100], Segments: ['integer', 1, 100], FaceCamera: 'boolean', Enabled: 'boolean',
    Texture: 'content', TextureMode: TEXTURE_MODE, TextureLength: ['number', 0.01, 100], TextureSpeed: ['number', -100, 100], ZOffset: ['number', -50, 50], ...GLOW },
  Trail: { Attachment0: 'attachment', Attachment1: 'attachment', Color: 'colorSequence', Transparency: ['sequence', 0, 1], WidthScale: ['sequence', 0, 10],
    Lifetime: ['number', 0.01, 20], MinLength: ['number', 0, 100], MaxLength: ['number', 0, 1000], FaceCamera: 'boolean', Enabled: 'boolean',
    Texture: 'content', TextureMode: TEXTURE_MODE, TextureLength: ['number', 0.01, 100], ...GLOW },
  PointLight: LIGHT, SpotLight: FACED_LIGHT, SurfaceLight: FACED_LIGHT,
  Highlight: { FillColor: 'color', OutlineColor: 'color', FillTransparency: ['number', 0, 1], OutlineTransparency: ['number', 0, 1],
    DepthMode: ['enum', 'HighlightDepthMode', ['AlwaysOnTop', 'Occluded']], Enabled: 'boolean' },
  Fire: { Size: ['number', 2, 30], Heat: ['number', -25, 25], Color: 'color', SecondaryColor: 'color', Enabled: 'boolean', TimeScale: ['number', 0, 1] },
  Smoke: { Size: ['number', 0.1, 100], Opacity: ['number', 0, 1], RiseVelocity: ['number', -25, 25], Color: 'color', Enabled: 'boolean', TimeScale: ['number', 0, 1] },
  Sparkles: { SparkleColor: 'color', Enabled: 'boolean', TimeScale: ['number', 0, 1] },
  Decal: DECAL,
  Texture: { ...DECAL, StudsPerTileU: ['number', 0.01, 1000], StudsPerTileV: ['number', 0.01, 1000], OffsetStudsU: ['number', -1000, 1000], OffsetStudsV: ['number', -1000, 1000] },
  // Audio. SoundId is rbxassetid://<digits> only (never invented); SoundGroup is a Ref to a SoundGroup of the same build/session.
  Sound: { SoundId: 'audio', Volume: ['number', 0, 10], PlaybackSpeed: ['number', 0.1, 4], Looped: 'boolean', Playing: 'boolean',
    RollOffMode: ['enum', 'RollOffMode', ['Inverse', 'Linear', 'LinearSquare', 'InverseTapered']], RollOffMinDistance: ['number', 0, 10000],
    RollOffMaxDistance: ['number', 0, 10000], SoundGroup: 'soundGroup', TimePosition: ['number', 0, 3600] },
  SoundGroup: { Volume: ['number', 0, 10] },
  ReverbSoundEffect: { Enabled: 'boolean', DecayTime: ['number', 0.1, 20], Density: ['number', 0, 1], Diffusion: ['number', 0, 1], DryLevel: ['number', -80, 20], WetLevel: ['number', -80, 20] },
  EqualizerSoundEffect: { Enabled: 'boolean', HighGain: ['number', -80, 10], MidGain: ['number', -80, 10], LowGain: ['number', -80, 10] },
  EchoSoundEffect: { Enabled: 'boolean', Delay: ['number', 0.01, 5], Feedback: ['number', 0, 1], DryLevel: ['number', -80, 10], WetLevel: ['number', -80, 10] },
  ChorusSoundEffect: { Enabled: 'boolean', Depth: ['number', 0, 1], Mix: ['number', 0, 1], Rate: ['number', 0, 20] },
  CompressorSoundEffect: { Enabled: 'boolean', Threshold: ['number', -60, 0], Ratio: ['number', 1, 50], Attack: ['number', 0.001, 1], Release: ['number', 0.01, 5], GainMakeup: ['number', 0, 30] },
  DistortionSoundEffect: { Enabled: 'boolean', Level: ['number', 0, 1] },
  // Characters (scene.characters). Data and containers only: no rig parts, joints, animation ids or code. A Humanoid lives in a Model;
  // a HumanoidDescription in a Humanoid or Model/Folder is applied by a server Script (ApplyDescription / CreateHumanoidModelFromDescription);
  // an Animator goes in a Humanoid or an AnimationController (non-humanoid creatures). MaxHealth is assigned before Health.
  Humanoid: { WalkSpeed: ['number', 0, 100], JumpPower: ['number', 0, 200], UseJumpPower: 'boolean', DisplayName: 'text', MaxHealth: ['number', 1, 100000],
    Health: ['number', 0, 100000], HipHeight: ['number', 0, 50], AutoRotate: 'boolean', RigType: ['enum', 'HumanoidRigType', ['R6', 'R15']],
    DisplayDistanceType: ['enum', 'HumanoidDisplayDistanceType', ['Viewer', 'Subject', 'None']] },
  HumanoidDescription: { HeadColor: 'color', TorsoColor: 'color', LeftArmColor: 'color', RightArmColor: 'color', LeftLegColor: 'color', RightLegColor: 'color',
    HeightScale: ['number', 0.5, 2], WidthScale: ['number', 0.5, 2], DepthScale: ['number', 0.5, 2], HeadScale: ['number', 0.5, 2],
    BodyTypeScale: ['number', 0, 1], ProportionScale: ['number', 0, 1] },
  AnimationController: {},
  Animator: {},
} as const satisfies Record<string, Record<string, EffectKind>>);
export type EffectClass = keyof typeof EFFECT_PROPERTIES;
export const EFFECT_CLASSES = Object.keys(EFFECT_PROPERTIES) as EffectClass[];
/** Where each effect may live: a BasePart, an Attachment, a Model/Folder (or Workspace root), a Sound or a SoundGroup.
 * A Sound in a part/Attachment is positional; one in a Model/Folder plays everywhere (music, ambience beds). */
export type EffectHost = 'part' | 'attachment' | 'group' | 'sound' | 'soundGroup' | 'humanoid' | 'animationController' | GuiHost;
const SOUND_EFFECT_HOSTS = ['sound', 'soundGroup'] as const;
export const EFFECT_HOSTS: Readonly<Record<EffectClass, readonly EffectHost[]>> = Object.freeze({
  Attachment: ['part'], ParticleEmitter: ['part', 'attachment'], PointLight: ['part', 'attachment'], SpotLight: ['part', 'attachment'], SurfaceLight: ['part'],
  Fire: ['part', 'attachment'], Smoke: ['part', 'attachment'], Sparkles: ['part', 'attachment'], Decal: ['part'], Texture: ['part'],
  Beam: ['part', 'group'], Trail: ['part', 'group'], Highlight: ['part', 'group'],
  Sound: ['part', 'attachment', 'group'], SoundGroup: ['group'], ReverbSoundEffect: SOUND_EFFECT_HOSTS, EqualizerSoundEffect: SOUND_EFFECT_HOSTS,
  EchoSoundEffect: SOUND_EFFECT_HOSTS, ChorusSoundEffect: SOUND_EFFECT_HOSTS, CompressorSoundEffect: SOUND_EFFECT_HOSTS, DistortionSoundEffect: SOUND_EFFECT_HOSTS,
  Humanoid: ['group'], HumanoidDescription: ['humanoid', 'group'], AnimationController: ['group'], Animator: ['humanoid', 'animationController'],
});
/** Character classes additionally need the scene.characters plugin capability. */
export const CHARACTER_CLASSES: readonly EffectClass[] = Object.freeze(['Humanoid', 'HumanoidDescription', 'AnimationController', 'Animator'] as const);
/** Effect classes that can themselves host other effect items in a build (and the host kind they provide). */
export const EFFECT_HOST_CLASSES: Readonly<Record<string, EffectHost>> = Object.freeze({ Attachment: 'attachment', Sound: 'sound', SoundGroup: 'soundGroup',
  Humanoid: 'humanoid', AnimationController: 'animationController' });
export const isEffectClass = (value: unknown): value is EffectClass => typeof value === 'string' && Object.hasOwn(EFFECT_PROPERTIES, value);
export function hostKind(className: string, isRoot = false): EffectHost | null {
  if ((BASE_PART_CLASSES as readonly string[]).includes(className)) return 'part';
  if (Object.hasOwn(EFFECT_HOST_CLASSES, className)) return EFFECT_HOST_CLASSES[className]!;
  if (Object.hasOwn(GUI_HOST_CLASSES, className)) return GUI_HOST_CLASSES[className]!;
  if (isRoot && className === 'StarterGui') return 'starterGui';
  return className === 'Model' || className === 'Folder' || (isRoot && className === 'Workspace') ? 'group' : null;
}
/** Content ids are only numeric rbxassetid or built-in rbxasset://textures paths. Never URLs or other schemes. */
export const CONTENT_ID = /^(?:rbxassetid:\/\/[1-9][0-9]{0,18}|rbxasset:\/\/textures\/(?![\s\S]*\.\.)[A-Za-z0-9_\-/.]{1,160}\.(?:png|jpg|jpeg|dds|tga))$/;
export function contentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CONTENT_ID.test(value)) throw new ArcaneError('PROPERTY', `${label} must be rbxassetid://<digits> or a built-in rbxasset://textures/... path.`);
  return value;
}
/** Audio ids are only numeric rbxassetid (one the user gave or asset search returned). Never URLs or paths. */
export const AUDIO_ID = /^rbxassetid:\/\/[1-9][0-9]{0,18}$/;
export function audioId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !AUDIO_ID.test(value)) throw new ArcaneError('PROPERTY', `${label} must be rbxassetid://<digits> (an id the user gave or asset search returned).`);
  return value;
}
function tag(value: unknown, type: string, label: string): unknown[] {
  const tagged = object(value, label); keys(tagged, ['type', 'value']);
  if (tagged.type !== type || !Array.isArray(tagged.value)) throw new ArcaneError('PROPERTY', `${label} must be a tagged ${type}.`);
  return tagged.value;
}
function keypoints(value: unknown, width: number, label: string): number[][] {
  if (!Array.isArray(value) || value.length < 2 || value.length > EFFECT_LIMITS.keypoints) throw new ArcaneError('PROPERTY', `${label} needs 2..${EFFECT_LIMITS.keypoints} keypoints.`);
  let last = -1;
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > width || raw.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new ArcaneError('PROPERTY', `${label} keypoints are numeric arrays.`);
    const time = raw[0] as number;
    if (time < 0 || time > 1 || time <= last || (index === 0 && time !== 0) || (index === value.length - 1 && time !== 1)) throw new ArcaneError('PROPERTY', `${label} keypoint times must rise from 0 to 1.`);
    last = time; return raw as number[];
  });
}
/** Validates one effect property; `resolveRef` checks a Ref tag (Attachment or SoundGroup) in its build/create context. */
export function validateEffectProperty(className: EffectClass | GuiClass, key: string, v: unknown, resolveRef: (tagged: Record<string, unknown>, kind: EffectRefKind) => void): void {
  const table = specTable(className);
  const spec = table[key];
  const label = `${className}.${key}`;
  if (!spec || !Object.hasOwn(table, key)) throw new ArcaneError('PROPERTY', `${label} is not writable by the safe bridge.`);
  if (spec === 'boolean') { if (typeof v !== 'boolean') throw new ArcaneError('PROPERTY', `${label} must be a boolean.`); return; }
  if (spec === 'text') { guiText(v, label); return; }
  if (spec === 'udim2' || spec === 'udim') {
    const value = tag(v, spec === 'udim2' ? 'UDim2' : 'UDim', label);
    if (value.length !== (spec === 'udim2' ? 4 : 2)) throw new ArcaneError('PROPERTY', `${label} needs ${spec === 'udim2' ? '[xScale,xOffset,yScale,yOffset]' : '[scale,offset]'}.`);
    value.forEach((n, index) => {
      if (index % 2 === 0) finiteIn(n, -GUI_LIMITS.udimScale, GUI_LIMITS.udimScale, `${label} scale`);
      else if (!Number.isInteger(finiteIn(n, -GUI_LIMITS.udimOffset, GUI_LIMITS.udimOffset, `${label} offset`))) throw new ArcaneError('PROPERTY', `${label} offsets are whole pixels.`);
    });
    return;
  }
  if (spec === 'font') {
    const face = object(v, label); keys(face, ['type', 'family', 'weight', 'style']);
    if (face.type !== 'Font' || !FONT_FAMILIES.includes(face.family as typeof FONT_FAMILIES[number])) throw new ArcaneError('PROPERTY', `${label} must be {type:'Font', family} with a built-in family: ${FONT_FAMILIES.join(', ')}.`);
    if (face.weight !== undefined && !FONT_WEIGHTS.includes(face.weight as typeof FONT_WEIGHTS[number])) throw new ArcaneError('PROPERTY', `${label} weight must be one of ${FONT_WEIGHTS.join(', ')}.`);
    if (face.style !== undefined && face.style !== 'Normal' && face.style !== 'Italic') throw new ArcaneError('PROPERTY', `${label} style must be Normal or Italic.`);
    return;
  }
  if (spec === 'content') { contentId(v, label); return; }
  if (spec === 'audio') { audioId(v, label); return; }
  if (spec === 'color') { const c = tag(v, 'Color3', label); if (c.length !== 3) throw new ArcaneError('PROPERTY', `${label} needs three channels.`); triple(c, 0, 1, label); return; }
  if (isRefKind(spec)) {
    const t = object(v, label), wanted = EFFECT_REF_CLASSES[spec];
    if (t.type !== 'Ref') throw new ArcaneError('PROPERTY', `${label} must be a Ref to ${wanted === 'Attachment' ? 'an' : 'a'} ${wanted}.`);
    resolveRef(t, spec); return;
  }
  if (spec === 'colorSequence') {
    for (const point of keypoints(tag(v, 'ColorSequence', label), 4, label)) { if (point.length !== 4) throw new ArcaneError('PROPERTY', `${label} keypoints are [time,r,g,b].`); triple(point.slice(1), 0, 1, label); }
    return;
  }
  if (spec[0] === 'enum') { if (typeof v !== 'string' || !spec[2].includes(v)) throw new ArcaneError('PROPERTY', `${label} must be one of ${spec[2].join(', ')}.`); return; }
  const [kind, low, high] = spec;
  if (kind === 'number' || kind === 'integer') { finiteIn(v, low, high, label); if (kind === 'integer' && !Number.isInteger(v)) throw new ArcaneError('PROPERTY', `${label} must be an integer.`); return; }
  if (kind === 'vector3') { const value = tag(v, 'Vector3', label); if (value.length !== 3) throw new ArcaneError('PROPERTY', `${label} needs three numbers.`); triple(value, low, high, label); return; }
  if (kind === 'vector2') { const value = tag(v, 'Vector2', label); if (value.length !== 2) throw new ArcaneError('PROPERTY', `${label} needs two numbers.`); value.forEach(n => finiteIn(n, low, high, label)); return; }
  if (kind === 'range') {
    const value = tag(v, 'NumberRange', label);
    if (value.length !== 2) throw new ArcaneError('PROPERTY', `${label} needs [min,max].`);
    const [min, max] = value.map(n => finiteIn(n, low, high, label)) as [number, number];
    if (min > max) throw new ArcaneError('PROPERTY', `${label} min must not exceed max.`);
    return;
  }
  for (const point of keypoints(tag(v, 'NumberSequence', label), 3, label)) {
    finiteIn(point[1], low, high, label);
    if (point.length === 3) finiteIn(point[2], 0, (high - low) / 2, `${label} envelope`);
  }
}
export function validateEffectProperties(value: unknown, className: EffectClass | GuiClass, resolveRef: (tagged: Record<string, unknown>, kind: EffectRefKind) => void): Record<string, Json> {
  const properties = jsonObject(value ?? {});
  if (Object.keys(properties).length > EFFECT_LIMITS.properties) throw new ArcaneError('INPUT', 'Too many effect properties.');
  if (Object.hasOwn(properties, 'Name')) throw new ArcaneError('PROPERTY', 'Use the name field.');
  for (const [key, v] of Object.entries(properties)) validateEffectProperty(className, key, v, resolveRef);
  const min = properties.RollOffMinDistance, max = properties.RollOffMaxDistance;
  if (typeof min === 'number' && typeof max === 'number' && min > max) throw new ArcaneError('PROPERTY', `${className}.RollOffMinDistance must not exceed RollOffMaxDistance.`);
  if (typeof properties.Health === 'number' && typeof properties.MaxHealth === 'number' && properties.Health > properties.MaxHealth) throw new ArcaneError('PROPERTY', `${className}.Health must not exceed MaxHealth.`);
  // GUI cross-field rules (mirrored in Properties.luau): one font source; minimums never above maximums.
  if (Object.hasOwn(properties, 'Font') && Object.hasOwn(properties, 'FontFace')) throw new ArcaneError('PROPERTY', `${className}: set Font or FontFace, not both.`);
  const minText = properties.MinTextSize, maxText = properties.MaxTextSize;
  if (typeof minText === 'number' && typeof maxText === 'number' && minText > maxText) throw new ArcaneError('PROPERTY', `${className}.MinTextSize must not exceed MaxTextSize.`);
  const minSize = (properties.MinSize as { value?: number[] } | undefined)?.value, maxSize = (properties.MaxSize as { value?: number[] } | undefined)?.value;
  if (minSize && maxSize && (minSize[0]! > maxSize[0]! || minSize[1]! > maxSize[1]!)) throw new ArcaneError('PROPERTY', `${className}.MinSize must not exceed MaxSize.`);
  return properties;
}
/** GUI classes take no Ref-valued properties. */
export function validateGuiProperties(value: unknown, className: GuiClass): Record<string, Json> {
  return validateEffectProperties(value, className, () => { throw new ArcaneError('PROPERTY', `${className} takes no references.`); });
}

/** New GUI values retain the creation allowlist; a descendant's name can also be edited. */
export function validateGuiEditProperties(value: unknown, className: GuiClass): Record<string, Json> {
  const p = jsonObject(value), gui = { ...p }; delete gui.Name;
  if (Object.keys(p).length > MAX_PROPERTIES) throw new ArcaneError('INPUT', 'Too many GUI properties.');
  validateGuiProperties(gui, className);
  if (p.Name !== undefined) textField(p.Name, 'instance name', 100);
  return p;
}

/** Linked native values must also be observed before a write can retain them for restoration. */
export function guiEditBaselineNames(className: GuiClass, properties: Record<string, Json>): string[] {
  const names = new Set(Object.keys(properties));
  if (names.has('Font') || names.has('FontFace')) { names.add('Font'); names.add('FontFace'); }
  if (className === 'UISizeConstraint' && (names.has('MinSize') || names.has('MaxSize'))) { names.add('MinSize'); names.add('MaxSize'); }
  if (className === 'UITextSizeConstraint' && (names.has('MinTextSize') || names.has('MaxTextSize'))) { names.add('MinTextSize'); names.add('MaxTextSize'); }
  return [...names].sort();
}

/** Baselines are canonical observations, not new writes: do not round, clamp or apply intake ranges. */
export function validateGuiBaseline(value: unknown, className: GuiClass): Record<string, Json> {
  const p = jsonObject(value), table = GUI_PROPERTIES[className] as Record<string, EffectKind>;
  if (Object.keys(p).length > EFFECT_LIMITS.properties) throw new ArcaneError('INPUT', 'Too many GUI baseline properties.');
  for (const [name, observed] of Object.entries(p)) {
    const spec = name === 'Name' ? 'text' : Object.hasOwn(table, name) ? table[name] : undefined;
    const label = className + '.' + name;
    const fail = (): never => { throw new ArcaneError('PROPERTY', label + ' needs its exact typed scene_inspect value.'); };
    if (!spec) fail();
    const kind = typeof spec === 'string' ? spec : spec![0];
    if (kind === 'boolean') { if (typeof observed !== 'boolean') fail(); continue; }
    if (kind === 'text' || kind === 'content') { if (typeof observed !== 'string' || Buffer.byteLength(observed, 'utf8') > 65536) fail(); continue; }
    if (kind === 'number' || kind === 'integer') { if (typeof observed !== 'number' || !Number.isFinite(observed)) fail(); continue; }
    if (kind === 'enum') { if (typeof observed !== 'string' || !observed.length || observed.length > 128) fail(); continue; }
    if (kind === 'font') {
      const face = object(observed, label); keys(face, ['type', 'family', 'weight', 'style']);
      if (face.type !== 'Font' || typeof face.family !== 'string' || !face.family.length || face.family.length > 2048 ||
        !FONT_WEIGHTS.includes(face.weight as typeof FONT_WEIGHTS[number]) || (face.style !== 'Normal' && face.style !== 'Italic')) fail();
      continue;
    }
    const types: Record<string, [string, number]> = { udim: ['UDim', 2], udim2: ['UDim2', 4], color: ['Color3', 3], vector2: ['Vector2', 2], vector3: ['Vector3', 3] };
    const simple = types[kind];
    if (simple) {
      const numbers = tag(observed, simple[0], label) as number[];
      if (numbers.length !== simple[1] || numbers.some(n => typeof n !== 'number' || !Number.isFinite(n))) fail();
      if ((kind === 'udim' || kind === 'udim2') && numbers.some((n, i) => i % 2 === 1 && (!Number.isInteger(n) || n < -2147483648 || n > 2147483647))) fail();
      continue;
    }
    if (kind !== 'sequence' && kind !== 'colorSequence') fail();
    const points = tag(observed, kind === 'sequence' ? 'NumberSequence' : 'ColorSequence', label) as unknown[];
    if (points.length < 2 || points.length > 64) fail();
    let last = -1;
    for (const [index, point] of points.entries()) {
      if (!Array.isArray(point) || point.length !== (kind === 'sequence' ? 3 : 4) || point.some(n => typeof n !== 'number' || !Number.isFinite(n)) ||
        point[0] < 0 || point[0] > 1 || point[0] <= last || index === 0 && point[0] !== 0 || index === points.length - 1 && point[0] !== 1) fail();
      last = (point as number[])[0]!;
    }
  }
  return p;
}

/** scene.build effect item: parent is the root/group, a part item or an Attachment/Sound/SoundGroup effect item;
 * Attachment0/1 (SoundGroup) are {type:'Ref', item:n} naming an EARLIER Attachment (SoundGroup) effect item of the same build. */
function validateBuildEffect(item: Record<string, unknown>, kinds: string[], session: StudioSession): Json {
  requireEffects(session, 'effects classes');
  keys(item, ['kind', 'className', 'name', 'parent', 'properties', 'key']);
  if (!isEffectClass(item.className)) throw new ArcaneError('CLASS', 'Unsupported effect class.');
  requireCharacters(session, item.className);
  const className = item.className, parent = item.parent as number, self = kinds.length;
  const parentKind = parent === 0 ? 'group' : kinds[parent - 1] ?? '';
  const host: EffectHost | null = parentKind === 'part' || parentKind === 'group' ? parentKind
    : parentKind.startsWith('effect:') && Object.hasOwn(EFFECT_HOST_CLASSES, parentKind.slice(7)) ? EFFECT_HOST_CLASSES[parentKind.slice(7)]! : null;
  if (!host || !EFFECT_HOSTS[className].includes(host)) throw new ArcaneError('INPUT', `${className} must be inside a ${EFFECT_HOSTS[className].join(' or ')} item.`);
  const properties = validateEffectProperties(item.properties, className, (t, kind) => {
    keys(t, ['type', 'item']);
    const wanted = EFFECT_REF_CLASSES[kind];
    if (!Number.isInteger(t.item) || (t.item as number) < 1 || (t.item as number) >= self || kinds[(t.item as number) - 1] !== 'effect:' + wanted) throw new ArcaneError('INPUT', `${wanted} refs must name an earlier ${wanted} item of this build.`);
  });
  return { ...item, properties } as Json;
}
function requireEffects(session: StudioSession, feature: string, capability: string = STUDIO_EFFECTS_CAPABILITY): void {
  if (!session.capabilities.includes(capability)) throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `The connected Arcane Studio plugin (${session.pluginVersion}) predates ${feature}. Update the Studio plugin from Arcane, restart Studio and connect again. No command was queued.`);
}
const requireGui = (session: StudioSession) => requireEffects(session, 'direct GUI building', STUDIO_GUI_CAPABILITY);
function requireGuiFlex(session: StudioSession, className: GuiClass, properties: unknown): void {
  const flex = className === 'UIFlexItem' || className === 'UIListLayout' && properties !== null && typeof properties === 'object' &&
    ['Wraps', 'HorizontalFlex', 'VerticalFlex', 'ItemLineAlignment'].some(name => Object.hasOwn(properties, name));
  if (flex) requireEffects(session, 'responsive GUI flex layouts', STUDIO_GUI_FLEX_CAPABILITY);
}
const requireCharacters = (session: StudioSession, className: EffectClass) => {
  if (CHARACTER_CLASSES.includes(className)) requireEffects(session, 'character classes (Humanoid, HumanoidDescription, AnimationController, Animator)', STUDIO_CHARACTERS_CAPABILITY);
};

// ---- GUI classes (scene.create / scene.build). Same typed-spec machinery as effects; Properties.luau mirrors this exact table. ----
/** Built-in font families only (rbxasset://fonts/families/<Family>.json). Never uploaded or URL fonts. */
export const FONT_FAMILIES = ['BuilderSans', 'SourceSansPro', 'GothamSSm', 'Montserrat', 'Roboto', 'RobotoMono', 'RobotoCondensed', 'Arial', 'Oswald', 'FredokaOne',
  'Bangers', 'Creepster', 'DenkOne', 'Fondamento', 'GrenzeGotisch', 'IndieFlower', 'JosefinSans', 'Jura', 'Kalam', 'LuckiestGuy', 'Merriweather', 'Michroma',
  'Nunito', 'PatrickHand', 'PermanentMarker', 'PressStart2P', 'Sarpanch', 'SpecialElite', 'TitilliumWeb', 'Ubuntu', 'AmaticSC'] as const;
export const FONT_WEIGHTS = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Heavy'] as const;
/** Legacy Enum.Font names (built-in). */
export const FONT_NAMES = ['SourceSans', 'SourceSansBold', 'SourceSansSemibold', 'SourceSansLight', 'SourceSansItalic', 'Gotham', 'GothamMedium', 'GothamBold', 'GothamBlack',
  'BuilderSans', 'BuilderSansMedium', 'BuilderSansBold', 'BuilderSansExtraBold', 'Arial', 'ArialBold', 'Roboto', 'RobotoMono', 'RobotoCondensed',
  'Oswald', 'FredokaOne', 'Bangers', 'Creepster', 'DenkOne', 'Fondamento', 'GrenzeGotisch', 'IndieFlower', 'JosefinSans', 'Jura', 'Kalam', 'LuckiestGuy', 'Merriweather',
  'Michroma', 'Nunito', 'PatrickHand', 'PermanentMarker', 'Sarpanch', 'SpecialElite', 'TitilliumWeb', 'Ubuntu', 'AmaticSC', 'Code', 'Arcade', 'SciFi', 'Cartoon', 'Fantasy', 'Antique'] as const;
/** Bounded single-line display text: no control characters (C0, DEL, C1) and well-formed UTF-16. */
export function guiText(value: unknown, label: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > GUI_LIMITS.textBytes || /[\x00-\x1f\x7f-\x9f]/.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw new ArcaneError('PROPERTY', `${label} must be text of at most ${GUI_LIMITS.textBytes} UTF-8 bytes without control characters.`);
  return value;
}
const UNIT = ['number', 0, 1] as const;
const AUTOMATIC_SIZE = ['enum', 'AutomaticSize', ['None', 'X', 'Y', 'XY']] as const;
const GUI_OBJECT = { Size: 'udim2', Position: 'udim2', AnchorPoint: ['vector2', 0, 1], BackgroundColor3: 'color', BackgroundTransparency: UNIT, BorderSizePixel: ['integer', 0, 100],
  Visible: 'boolean', ZIndex: ['integer', -1000, 1000], LayoutOrder: ['integer', -1000000, 1000000], AutomaticSize: AUTOMATIC_SIZE, ClipsDescendants: 'boolean',
  Rotation: ['number', -360, 360], Active: 'boolean', Selectable: 'boolean' } as const;
const GUI_TEXT = { Text: 'text', TextColor3: 'color', TextSize: ['integer', 1, 100], TextScaled: 'boolean', TextWrapped: 'boolean',
  TextXAlignment: ['enum', 'TextXAlignment', ['Left', 'Center', 'Right']], TextYAlignment: ['enum', 'TextYAlignment', ['Top', 'Center', 'Bottom']],
  TextTransparency: UNIT, TextStrokeColor3: 'color', TextStrokeTransparency: UNIT, Font: ['enum', 'Font', FONT_NAMES], FontFace: 'font',
  TextTruncate: ['enum', 'TextTruncate', ['None', 'AtEnd']], LineHeight: ['number', 0.5, 3] } as const;
const GUI_IMAGE = { Image: 'content', ImageColor3: 'color', ImageTransparency: UNIT, ScaleType: ['enum', 'ScaleType', ['Stretch', 'Slice', 'Tile', 'Fit', 'Crop']], TileSize: 'udim2' } as const;
const GUI_LAYER = { Enabled: 'boolean', ResetOnSpawn: 'boolean', ZIndexBehavior: ['enum', 'ZIndexBehavior', ['Global', 'Sibling']] } as const;
const GUI_WORLD = { AlwaysOnTop: 'boolean', MaxDistance: ['number', 0, 100000], LightInfluence: UNIT, Brightness: ['number', 0, 20], ClipsDescendants: 'boolean' } as const;
const GUI_LAYOUT = { FillDirection: ['enum', 'FillDirection', ['Horizontal', 'Vertical']], HorizontalAlignment: ['enum', 'HorizontalAlignment', ['Left', 'Center', 'Right']],
  VerticalAlignment: ['enum', 'VerticalAlignment', ['Top', 'Center', 'Bottom']], SortOrder: ['enum', 'SortOrder', ['LayoutOrder', 'Name']] } as const;
const FLEX_ALIGNMENT = ['enum', 'UIFlexAlignment', ['None', 'Fill', 'SpaceAround', 'SpaceBetween', 'SpaceEvenly']] as const;
const ITEM_LINE_ALIGNMENT = ['enum', 'ItemLineAlignment', ['Automatic', 'Start', 'Center', 'End', 'Stretch']] as const;
/** Fixed GUI allowlist: class -> property -> kind. UDim2 = [xScale,xOffset,yScale,yOffset], UDim = [scale,offset] (offsets whole pixels). */
export const GUI_PROPERTIES = Object.freeze({
  ScreenGui: { ...GUI_LAYER, IgnoreGuiInset: 'boolean', DisplayOrder: ['integer', -1000, 1000], ScreenInsets: ['enum', 'ScreenInsets', ['None', 'DeviceSafeInsets', 'CoreUISafeInsets', 'TopbarSafeInsets']] },
  SurfaceGui: { ...GUI_LAYER, ...GUI_WORLD, Face: ['enum', 'NormalId', NORMAL_IDS], SizingMode: ['enum', 'SurfaceGuiSizingMode', ['FixedSize', 'PixelsPerStud']],
    PixelsPerStud: ['number', 1, 500], CanvasSize: ['vector2', 1, 8192] },
  BillboardGui: { ...GUI_LAYER, ...GUI_WORLD, Size: 'udim2', StudsOffset: ['vector3', -1000, 1000], StudsOffsetWorldSpace: ['vector3', -1000, 1000] },
  Frame: GUI_OBJECT,
  CanvasGroup: { ...GUI_OBJECT, GroupTransparency: UNIT, GroupColor3: 'color' },
  ScrollingFrame: { ...GUI_OBJECT, CanvasSize: 'udim2', ScrollBarThickness: ['integer', 0, 50], ScrollingDirection: ['enum', 'ScrollingDirection', ['X', 'Y', 'XY']],
    AutomaticCanvasSize: AUTOMATIC_SIZE, ScrollBarImageColor3: 'color', ScrollBarImageTransparency: UNIT, ScrollingEnabled: 'boolean',
    VerticalScrollBarInset: ['enum', 'ScrollBarInset', ['None', 'ScrollBar', 'Always']] },
  TextLabel: { ...GUI_OBJECT, ...GUI_TEXT },
  TextButton: { ...GUI_OBJECT, ...GUI_TEXT, AutoButtonColor: 'boolean' },
  TextBox: { ...GUI_OBJECT, ...GUI_TEXT, PlaceholderText: 'text', PlaceholderColor3: 'color', ClearTextOnFocus: 'boolean', TextEditable: 'boolean', MultiLine: 'boolean' },
  ImageLabel: { ...GUI_OBJECT, ...GUI_IMAGE },
  ImageButton: { ...GUI_OBJECT, ...GUI_IMAGE, AutoButtonColor: 'boolean', HoverImage: 'content', PressedImage: 'content' },
  ViewportFrame: { ...GUI_OBJECT, Ambient: 'color', LightColor: 'color', ImageColor3: 'color', ImageTransparency: UNIT },
  UICorner: { CornerRadius: 'udim' },
  UIStroke: { Color: 'color', Thickness: ['number', 0, 50], Transparency: UNIT, ApplyStrokeMode: ['enum', 'ApplyStrokeMode', ['Contextual', 'Border']],
    LineJoinMode: ['enum', 'LineJoinMode', ['Round', 'Bevel', 'Miter']], Enabled: 'boolean' },
  UIGradient: { Color: 'colorSequence', Transparency: ['sequence', 0, 1], Rotation: ['number', -360, 360], Offset: ['vector2', -1, 1], Enabled: 'boolean' },
  UIPadding: { PaddingTop: 'udim', PaddingBottom: 'udim', PaddingLeft: 'udim', PaddingRight: 'udim' },
  UIListLayout: { ...GUI_LAYOUT, Padding: 'udim', Wraps: 'boolean', HorizontalFlex: FLEX_ALIGNMENT, VerticalFlex: FLEX_ALIGNMENT, ItemLineAlignment: ITEM_LINE_ALIGNMENT },
  UIGridLayout: { ...GUI_LAYOUT, CellSize: 'udim2', CellPadding: 'udim2', StartCorner: ['enum', 'StartCorner', ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight']],
    FillDirectionMaxCells: ['integer', 0, 100] },
  UIAspectRatioConstraint: { AspectRatio: ['number', 0.01, 100], AspectType: ['enum', 'AspectType', ['FitWithinMaxSize', 'ScaleWithParentSize']],
    DominantAxis: ['enum', 'DominantAxis', ['Width', 'Height']] },
  UISizeConstraint: { MinSize: ['vector2', 0, 100000], MaxSize: ['vector2', 0, 100000] },
  UITextSizeConstraint: { MinTextSize: ['integer', 1, 100], MaxTextSize: ['integer', 1, 100] },
  UIScale: { Scale: ['number', 0.01, 20] },
  UIFlexItem: { FlexMode: ['enum', 'UIFlexMode', ['None', 'Grow', 'Shrink', 'Fill', 'Custom']], GrowRatio: ['number', 0, 100], ShrinkRatio: ['number', 0, 100], ItemLineAlignment: ITEM_LINE_ALIGNMENT },
} as const satisfies Record<string, Record<string, EffectKind>>);
export type GuiClass = keyof typeof GUI_PROPERTIES;
export const GUI_CLASSES = Object.keys(GUI_PROPERTIES) as GuiClass[];
export const isGuiClass = (value: unknown): value is GuiClass => typeof value === 'string' && Object.hasOwn(GUI_PROPERTIES, value);
/** Where GUI lives: the StarterGui root, a Model/Folder (template holder), a part/Attachment (world GUIs),
 * a ScreenGui/SurfaceGui/BillboardGui ('layer') or a GuiObject ('guiObject'). */
export type GuiHost = 'starterGui' | 'group' | 'part' | 'attachment' | 'layer' | 'guiObject';
const GUI_ELEMENT_HOSTS = ['layer', 'guiObject'] as const, GUI_MODIFIER_HOSTS = ['guiObject'] as const;
export const GUI_HOSTS: Readonly<Record<GuiClass, readonly GuiHost[]>> = Object.freeze({
  ScreenGui: ['starterGui', 'group'], SurfaceGui: ['part'], BillboardGui: ['part', 'attachment'],
  Frame: GUI_ELEMENT_HOSTS, CanvasGroup: GUI_ELEMENT_HOSTS, ScrollingFrame: GUI_ELEMENT_HOSTS, TextLabel: GUI_ELEMENT_HOSTS, TextButton: GUI_ELEMENT_HOSTS,
  TextBox: GUI_ELEMENT_HOSTS, ImageLabel: GUI_ELEMENT_HOSTS, ImageButton: GUI_ELEMENT_HOSTS, ViewportFrame: GUI_ELEMENT_HOSTS,
  UICorner: GUI_MODIFIER_HOSTS, UIStroke: GUI_MODIFIER_HOSTS, UIGradient: GUI_MODIFIER_HOSTS, UIPadding: GUI_MODIFIER_HOSTS,
  UIAspectRatioConstraint: GUI_MODIFIER_HOSTS, UISizeConstraint: GUI_MODIFIER_HOSTS, UITextSizeConstraint: GUI_MODIFIER_HOSTS,
  UIListLayout: GUI_ELEMENT_HOSTS, UIGridLayout: GUI_ELEMENT_HOSTS, UIScale: GUI_ELEMENT_HOSTS, UIFlexItem: GUI_MODIFIER_HOSTS,
});
/** GUI classes that host other GUI items, and the host kind they provide. */
export const GUI_HOST_CLASSES: Readonly<Record<string, 'layer' | 'guiObject'>> = Object.freeze({
  ScreenGui: 'layer', SurfaceGui: 'layer', BillboardGui: 'layer',
  Frame: 'guiObject', CanvasGroup: 'guiObject', ScrollingFrame: 'guiObject', TextLabel: 'guiObject', TextButton: 'guiObject', TextBox: 'guiObject',
  ImageLabel: 'guiObject', ImageButton: 'guiObject', ViewportFrame: 'guiObject',
});
function specTable(className: string): Record<string, EffectKind> {
  if (Object.hasOwn(EFFECT_PROPERTIES, className)) return EFFECT_PROPERTIES[className as EffectClass] as Record<string, EffectKind>;
  if (Object.hasOwn(GUI_PROPERTIES, className)) return GUI_PROPERTIES[className as GuiClass] as Record<string, EffectKind>;
  throw new ArcaneError('CLASS', 'Unsupported effect or GUI class.');
}
function hostError(className: GuiClass): ArcaneError {
  return new ArcaneError('CLASS', `${className} must be inside ${GUI_HOSTS[className].map(host => ({ starterGui: 'StarterGui', group: 'a Model/Folder', part: 'a part', attachment: 'an Attachment',
    layer: 'a ScreenGui/SurfaceGui/BillboardGui', guiObject: 'a GuiObject (Frame, TextButton, ...)' })[host]).join(' or ')}.`);
}
/** One GUI prototype: element 1 is the root (parent 0); later elements name an earlier element (1-based) that hosts them. */
function validateGuiPrototype(value: unknown, session: StudioSession): Json[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCENE_BUILD_LIMITS.prototypeParts) throw new ArcaneError('INPUT', `A GUI prototype needs 1..${SCENE_BUILD_LIMITS.prototypeParts} elements.`);
  const classes: GuiClass[] = [];
  return value.map((raw, index) => {
    const element = object(raw, 'prototype element'); keys(element, ['className', 'name', 'parent', 'properties']);
    if (!isGuiClass(element.className)) throw new ArcaneError('CLASS', 'Unsupported GUI prototype class.');
    requireGuiFlex(session, element.className, element.properties);
    textField(element.name, 'element name', 100);
    const parent = element.parent ?? 0;
    if (index === 0 ? parent !== 0 : !Number.isInteger(parent) || (parent as number) < 1 || (parent as number) > index) throw new ArcaneError('INPUT', 'The first element is the prototype root (parent 0); later elements name an earlier element (1-based).');
    if (index > 0) {
      const host = GUI_HOST_CLASSES[classes[(parent as number) - 1]!];
      if (!host || !GUI_HOSTS[element.className].includes(host)) throw hostError(element.className);
    }
    classes.push(element.className);
    return { className: element.className, name: element.name as string, parent: parent as number, properties: validateGuiProperties(element.properties, element.className) };
  });
}
/** scene.build gui item: className + properties inside the root, a group, a part, an Attachment or an earlier GUI host item. */
function validateBuildGui(item: Record<string, unknown>, host: EffectHost | null, session: StudioSession): Json {
  requireGui(session);
  keys(item, ['kind', 'className', 'name', 'parent', 'properties', 'key']);
  if (!isGuiClass(item.className)) throw new ArcaneError('CLASS', 'Unsupported GUI class.');
  requireGuiFlex(session, item.className, item.properties);
  if (!host || !(GUI_HOSTS[item.className] as readonly string[]).includes(host)) throw hostError(item.className);
  return { ...item, properties: validateGuiProperties(item.properties, item.className) } as Json;
}
/** scene.build stamp item: one copy of a GUI prototype; properties override the prototype root's own properties. */
function validateBuildStamp(item: Record<string, unknown>, host: EffectHost | null, prototypes: Json[], session: StudioSession): Json {
  keys(item, ['kind', 'template', 'name', 'parent', 'properties', 'key']);
  const proto = Number.isInteger(item.template) ? prototypes[(item.template as number) - 1] as { gui?: { className: GuiClass; properties: Record<string, Json> }[] } | undefined : undefined;
  if (!proto || !proto.gui) throw new ArcaneError('INPUT', 'A stamp names an unknown GUI prototype index.');
  const root = proto.gui[0]!;
  requireGuiFlex(session, root.className, item.properties);
  if (!host || !(GUI_HOSTS[root.className] as readonly string[]).includes(host)) throw hostError(root.className);
  const properties = validateGuiProperties(item.properties, root.className);
  validateGuiProperties({ ...root.properties, ...properties }, root.className);
  return { ...item, properties } as Json;
}

/** Named looks expanded host-side to exact environment.apply values; explicit sections override per property. */
export const ENVIRONMENT_PRESETS = Object.freeze({
  clear_day: {
    lighting: { ClockTime: 13, Brightness: 3, ExposureCompensation: 0, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, ShadowSoftness: 0.15, Ambient: [0.05,0.05,0.06], OutdoorAmbient: [0.5,0.5,0.52], ColorShift_Top: [0,0,0], GlobalShadows: true },
    atmosphere: { Density: 0.25, Offset: 0.25, Haze: 1, Glare: 0.2, Color: [0.78,0.84,0.9], Decay: [0.55,0.62,0.7] },
    bloom: { Intensity: 0.3, Size: 24, Threshold: 1.6 },
    colorCorrection: { Brightness: 0, Contrast: 0.06, Saturation: 0.05, TintColor: [1,1,1] },
    sunRays: { Intensity: 0.05, Spread: 0.6 },
  },
  golden_hour: {
    lighting: { ClockTime: 17.6, Brightness: 2.5, ExposureCompensation: 0.2, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, ShadowSoftness: 0.25, Ambient: [0.08,0.06,0.05], OutdoorAmbient: [0.55,0.45,0.38], ColorShift_Top: [1,0.78,0.5], GlobalShadows: true },
    atmosphere: { Density: 0.32, Offset: 0.15, Haze: 1.8, Glare: 0.6, Color: [0.95,0.78,0.6], Decay: [0.9,0.55,0.35] },
    bloom: { Intensity: 0.6, Size: 30, Threshold: 1.2 },
    colorCorrection: { Brightness: 0.02, Contrast: 0.1, Saturation: 0.12, TintColor: [1,0.95,0.88] },
    sunRays: { Intensity: 0.12, Spread: 0.8 },
  },
  foggy_forest: {
    lighting: { ClockTime: 9.5, Brightness: 1.6, ExposureCompensation: 0, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.6, ShadowSoftness: 0.6, Ambient: [0.1,0.11,0.12], OutdoorAmbient: [0.42,0.46,0.48], ColorShift_Top: [0,0,0], GlobalShadows: true },
    atmosphere: { Density: 0.55, Offset: 0.05, Haze: 3, Glare: 0, Color: [0.72,0.78,0.8], Decay: [0.55,0.62,0.6] },
    bloom: { Intensity: 0.35, Size: 24, Threshold: 1.6 },
    colorCorrection: { Brightness: 0, Contrast: 0.05, Saturation: -0.15, TintColor: [0.93,0.98,1] },
    sunRays: { Intensity: 0.04, Spread: 0.5 },
  },
  night: {
    lighting: { ClockTime: 0, Brightness: 1, ExposureCompensation: 0.3, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, ShadowSoftness: 0.3, Ambient: [0.04,0.05,0.08], OutdoorAmbient: [0.18,0.22,0.32], ColorShift_Top: [0.6,0.7,1], GlobalShadows: true },
    atmosphere: { Density: 0.35, Offset: 0.1, Haze: 1, Glare: 0, Color: [0.35,0.42,0.6], Decay: [0.2,0.25,0.4] },
    bloom: { Intensity: 0.8, Size: 28, Threshold: 0.9 },
    colorCorrection: { Brightness: 0, Contrast: 0.12, Saturation: -0.25, TintColor: [0.85,0.9,1] },
    sunRays: { Intensity: 0, Spread: 0 },
  },
  horror: {
    lighting: { ClockTime: 0.5, Brightness: 0.4, ExposureCompensation: -0.3, EnvironmentDiffuseScale: 0.3, EnvironmentSpecularScale: 1, ShadowSoftness: 0.1, Ambient: [0.02,0.02,0.025], OutdoorAmbient: [0.08,0.08,0.1], ColorShift_Top: [0,0,0], GlobalShadows: true },
    atmosphere: { Density: 0.6, Offset: 0, Haze: 2.5, Glare: 0, Color: [0.25,0.27,0.28], Decay: [0.12,0.12,0.14] },
    bloom: { Intensity: 0.4, Size: 20, Threshold: 1.4 },
    colorCorrection: { Brightness: -0.05, Contrast: 0.25, Saturation: -0.45, TintColor: [0.9,1,0.95] },
    sunRays: { Intensity: 0, Spread: 0 },
  },
  sci_fi: {
    lighting: { ClockTime: 21, Brightness: 1.2, ExposureCompensation: 0, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, ShadowSoftness: 0.15, Ambient: [0.05,0.06,0.1], OutdoorAmbient: [0.2,0.24,0.35], ColorShift_Top: [0.6,0.8,1], GlobalShadows: true },
    atmosphere: { Density: 0.3, Offset: 0.2, Haze: 1.2, Glare: 0.3, Color: [0.45,0.55,0.75], Decay: [0.25,0.2,0.45] },
    bloom: { Intensity: 1, Size: 32, Threshold: 0.95 },
    colorCorrection: { Brightness: 0, Contrast: 0.15, Saturation: 0.1, TintColor: [0.9,0.97,1] },
    sunRays: { Intensity: 0.05, Spread: 0.4 },
  },
  // Forest looks tuned for Future lighting: technology rides along (explicit wins), a subtle DepthOfField and the built-in
  // Sky (no custom textures) are set, and SoundService gets Forest reverb when the Workspace grant allows it.
  'forest-morning': {
    technology: 'Future',
    lighting: { ClockTime: 7.4, GeographicLatitude: 48, Brightness: 2.4, ExposureCompensation: 0.15, EnvironmentDiffuseScale: 0.9, EnvironmentSpecularScale: 0.8, ShadowSoftness: 0.25, Ambient: [0.06,0.065,0.07], OutdoorAmbient: [0.38,0.4,0.44], ColorShift_Top: [1,0.82,0.6], GlobalShadows: true },
    atmosphere: { Density: 0.36, Offset: 0.12, Haze: 2.2, Glare: 0.45, Color: [0.85,0.82,0.76], Decay: [0.92,0.72,0.5] },
    bloom: { Intensity: 0.45, Size: 28, Threshold: 1.3 },
    colorCorrection: { Brightness: 0.01, Contrast: 0.08, Saturation: 0.06, TintColor: [1,0.97,0.92] },
    sunRays: { Intensity: 0.12, Spread: 0.75 },
    depthOfField: { FarIntensity: 0.08, FocusDistance: 60, InFocusRadius: 50, NearIntensity: 0 },
    sky: { CelestialBodiesShown: true, SunAngularSize: 16 },
    soundService: { AmbientReverb: 'Forest' },
  },
  'forest-noon': {
    technology: 'Future',
    lighting: { ClockTime: 12.5, GeographicLatitude: 40, Brightness: 3.2, ExposureCompensation: -0.1, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 1, ShadowSoftness: 0.12, Ambient: [0.06,0.065,0.07], OutdoorAmbient: [0.48,0.5,0.52], ColorShift_Top: [0.18,0.16,0.1], GlobalShadows: true },
    atmosphere: { Density: 0.28, Offset: 0.2, Haze: 1, Glare: 0.15, Color: [0.78,0.84,0.9], Decay: [0.6,0.68,0.74] },
    bloom: { Intensity: 0.3, Size: 24, Threshold: 1.6 },
    colorCorrection: { Brightness: 0, Contrast: 0.06, Saturation: 0.04, TintColor: [1,1,0.98] },
    sunRays: { Intensity: 0.05, Spread: 0.5 },
    depthOfField: { FarIntensity: 0.05, FocusDistance: 80, InFocusRadius: 50, NearIntensity: 0 },
    sky: { CelestialBodiesShown: true, SunAngularSize: 12 },
    soundService: { AmbientReverb: 'Forest' },
  },
  'forest-golden-hour': {
    technology: 'Future',
    lighting: { ClockTime: 17.7, GeographicLatitude: 45, Brightness: 2.2, ExposureCompensation: 0.25, EnvironmentDiffuseScale: 0.9, EnvironmentSpecularScale: 0.9, ShadowSoftness: 0.3, Ambient: [0.08,0.065,0.055], OutdoorAmbient: [0.5,0.42,0.36], ColorShift_Top: [1,0.72,0.42], GlobalShadows: true },
    atmosphere: { Density: 0.34, Offset: 0.1, Haze: 2, Glare: 0.7, Color: [0.96,0.78,0.6], Decay: [0.92,0.56,0.34] },
    bloom: { Intensity: 0.6, Size: 30, Threshold: 1.15 },
    colorCorrection: { Brightness: 0.02, Contrast: 0.1, Saturation: 0.12, TintColor: [1,0.94,0.86] },
    sunRays: { Intensity: 0.14, Spread: 0.85 },
    depthOfField: { FarIntensity: 0.1, FocusDistance: 50, InFocusRadius: 45, NearIntensity: 0 },
    sky: { CelestialBodiesShown: true, SunAngularSize: 18 },
    soundService: { AmbientReverb: 'Forest' },
  },
  'forest-overcast': {
    technology: 'Future',
    lighting: { ClockTime: 11, GeographicLatitude: 52, Brightness: 1.2, ExposureCompensation: 0.2, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.5, ShadowSoftness: 0.9, Ambient: [0.1,0.105,0.11], OutdoorAmbient: [0.52,0.55,0.56], ColorShift_Top: [0,0,0], GlobalShadows: true },
    atmosphere: { Density: 0.45, Offset: 0.04, Haze: 2.6, Glare: 0, Color: [0.74,0.77,0.79], Decay: [0.6,0.64,0.66] },
    bloom: { Intensity: 0.25, Size: 20, Threshold: 1.8 },
    colorCorrection: { Brightness: 0, Contrast: 0.04, Saturation: -0.12, TintColor: [0.95,0.98,1] },
    sunRays: { Intensity: 0, Spread: 0 },
    depthOfField: { FarIntensity: 0.12, FocusDistance: 40, InFocusRadius: 40, NearIntensity: 0 },
    sky: { CelestialBodiesShown: false },
    soundService: { AmbientReverb: 'Forest' },
  },
  'forest-dusk': {
    technology: 'Future',
    lighting: { ClockTime: 18.6, GeographicLatitude: 45, Brightness: 1, ExposureCompensation: 0.35, EnvironmentDiffuseScale: 0.7, EnvironmentSpecularScale: 0.8, ShadowSoftness: 0.5, Ambient: [0.05,0.05,0.08], OutdoorAmbient: [0.24,0.24,0.34], ColorShift_Top: [0.75,0.45,0.35], GlobalShadows: true },
    atmosphere: { Density: 0.4, Offset: 0.08, Haze: 2.2, Glare: 0.25, Color: [0.55,0.5,0.62], Decay: [0.62,0.38,0.32] },
    bloom: { Intensity: 0.7, Size: 30, Threshold: 1 },
    colorCorrection: { Brightness: 0, Contrast: 0.1, Saturation: -0.08, TintColor: [0.92,0.92,1] },
    sunRays: { Intensity: 0.04, Spread: 0.6 },
    depthOfField: { FarIntensity: 0.12, FocusDistance: 40, InFocusRadius: 35, NearIntensity: 0 },
    sky: { CelestialBodiesShown: true, StarCount: 1500, MoonAngularSize: 11 },
    soundService: { AmbientReverb: 'Forest' },
  },
} as const);
export type EnvironmentPreset = keyof typeof ENVIRONMENT_PRESETS;
export const ENVIRONMENT_PRESET_NAMES = Object.keys(ENVIRONMENT_PRESETS) as EnvironmentPreset[];
export const LIGHTING_TECHNOLOGIES = ['Future', 'ShadowMap', 'Voxel', 'Compatibility'] as const;
/** MaterialVariant base materials (the same physical part materials, never Air/Water). */
export const VARIANT_MAPS = ['ColorMap', 'NormalMap', 'RoughnessMap', 'MetalnessMap'] as const;
function validateMaterials(value: unknown): Json[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EFFECT_LIMITS.materials) throw new ArcaneError('INPUT', `Use 1..${EFFECT_LIMITS.materials} material variants.`);
  const names = new Set<string>();
  return value.map(raw => {
    const variant = object(raw, 'material variant'); keys(variant, ['name', 'baseMaterial', 'studsPerTile', 'override', ...VARIANT_MAPS]);
    const name = textField(variant.name, 'material variant name', 50);
    if (!/^[A-Za-z0-9_ -]{1,50}$/.test(name) || names.has(name)) throw new ArcaneError('INPUT', 'Material variant names are unique [A-Za-z0-9_ -]{1,50}.');
    names.add(name);
    if (!MATERIALS.includes(variant.baseMaterial as typeof MATERIALS[number])) throw new ArcaneError('PROPERTY', 'Unsupported material variant base material.');
    if (variant.studsPerTile !== undefined) finiteIn(variant.studsPerTile, 0.1, 1000, 'studsPerTile');
    if (variant.override !== undefined && typeof variant.override !== 'boolean') throw new ArcaneError('INPUT', 'override must be a boolean.');
    for (const map of VARIANT_MAPS) if (variant[map] !== undefined) contentId(variant[map], map);
    return variant as Json;
  });
}

export const TERRAIN_MATERIALS =['Air', 'Grass', 'LeafyGrass', 'Ground', 'Mud', 'Rock', 'Slate', 'Sand', 'Sandstone', 'Limestone', 'Basalt', 'Granite', 'Pebble',
  'Snow', 'Ice', 'Glacier', 'Salt', 'Cobblestone', 'Asphalt', 'Concrete', 'Brick', 'WoodPlanks', 'CrackedLava', 'Water'] as const;
export const TERRAIN_SHAPES = ['Block', 'Ball', 'Cylinder', 'Wedge'] as const;
/** Fixed Lighting/effect allowlist: numeric [low, high], 'color' (0..1 RGB) or 'boolean'. */
export const ENVIRONMENT_PROPERTIES = Object.freeze({
  lighting: { ClockTime: [0, 24], Brightness: [0, 10], ExposureCompensation: [-3, 3], EnvironmentDiffuseScale: [0, 1], EnvironmentSpecularScale: [0, 1],
    ShadowSoftness: [0, 1], FogStart: [0, 100000], FogEnd: [0, 100000], Ambient: 'color', OutdoorAmbient: 'color', ColorShift_Top: 'color', FogColor: 'color', GlobalShadows: 'boolean',
    GeographicLatitude: [-90, 90] },
  atmosphere: { Density: [0, 1], Offset: [0, 1], Haze: [0, 10], Glare: [0, 10], Color: 'color', Decay: 'color' },
  bloom: { Intensity: [0, 2], Size: [0, 56], Threshold: [0, 4] },
  colorCorrection: { Brightness: [-1, 1], Contrast: [-1, 1], Saturation: [-1, 1], TintColor: 'color' },
  sunRays: { Intensity: [0, 1], Spread: [0, 1] },
  // Lighting children: DepthOfFieldEffect, and the built-in Sky (its skybox textures are never set here).
  depthOfField: { FarIntensity: [0, 1], FocusDistance: [0, 200], InFocusRadius: [0, 50], NearIntensity: [0, 1] },
  sky: { CelestialBodiesShown: 'boolean', StarCount: [0, 5000], SunAngularSize: [0, 60], MoonAngularSize: [0, 60] },
} as const);
export type EnvironmentSection = keyof typeof ENVIRONMENT_PROPERTIES;
const ENVIRONMENT_EXTRAS = ['preset', 'technology', 'terrainDecoration', 'materials', 'soundService'] as const;
/** SoundService world-audio settings (environment.apply soundService). The plugin re-validates this table (Operations.luau). */
export const REVERB_TYPES = ['NoReverb', 'GenericReverb', 'PaddedCell', 'Room', 'Bathroom', 'LivingRoom', 'StoneRoom', 'Auditorium', 'ConcertHall', 'Cave', 'Arena',
  'Hangar', 'CarpetedHallway', 'Hallway', 'StoneCorridor', 'Alley', 'Forest', 'City', 'Mountains', 'Quarry', 'Plain', 'ParkingLot', 'SewerPipe', 'UnderWater'] as const;
export const SOUND_SERVICE_PROPERTIES = Object.freeze({ AmbientReverb: REVERB_TYPES, DistanceFactor: [0.1, 100], DopplerScale: [0, 10], RolloffScale: [0, 10] } as const);
function validateSoundService(value: unknown): Record<string, Json> {
  const values = object(value, 'soundService'); keys(values, Object.keys(SOUND_SERVICE_PROPERTIES));
  if (!Object.keys(values).length) throw new ArcaneError('INPUT', 'Set at least one soundService property.');
  for (const [key, v] of Object.entries(values)) {
    if (key === 'AmbientReverb') { if (!REVERB_TYPES.includes(v as typeof REVERB_TYPES[number])) throw new ArcaneError('PROPERTY', `AmbientReverb must be one of ${REVERB_TYPES.join(', ')}.`); }
    else { const [low, high] = SOUND_SERVICE_PROPERTIES[key as 'DistanceFactor']; finiteIn(v, low, high, key); }
  }
  return values as Record<string, Json>;
}
/** Expands a named preset into exact section values (explicit section values win) and checks the
 * effects-capability extras. The plugin never receives a preset name. */
function expandEnvironment(input: Record<string, Json>, session: StudioSession): Record<string, Json> {
  if (!ENVIRONMENT_EXTRAS.some(key => input[key] !== undefined)) return input;
  requireEffects(session, 'environment presets, Lighting.Technology, Terrain decoration and material variants');
  const { preset, ...a } = input;
  if (preset !== undefined) {
    if (typeof preset !== 'string' || !Object.hasOwn(ENVIRONMENT_PRESETS, preset)) throw new ArcaneError('INPUT', `preset must be one of ${ENVIRONMENT_PRESET_NAMES.join(', ')}.`);
    for (const [section, values] of Object.entries(ENVIRONMENT_PRESETS[preset as EnvironmentPreset]) as [string, Json][]) {
      if (typeof values === 'string') { a[section] ??= values; continue; } // technology: an explicit value wins
      // Forest reverb is a bonus: a Lighting-only grant still gets the look.
      if (section === 'soundService' && !session.allowedRoots.includes('Workspace')) continue;
      a[section] = { ...structuredClone(values) as Record<string, Json>, ...(a[section] === undefined ? {} : object(a[section], section) as Record<string, Json>) };
    }
  }
  if (a.technology !== undefined) {
    if (!LIGHTING_TECHNOLOGIES.includes(a.technology as typeof LIGHTING_TECHNOLOGIES[number])) throw new ArcaneError('PROPERTY', `technology must be ${LIGHTING_TECHNOLOGIES.join(', ')}.`);
    if (!session.allowedRoots.includes('Lighting')) throw new ArcaneError('SCOPE', 'Lighting.Technology requires the Lighting grant.');
  }
  if (a.terrainDecoration !== undefined) {
    if (typeof a.terrainDecoration !== 'boolean') throw new ArcaneError('INPUT', 'terrainDecoration must be a boolean.');
    if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Terrain decoration requires the Workspace grant.');
  }
  if (a.materials !== undefined) {
    if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Material variants require the Workspace grant.');
    a.materials = validateMaterials(a.materials);
  }
  if (a.soundService !== undefined) {
    if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'SoundService settings require the Workspace grant.');
    a.soundService = validateSoundService(a.soundService);
  }
  return a;
}
/** Forest looks (forest-* presets), the depthOfField/sky Lighting children and GeographicLatitude reach Studio only
 * through a plugin advertising environment.forest; an older plugin would refuse them with a generic error. */
export const FOREST_ENVIRONMENT_SECTIONS = ['depthOfField', 'sky'] as const;
function requireForest(input: Record<string, Json>, session: StudioSession): void {
  const lighting = input.lighting;
  const forest = typeof input.preset === 'string' && input.preset.startsWith('forest-') || FOREST_ENVIRONMENT_SECTIONS.some(key => input[key] !== undefined)
    || lighting !== null && typeof lighting === 'object' && !Array.isArray(lighting) && Object.hasOwn(lighting, 'GeographicLatitude');
  if (forest) requireEffects(session, 'forest lighting (forest-* presets, depthOfField, sky and GeographicLatitude)', STUDIO_ENVIRONMENT_FOREST_CAPABILITY);
}
function validateEnvironment(input: Record<string, Json>, session: StudioSession): Record<string, Json> {
  const sections = Object.keys(ENVIRONMENT_PROPERTIES) as EnvironmentSection[];
  keys(input, ['terrain', ...sections, ...ENVIRONMENT_EXTRAS]);
  requireForest(input, session);
  const a = expandEnvironment(input, session);
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

const CONVERTED_PACKET_BODIES={
  begin:['projectId','assetId','revisionId','sourceSha256','origin','identityScheme','preparedDigest','target','conversionRequest','conversionRequestDigest','graph','producer','files','sourceDocuments','conversion','placement','bounds','anchors','objectCount','textureCount','texturesPresent','binaryByteLength','aggregateEncodedByteLength','chunkCount','delta'],
  node:['node'],texture:['texture'],object:['object','association','material','provenance','primitives'],
  chunk:['sourceObjectId','primitiveIndex','streamId','semantic','bufferSha256','offset','byteLength','sha256','encoding','data'],seal:['precedingPacketCount','precedingByteLength','contentDigest'],
} as const;
const CONVERTED_HASH=/^[a-f0-9]{64}(?![\s\S])/;
const CONVERTED_NODE=/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?(?![\s\S])/;
const CONVERTED_OBJECT=/^arcane_[a-f0-9]{64}(?![\s\S])/;
function convertedInput():never {throw new ArcaneError('INPUT','Converted asset packet or logical reconstruction summary is invalid.');}
function convertedClosed(value:unknown,fields:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
  const record=object(value),names=Object.keys(record);
  if(fields.some(key=>!Object.hasOwn(record,key))||names.some(key=>!fields.includes(key)&&!optional.includes(key)))convertedInput();return record;
}
function convertedHash(value:unknown):void {if(typeof value!=='string'||!CONVERTED_HASH.test(value))convertedInput();}
function convertedId(value:unknown,pattern=CONVERTED_OBJECT):void {if(typeof value!=='string'||!pattern.test(value))convertedInput();}
function convertedInteger(value:unknown,low:number,high:number):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<low||value>high)convertedInput();return value;}
function convertedList(value:unknown,low:number,high:number):unknown[] {if(!Array.isArray(value)||value.length<low||value.length>high)convertedInput();return value;}
function convertedMatrix(value:unknown):void {
  const matrix=convertedList(value,16,16);if(matrix.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1000000)||matrix[3]!==0||matrix[7]!==0||matrix[11]!==0||matrix[15]!==1)convertedInput();
  // Full affine data is retained here. Native eligibility requires the complete
  // graph/association inspection before the controller's durable stage claim.
}
function convertedPivot(value:unknown):void {if(convertedList(value,3,3).some(n=>n!==0))convertedInput();}
function convertedBounds(value:unknown):void {const b=convertedClosed(value,['min','max']);for(const k of ['min','max'])if(convertedList(b[k],3,3).some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1000000))convertedInput();
  const min=b.min as number[],max=b.max as number[];if(min.some((n,i)=>n>max[i]!)||min.filter((n,i)=>n<max[i]!).length<2)convertedInput();}
function convertedAssociation(value:unknown):Record<string,unknown> {
  const a=convertedClosed(value,['sourceObjectId','nodeKey','sourcePivot','correspondenceSha256']);convertedId(a.sourceObjectId);convertedPivot(a.sourcePivot);
  if(a.nodeKey===null){if(a.correspondenceSha256!==null)convertedInput();}else{convertedId(a.nodeKey,CONVERTED_NODE);if(!/_primitive[0-9]+$/.test(a.nodeKey as string))convertedInput();convertedHash(a.correspondenceSha256);}return a;
}
function convertedStream(value:unknown):Record<string,unknown> {
  const s=convertedClosed(value,['streamId','semantic','componentType','type','count','normalized','byteLength','sha256','source','chunks']);convertedHash(s.streamId);convertedHash(s.sha256);
  if(!['POSITION','NORMAL','TEXCOORD_0','indices','ColorMap','NormalMap','RoughnessMap','MetalnessMap'].includes(s.semantic as string)||![5121,5123,5125,5126].includes(s.componentType as number)||!['SCALAR','VEC2','VEC3','VEC4'].includes(s.type as string)||typeof s.normalized!=='boolean')convertedInput();
  convertedInteger(s.count,1,1024*1024);convertedInteger(s.byteLength,1,32*1024*1024);
  const semantic=s.semantic as string,components=s.type==='SCALAR'?1:s.type==='VEC2'?2:s.type==='VEC3'?3:4,width=s.componentType===5121?1:s.componentType===5123?2:4;
  if(s.byteLength!==Number(s.count)*components*width||
    (semantic==='indices'?(s.type!=='SCALAR'||![5121,5123,5125].includes(s.componentType as number)||s.normalized!==false):
      semantic==='POSITION'||semantic==='NORMAL'?(s.type!=='VEC3'||s.componentType!==5126||s.normalized!==false):
      semantic==='TEXCOORD_0'?(s.type!=='VEC2'||![5121,5123,5126].includes(s.componentType as number)||(s.componentType===5126?s.normalized!==false:s.normalized!==true)):
      (s.type!=='VEC4'||s.componentType!==5121||s.normalized!==false)))convertedInput();
  if(s.source!==null){const source=convertedClosed(s.source,['accessorIndex','accessor','bufferView']);convertedInteger(source.accessorIndex,0,65535);object(source.accessor);object(source.bufferView);}
  let offset=0;for(const row of convertedList(s.chunks,1,4096)){const c=convertedClosed(row,['offset','byteLength','sha256']);convertedInteger(c.offset,0,32*1024*1024);convertedInteger(c.byteLength,1,180*1024);convertedHash(c.sha256);if(c.offset!==offset)convertedInput();offset+=Number(c.byteLength);}if(offset!==s.byteLength)convertedInput();return s;
}
function convertedPacket(packet:Record<string,unknown>,raw:string,target:Record<string,unknown>):void {
  // The packet string is opaque to the outer JSON gate. Bound its parsed tree
  // before JSON.stringify/canonical helpers can recurse through source metadata.
  const pending:{value:unknown;depth:number}[]=[{value:packet,depth:0}];let values=0;
  while(pending.length){const {value,depth}=pending.pop()!;if(++values>200000||depth>80)convertedInput();
    if(typeof value==='number'&&!Number.isFinite(value))convertedInput();
    if(value&&typeof value==='object')for(const child of Object.values(value))pending.push({value:child,depth:depth+1});
  }
  const kind=packet.kind;if(typeof kind!=='string'||!Object.hasOwn(CONVERTED_PACKET_BODIES,kind)||JSON.stringify(packet)!==raw)convertedInput();
  if(kind!=='begin'&&packet.ordinal===0)convertedInput();
  convertedClosed(packet,['formatVersion','payloadDigest','manifestDigest','ordinal','kind',...CONVERTED_PACKET_BODIES[kind as keyof typeof CONVERTED_PACKET_BODIES]],kind==='object'?['textureBindings']:[]);
  if(kind==='begin'){
    if(packet.ordinal!==0||packet.origin!=='converted-glb'||packet.identityScheme!=='arcane-converted-v2'||canonical(packet.target)!==canonical(target))convertedInput();
    for(const name of ['projectId','sourceSha256','preparedDigest','conversionRequestDigest'])convertedHash(packet[name]);convertedId(packet.assetId);
    const r=convertedClosed(packet.conversionRequest,['schemaVersion','fidelityPolicy','kind','jobId','parentJobId','parentManifestSha256','name','sourceSha256','sourceBytes','importSha256','importBytes','sourceMapSha256','collision','renderResolution','renderSamples']);
    const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;convertedId(r.jobId,uuid);convertedId(r.parentJobId,uuid);
    if(r.schemaVersion!==2||r.fidelityPolicy!=='arcane-static-fidelity-v1'||r.kind!=='converted-glb'||r.jobId===r.parentJobId||r.jobId!==packet.revisionId||r.sourceSha256!==packet.sourceSha256||!['none','convex-hull'].includes(r.collision as string))convertedInput();
    textField(r.name,'converted source name',48);for(const key of ['sourceSha256','parentManifestSha256','importSha256','sourceMapSha256'])convertedHash(r[key]);
    convertedInteger(r.sourceBytes,20,64*1024*1024);convertedInteger(r.importBytes,20,64*1024*1024);convertedInteger(r.renderResolution,128,1024);convertedInteger(r.renderSamples,1,64);
    const h=convertedClosed(packet.graph,['schemaVersion','sourceSceneIndex','nodeCount','meshCount','digest']);if(h.schemaVersion!==1)convertedInput();convertedHash(h.digest);
    convertedInteger(h.sourceSceneIndex,0,4095);convertedInteger(h.nodeCount,1,4096);convertedInteger(h.meshCount,1,128);
    if(packet.objectCount!==h.meshCount||typeof packet.texturesPresent!=='boolean')convertedInput();convertedInteger(packet.textureCount,0,256);
    if(packet.texturesPresent===false&&packet.textureCount!==0)convertedInput();convertedInteger(packet.binaryByteLength,1,32*1024*1024);convertedInteger(packet.aggregateEncodedByteLength,1,48*1024*1024);convertedInteger(packet.chunkCount,1,4096);
    const producer=convertedClosed(packet.producer,['blenderVersion','exporterVersion']);for(const [key,max]of [['blenderVersion',128],['exporterVersion',256]] as const)if(typeof producer[key]!=='string'||!(producer[key] as string).length||(producer[key] as string).length>max||!/^[\x20-\x7e]+(?![\s\S])/.test(producer[key] as string))convertedInput();
    const conversion=convertedClosed(packet.conversion,['sourceUnits','sourceUp','exportUnits','exportUp','targetUnits','targetUp','studsPerMeter']);
    if(conversion.sourceUnits!=='meters'||conversion.exportUnits!=='meters'||conversion.targetUnits!=='studs'||conversion.sourceUp!=='Y'||conversion.exportUp!=='Y'||conversion.targetUp!=='Y'||typeof conversion.studsPerMeter!=='number'||!Number.isFinite(conversion.studsPerMeter)||conversion.studsPerMeter<=0||conversion.studsPerMeter>1000)convertedInput();
    convertedList(packet.anchors,0,0);convertedBounds(packet.bounds);object(packet.placement);
    const files=convertedList(packet.files,r.collision==='convex-hull'?2:1,r.collision==='convex-hull'?2:1),ids=new Set<string>();
    for(const row of files){const file=convertedClosed(row,['fileId','contentType','sha256','byteLength']);if(!['asset-glb',...(r.collision==='convex-hull'?['collision-glb']:[])].includes(file.fileId as string)||ids.has(file.fileId as string)||file.contentType!=='model/gltf-binary')convertedInput();ids.add(file.fileId as string);convertedHash(file.sha256);convertedInteger(file.byteLength,20,20000000);}
    const documents=new Set<string>();for(const row of convertedList(packet.sourceDocuments,files.length,files.length)){const source=convertedClosed(row,['fileId','jsonSha256','document']);if(!ids.has(source.fileId as string)||documents.has(source.fileId as string))convertedInput();documents.add(source.fileId as string);convertedHash(source.jsonSha256);object(source.document);}
    const delta=convertedClosed(packet.delta,['previousDigest','nextDigest','receiptSha256','modelRef','modelAssetId','observation','placementChanged','objects','reviewRemovals','reviewAnchors','geometry','textures','preservation','graph','nodes','reviewNodeRemovals']);
    const graph=convertedClosed(delta.graph,['previousDigest','nextDigest','changed']);if(graph.nextDigest!==h.digest||delta.nextDigest!==packet.manifestDigest||typeof graph.changed!=='boolean'||delta.preservation!=='preserve-all-scripts-attachments-constraints')convertedInput();convertedList(delta.nodes,h.nodeCount as number,h.nodeCount as number);
    // Closed detached metadata only; the connected host still owns fresh custody.
    if(delta.modelAssetId!==null||typeof delta.placementChanged!=='boolean')convertedInput();
    if(delta.previousDigest===null){
      if(delta.observation!==null||delta.receiptSha256!==null||delta.modelRef!==null||graph.previousDigest!==null||graph.changed!==true||delta.placementChanged!==false)convertedInput();
      convertedList(delta.reviewRemovals,0,0);convertedList(delta.reviewNodeRemovals,0,0);
    }else{
      convertedHash(delta.previousDigest);convertedHash(graph.previousDigest);convertedHash(delta.receiptSha256);
      let witness:StudioImportObservationWitness;
      try{witness=parseStudioImportObservationWitness(delta.observation);}catch{convertedInput();}
      const observed=witness.observation,source=observed.source;
      if(source.projectId!==packet.projectId||source.assetId!==packet.assetId||source.sourceSha256!==packet.sourceSha256||
        canonical(observed.target)!==canonical(target)||source.manifestDigest!==delta.previousDigest||source.graphDigest!==graph.previousDigest||
        observed.modelRef.instanceId!==delta.modelRef||witness.receiptSha256!==delta.receiptSha256||
        createHash('sha256').update(observationCanonical(observed)).digest('hex')!==witness.receiptSha256)convertedInput();
    }
  }else if(kind==='node'){
    if(packet.ordinal===0)convertedInput();const node=convertedClosed(packet.node,['nodeKey','parentKey','localMatrix','name']);convertedId(node.nodeKey,CONVERTED_NODE);
    if(node.parentKey!==null){convertedId(node.parentKey,CONVERTED_NODE);if(node.parentKey===node.nodeKey)convertedInput();}convertedMatrix(node.localMatrix);
    if(node.name!==null&&(typeof node.name!=='string'||node.name.length>256))convertedInput();
  }else if(kind==='object'){
    const a=convertedAssociation(packet.association),o=convertedClosed(packet.object,['sourceObjectId','sourceKey','name','role','exportFileId','nodeIndex','meshExportSha256','triangles','materialSha256','textureSha256s','exportTransform','scale','pivot','bounds','worldBounds','collisionFor']);
    convertedId(o.sourceObjectId);convertedHash(o.meshExportSha256);convertedPivot(o.pivot);convertedMatrix(o.exportTransform);convertedBounds(o.bounds);convertedBounds(o.worldBounds);convertedInteger(o.nodeIndex,0,4095);convertedInteger(o.triangles,1,20000);textField(o.name,'converted object name',256);
    if(o.sourceObjectId!==a.sourceObjectId||(o.role==='render'?(o.sourceKey!==a.nodeKey||o.exportFileId!=='asset-glb'):o.role!=='collision'||o.sourceKey!=='proxy'||a.nodeKey!==null||o.exportFileId!=='collision-glb'))convertedInput();
    if(o.role==='render'){convertedId(o.sourceKey,CONVERTED_NODE);if(a.nodeKey===null)convertedInput();}else if(o.materialSha256!==null)convertedInput();
    if(o.materialSha256!==null)convertedHash(o.materialSha256);convertedList(o.scale,3,3).forEach(n=>{if(typeof n!=='number'||!Number.isFinite(n)||n<=0||n>1000000)convertedInput();});
    convertedList(o.textureSha256s,0,4).forEach(convertedHash);convertedList(o.collisionFor,o.role==='render'?0:1,o.role==='render'?0:128).forEach(id=>convertedId(id));
    convertedClosed(packet.provenance,['generator','node','mesh','material']);
    if(packet.material!==null){const material=convertedClosed(packet.material,['sha256','baseColor','metallic','roughness','alphaMode','alphaCutoff','doubleSided','normalScale','colorMap','normalMap','roughnessMap','metalnessMap'],['emission']);
      if(material.sha256!==o.materialSha256)convertedInput();convertedHash(material.sha256);
      for(const name of ['colorMap','normalMap','roughnessMap','metalnessMap'])if(material[name]!==null){const map=convertedClosed(material[name],['sha256','channel','texCoord']);convertedHash(map.sha256);if(map.texCoord!==0||!['rgba','rgb','g','b'].includes(map.channel as string))convertedInput();}
      if(material.emission!==undefined)convertedClosed(material.emission,['factor','strength','map']);
    }else if(o.materialSha256!==null)convertedInput();
    if(packet.textureBindings!==undefined){const bindings=object(packet.textureBindings);keys(bindings,['ColorMap','NormalMap','RoughnessMap','MetalnessMap']);Object.values(bindings).forEach(convertedHash);}
    for(const row of convertedList(packet.primitives,1,1)){const p=convertedClosed(row,['mode','vertexCount','triangleCount','source','correspondence','attributes','indices']);
      if(p.mode!==4)convertedInput();convertedInteger(p.vertexCount,1,60000);convertedInteger(p.triangleCount,1,20000);object(p.source);
      const attrs=convertedClosed(p.attributes,['POSITION'],['NORMAL','TEXCOORD_0']);for(const [name,stream]of Object.entries(attrs)){const descriptor=convertedStream(stream);if(descriptor.semantic!==name||descriptor.count!==p.vertexCount)convertedInput();}
      const indices=convertedStream(p.indices);if(indices.semantic!=='indices'||indices.count!==Number(p.triangleCount)*3)convertedInput();
      if(o.role==='collision'){if(p.correspondence!==null)convertedInput();}else{const proof=convertedClosed(p.correspondence,['semantic','accessorIndex','count','sha256','orientedTriangleSha256','ids','accessor','bufferView']);
        if(proof.semantic!=='_ARCANE_SOURCE_VERTEX_ID'||proof.count!==p.vertexCount||proof.orientedTriangleSha256!==a.correspondenceSha256)convertedInput();convertedInteger(proof.accessorIndex,0,65535);convertedHash(proof.sha256);convertedHash(proof.orientedTriangleSha256);convertedList(proof.ids,p.vertexCount as number,p.vertexCount as number).forEach(id=>convertedInteger(id,0,59999));object(proof.accessor);object(proof.bufferView);}
    }
  }else if(kind==='texture'){
    const t=convertedClosed(packet.texture,['semantic','componentType','type','count','normalized','byteLength','sha256','imageId','materialSha256','sourceSha256','sourceRgbaSha256','channel','factors','width','height','colorSpace','orientation','normalConvention','stream']);
    for(const key of ['imageId','materialSha256','sourceSha256','sourceRgbaSha256','sha256'])convertedHash(t[key]);const stream=convertedStream(t.stream);
    if(stream.semantic!==t.semantic||stream.sha256!==t.sha256||stream.count!==t.count||stream.byteLength!==t.byteLength||t.componentType!==5121||t.type!=='VEC4'||t.normalized!==false||!['ColorMap','NormalMap','RoughnessMap','MetalnessMap'].includes(t.semantic as string))convertedInput();convertedInteger(t.width,1,1024);convertedInteger(t.height,1,1024);if(t.count!==Number(t.width)*Number(t.height))convertedInput();
  }else if(kind==='chunk'){
    for(const key of ['streamId','bufferSha256','sha256'])convertedHash(packet[key]);convertedInteger(packet.primitiveIndex,-1,0);convertedInteger(packet.offset,0,32*1024*1024);convertedInteger(packet.byteLength,1,180*1024);
    if(packet.encoding!=='base64'||typeof packet.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.data)||packet.data.length!==Math.ceil(Number(packet.byteLength)/3)*4)convertedInput();
    if(!['POSITION','NORMAL','TEXCOORD_0','indices','ColorMap','NormalMap','RoughnessMap','MetalnessMap'].includes(packet.semantic as string))convertedInput();
    if(packet.primitiveIndex===-1){convertedId(packet.sourceObjectId,/^texture-[a-f0-9]{64}(?![\s\S])/);if(!['ColorMap','NormalMap','RoughnessMap','MetalnessMap'].includes(packet.semantic as string))convertedInput();}
    else{convertedId(packet.sourceObjectId);if(!['POSITION','NORMAL','TEXCOORD_0','indices'].includes(packet.semantic as string))convertedInput();}
  }else{convertedInteger(packet.precedingPacketCount,1,511);convertedInteger(packet.precedingByteLength,1,STUDIO_ASSET_TRANSFER_LIMITS.rawBytes);convertedHash(packet.contentDigest);if(packet.ordinal!==packet.precedingPacketCount)convertedInput();}
}
function convertedReconstruction(a:Record<string,Json>):void {
  convertedHash(a.graphDigest);const count=convertedInteger(a.nodeCount,1,STUDIO_RECONSTRUCTION_LIMITS.objects),nodes=convertedList(a.nodes,count,count),seen=new Set<string>(),associated=new Set<string>();
  for(const row of nodes){const node=convertedClosed(row,['nodeKey','parentKey','sourceObjectId']);convertedId(node.nodeKey,CONVERTED_NODE);const key=node.nodeKey as string;
    if(node.parentKey!==null)convertedId(node.parentKey,CONVERTED_NODE);
    if(seen.has(key)||node.parentKey!==null&&!seen.has(node.parentKey as string))convertedInput();seen.add(key);
    if(node.sourceObjectId!==null){convertedId(node.sourceObjectId);if(!/_primitive[0-9]+$/.test(key)||node.parentKey!==key.split('_primitive')[0]||associated.has(node.sourceObjectId as string))convertedInput();associated.add(node.sourceObjectId as string);}
    else if(/_primitive[0-9]+$/.test(key))convertedInput();
  }
  const ids=(a.objects as Json[]).map(row=>object(row).sourceObjectId),render=[...associated];
  if(render.length===0||render.some(id=>!ids.includes(id))||ids.length-render.length>1||count+ids.length-render.length>STUDIO_RECONSTRUCTION_LIMITS.objects)convertedInput();
}

export function validateCommandArgs(method: StudioMethod, value: unknown, session: StudioSession, internalRestore = false): Record<string, Json> {
  if(method==='scene.observe_import')return validateStudioImportObservationArgs(value,session);
  if(method==='asset.apply_revision')return validateStudioImportRevisionArgs(value,session);
  if (method === 'scene.import_context' || method === 'scene.upload_context') {
    const input = object(value), prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(input).length !== 0) throw new ArcaneError('INPUT', 'Import context arguments must be an empty JSON object.');
  }
  const a = jsonObject(value);
  if (isWrite(method) && !session.allowWrites) throw new ArcaneError('READ_ONLY', 'This Studio pairing is read-only. Create an explicit writable pairing to edit.');
  if (!session.capabilities.includes(method)) {
    if (isAssetMethod(method)) throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `The connected Arcane Studio plugin (${session.pluginVersion}) predates native asset placement. Update the Studio plugin from Arcane, restart Studio and connect again. No command was queued.`);
    if (method === 'asset.keep_mesh') throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `Keep this mesh is unavailable in this Studio connection: the connected Arcane Studio plugin (${session.pluginVersion}) predates it, or this Roblox Studio does not let plugins upload meshes (its capability probe failed closed). Update Roblox Studio and the Arcane plugin, restart Studio and connect again. Nothing was uploaded.`);
    if (method === 'scene.remove') throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', 'Scene deletion needs the updated Arcane Studio plugin. Install the plugin update from Arcane and reload it in Studio; no removal was queued.');
    if (method === 'terrain.generate') throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `The connected Arcane Studio plugin (${session.pluginVersion}) predates procedural terrain. Update the Studio plugin from Arcane, restart Studio and connect again; until then use environment_apply terrain fills. No command was queued.`);
    if (method === 'scene.build' || method === 'environment.apply') throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `The connected Arcane Studio plugin (${session.pluginVersion}) predates batch building and environment tools. Update the Studio plugin from Arcane, restart Studio and connect again; until then use scene_create. No command was queued.`);
    throw new ArcaneError('CAPABILITY', 'This exact plugin session does not support this method.');
  }
  switch (method) {
    case 'asset.stage_packet': case 'asset.reconstruct': {
      const convertedReconstruct=method==='asset.reconstruct'&&a.formatVersion===2;
      keys(a, method === 'asset.stage_packet' ? ['expected', 'packet', 'target', 'continuity'] :
        ['runId','expected','packetCount','byteLength','objects','target','continuity',...(convertedReconstruct?['formatVersion','graphDigest','nodeCount','nodes']:[])]);
      const expected = object(a.expected), target = object(a.target), continuity = object(a.continuity);
      keys(expected, ['digest', 'payloadDigest', 'manifestDigest']);
      for (const key of ['digest', 'payloadDigest', 'manifestDigest']) if (typeof expected[key] !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(expected[key])) throw new ArcaneError('INPUT', 'Expected complete asset staging digests.');
      if(method==='asset.stage_packet') {
      textField(a.packet, 'asset packet', 256 * 1024);
      let packet: Record<string, unknown>;
      try {packet = object(JSON.parse(a.packet as string));} catch {throw new ArcaneError('INPUT', 'Expected a bounded JSON asset packet.');}
      if ((packet.formatVersion !== 1&&packet.formatVersion!==2) || packet.payloadDigest !== expected.payloadDigest || packet.manifestDigest !== expected.manifestDigest
        || !Number.isInteger(packet.ordinal) || (packet.ordinal as number) < 0 || (packet.ordinal as number) >= 512
        || !(packet.formatVersion===2?['begin','node','texture','object','chunk','seal']:['begin', 'texture', 'object', 'chunk', 'seal']).includes(packet.kind as string)) throw new ArcaneError('INPUT', 'Asset packet does not match its fixed staging envelope.');
      // This is a per-command structural/scope gate. The trusted controller and
      // durable reader must inspect the ORIGINAL complete v2 batch before claim:
      // parent-first phase/coverage, raw hash chain, graph/payload digests and
      // native representability cannot be proved by one queued packet.
      if(packet.formatVersion===2)convertedPacket(packet,a.packet as string,target);
      } else {
        if(typeof a.runId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(a.runId)||!Number.isSafeInteger(a.packetCount)||Number(a.packetCount)<1||Number(a.packetCount)>512
          ||!Number.isSafeInteger(a.byteLength)||Number(a.byteLength)<Number(a.packetCount)||Number(a.byteLength)>STUDIO_ASSET_TRANSFER_LIMITS.rawBytes
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
        if(convertedReconstruct){for(const row of a.objects as Json[])convertedId(object(row).sourceObjectId);convertedReconstruction(a);}
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
      keys(a, ['root', 'query', 'className', 'limit']); root(a.root, session);
      if (a.query !== undefined || a.className === undefined) textField(a.query, 'search query', 100);
      if (a.className !== undefined) {
        if (typeof a.className !== 'string' || !SEARCH_CLASS_NAME.test(a.className)) throw new ArcaneError('INPUT', 'className must be one Roblox class name.');
        requireEffects(session, 'class search', STUDIO_SEARCH_CLASS_CAPABILITY);
      }
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 200)) throw new ArcaneError('INPUT', 'Limit must be 1..200.'); break;
    case 'output.read': {
      keys(a, ['levels', 'query', 'after', 'limit']);
      if (a.levels !== undefined && (!Array.isArray(a.levels) || a.levels.length < 1 || a.levels.length > OUTPUT_LEVELS.length
        || new Set(a.levels).size !== a.levels.length || a.levels.some(level => !(OUTPUT_LEVELS as readonly unknown[]).includes(level)))) throw new ArcaneError('INPUT', 'levels must be distinct output/info/warning/error values.');
      if (a.query !== undefined && (typeof a.query !== 'string' || !a.query.length || Buffer.byteLength(a.query, 'utf8') > OUTPUT_READ_LIMITS.queryBytes || /[\x00-\x1f\x7f]/.test(a.query)
        || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(a.query))) throw new ArcaneError('INPUT', `Use a literal single-line query of at most ${OUTPUT_READ_LIMITS.queryBytes} UTF-8 bytes.`);
      if (a.after !== undefined && (!Number.isSafeInteger(a.after) || (a.after as number) < 0 || (a.after as number) > OUTPUT_READ_LIMITS.cursor)) throw new ArcaneError('INPUT', 'after must be a nonnegative output cursor.');
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > OUTPUT_READ_LIMITS.entries)) throw new ArcaneError('INPUT', `Limit must be 1..${OUTPUT_READ_LIMITS.entries}.`);
      break;
    }
    case 'script.search': {
      keys(a, ['root', 'ref', 'query', 'limit', 'caseSensitive']); root(a.root, session);
      if (a.ref !== undefined) { const r = ref(a.ref, session); if (r.root !== a.root) throw new ArcaneError('SCOPE', 'Root/ref mismatch.'); }
      if (typeof a.query !== 'string' || !a.query.length || Buffer.byteLength(a.query, 'utf8') > 256 || /[\x00-\x1f\x7f]/.test(a.query) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(a.query)) throw new ArcaneError('INPUT', 'Use a literal single-line query of at most 256 UTF-8 bytes.');
      if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 100)) throw new ArcaneError('INPUT', 'Limit must be 1..100.');
      if (a.caseSensitive !== undefined && typeof a.caseSensitive !== 'boolean') throw new ArcaneError('INPUT', 'caseSensitive must be a boolean.');
      break;
    }
    case 'selection.read': keys(a, []); break;
    case 'scene.inspect':
      keys(a, ['ref', 'bounds']); ref(a.ref, session);
      if (a.bounds !== undefined) { if (a.bounds !== true) throw new ArcaneError('INPUT', 'bounds must be true when present.'); requireEffects(session, 'framed viewport bounds'); }
      break;
    case 'script.read': keys(a, ['ref']); ref(a.ref, session); break;
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
      keys(a, ['parent', 'className', 'name', 'properties']); const parent = ref(a.parent, session); textField(a.name, 'instance name', 100);
      if (isEffectClass(a.className)) {
        requireEffects(session, 'effects classes');
        requireCharacters(session, a.className);
        const host = hostKind(parent.className, parent.pathSegments.length === 0);
        if (!host || !EFFECT_HOSTS[a.className].includes(host)) throw new ArcaneError('CLASS', `${a.className} must be created inside a ${EFFECT_HOSTS[a.className].join(' or ')}.`);
        a.properties = validateEffectProperties(a.properties, a.className, (t, kind) => {
          keys(t, ['type', 'ref']); const r = ref(t.ref, session), wanted = EFFECT_REF_CLASSES[kind];
          if (r.className !== wanted) throw new ArcaneError('PROPERTY', `${wanted} refs must name ${wanted === 'Attachment' ? 'an' : 'a'} ${wanted} in this session.`);
        });
        break;
      }
      if (isGuiClass(a.className)) {
        requireGui(session);
        requireGuiFlex(session, a.className, a.properties);
        const host = hostKind(parent.className, parent.pathSegments.length === 0);
        if (!host || !(GUI_HOSTS[a.className] as readonly string[]).includes(host)) throw hostError(a.className);
        a.properties = validateGuiProperties(a.properties, a.className);
        break;
      }
      if (!SAFE_CREATE_CLASSES.includes(a.className as typeof SAFE_CREATE_CLASSES[number])) throw new ArcaneError('CLASS', 'Unsupported creation class.');
      a.properties = engineProperties(validateProperties(a.properties ?? {}, a.className as string, false)); break;
    }
    case 'scene.remove': {
      keys(a,['mode','refs']);
      if(a.mode==='workspace'){if(a.refs!==undefined)throw new ArcaneError('INPUT','Workspace reset does not take refs.');if(!session.allowedRoots.includes('Workspace'))throw new ArcaneError('SCOPE','Workspace is not granted.');}
      else if(a.mode==='refs'){
        if(!Array.isArray(a.refs)||a.refs.length<1||a.refs.length>64)throw new ArcaneError('INPUT','Choose 1..64 removal refs.');
        const seen=new Set<string>();for(const value of a.refs){const r=ref(value,session);if(!r.pathSegments.length||r.className==='Terrain')throw new ArcaneError('SCOPE','Engine roots and Terrain cannot be removed by ref.');if(seen.has(r.instanceId))throw new ArcaneError('INPUT','Removal refs must be distinct.');seen.add(r.instanceId);}
      }else throw new ArcaneError('INPUT','Choose refs or workspace removal.');
      break;
    }
    case 'scene.build': return validateSceneBuild(a, session);
    case 'scene.asset_watch': case 'scene.place_asset': case 'scene.apply_material': return validateAssetCommand(method, a, session);
    case 'environment.apply': return validateEnvironment(a, session);
    case 'terrain.generate': return validateTerrainGenerate(a, session);
    case 'asset.keep_mesh': return validateMeshKeep(a, session);
    case 'scene.update': {
      keys(a, ['ref', 'expected', 'properties']); const r = ref(a.ref, session);
      if (isGuiClass(r.className) && Object.keys(jsonObject(a.properties)).some(name => name !== 'Name')) {
        requireGui(session); requireEffects(session, 'GUI property editing', STUDIO_GUI_EDIT_CAPABILITY);
        requireGuiFlex(session, r.className, a.properties);
        const p = validateGuiEditProperties(a.properties, r.className), e = validateGuiBaseline(a.expected, r.className);
        if (!Object.keys(p).length || canonical(guiEditBaselineNames(r.className, p)) !== canonical(Object.keys(e).sort())) throw new ArcaneError('BASELINE', 'GUI baselines must cover the changed keys and their linked font or constraint values.');
        a.properties = p; a.expected = e; break;
      }
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

const OBS_HASH=/^[a-f0-9]{64}$/;
const OBS_UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OBS_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OBS_NODE=/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?$/;
const OBS_OBJECT=/^arcane_[a-f0-9]{64}$/;
function observationFailure():never {throw new ArcaneError('STUDIO_IMPORT_OBSERVATION','Converted observation or revision metadata is incomplete, changed or outside its exact scope.');}
function freezeObservation<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freezeObservation(child);Object.freeze(value);}return value;}
function observationCanonical(value:unknown):string {return Array.isArray(value)?'['+value.map(observationCanonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+observationCanonical(Object.getOwnPropertyDescriptor(value,key)!.value)).join(',')+'}':JSON.stringify(value);}
/** No getter, proxy trap, iterator or serializer is consulted before snapshot. */
function observationSnapshot(value:unknown):Json {
  let count=0,bytes=0;const seen=new Set<object>();
  const walk=(v:unknown,depth:number):Json=>{
    if(++count>STUDIO_IMPORT_OBSERVATION_LIMITS.values||depth>STUDIO_IMPORT_OBSERVATION_LIMITS.depth)observationFailure();
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isFinite(v))observationFailure();return Object.is(v,-0)?0:v;}
    if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(v.length>4096||bytes>STUDIO_IMPORT_OBSERVATION_LIMITS.argumentBytes)observationFailure();return v;}
    if(!v||typeof v!=='object'||observationTypes.isProxy(v)||seen.has(v))observationFailure();seen.add(v);
    try{
      const array=Array.isArray(v),prototype=Object.getPrototypeOf(v),own=Reflect.ownKeys(v);
      if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)observationFailure();
      if(array){const descriptor=Object.getOwnPropertyDescriptor(v,'length'),length:unknown=descriptor?.value;
        if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>128||own.length!==length+1)observationFailure();
        const out:Json[]=[];for(let at=0;at<length;at++){const d=Object.getOwnPropertyDescriptor(v,String(at));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))observationFailure();const child:unknown=d.value;out.push(walk(child,depth+1));}return out;
      }
      if(own.length>32)observationFailure();const out:Record<string,Json>=Object.create(null);
      for(const key of own){if(typeof key!=='string')observationFailure();const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))observationFailure();const child:unknown=d.value;out[key]=walk(child,depth+1);}return out;
    }finally{seen.delete(v);}
  };
  const result=walk(value,0);if(Buffer.byteLength(JSON.stringify(result))>STUDIO_IMPORT_OBSERVATION_LIMITS.argumentBytes)observationFailure();return result;
}
function observationFields(value:Json|undefined,fields:readonly string[]):Record<string,Json>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key)))observationFailure();return value;
}
function observationString(value:Json|undefined,pattern:RegExp):string {if(typeof value!=='string'||/[\r\n\u2028\u2029]/.test(value)||!pattern.test(value))observationFailure();return value;}
function observationList(value:Json|undefined,min:number,max:number):Json[]{if(!Array.isArray(value)||value.length<min||value.length>max)observationFailure();return value;}
function observationInteger(value:Json|undefined,min:number,max:number):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)observationFailure();return value;}
function observationSource(value:Json|undefined):StudioImportObservationSource {
  const a=observationFields(value,['projectId','jobId','assetId','sourceSha256','preparedDigest','manifestDigest','payloadDigest','transferDigest','graphDigest','conversionRequestDigest']);
  return {projectId:observationString(a.projectId,OBS_HASH),jobId:observationString(a.jobId,OBS_UUID),assetId:observationString(a.assetId,OBS_OBJECT),sourceSha256:observationString(a.sourceSha256,OBS_HASH),preparedDigest:observationString(a.preparedDigest,OBS_HASH),manifestDigest:observationString(a.manifestDigest,OBS_HASH),payloadDigest:observationString(a.payloadDigest,OBS_HASH),transferDigest:observationString(a.transferDigest,OBS_HASH),graphDigest:observationString(a.graphDigest,OBS_HASH),conversionRequestDigest:observationString(a.conversionRequestDigest,OBS_HASH)};
}
function observationTarget(value:Json|undefined):StudioAssetStageArgs['target'] {
  const a=observationFields(value,['sessionId','placeId','universeId','root','parentRef','creator']),creator=observationFields(a.creator,['kind','id']);
  if(a.root!=='Workspace'||creator.kind!=='user'&&creator.kind!=='group')observationFailure();
  return {sessionId:observationString(a.sessionId,OBS_ID),placeId:observationInteger(a.placeId,0,Number.MAX_SAFE_INTEGER),universeId:observationInteger(a.universeId,0,Number.MAX_SAFE_INTEGER),root:'Workspace',parentRef:observationString(a.parentRef,OBS_ID),creator:{kind:creator.kind,id:observationString(creator.id,/^[1-9][0-9]{0,19}$/)}};
}
function observationContinuity(value:Json|undefined):StudioAssetStageArgs['continuity'] {
  const a=observationFields(value,['clientLifetimeId','pluginArtifactHash','playEpoch']);return {clientLifetimeId:observationString(a.clientLifetimeId,/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),pluginArtifactHash:observationString(a.pluginArtifactHash,OBS_HASH),playEpoch:observationInteger(a.playEpoch,0,Number.MAX_SAFE_INTEGER)};
}
function observationModelRef(value:Json|undefined):InstanceRef {
  const a=observationFields(value,['instanceId','sessionId','root','pathSegments','className']);if(a.root!=='Workspace'||a.className!=='Model')observationFailure();
  const pathSegments=observationList(a.pathSegments,1,63).map(part=>{if(typeof part!=='string'||part.length>256||part.includes('\0'))observationFailure();return part;});
  return {instanceId:observationString(a.instanceId,OBS_ID),sessionId:observationString(a.sessionId,OBS_ID),root:'Workspace',pathSegments,className:'Model'};
}
function observationArgsBody(a:Record<string,Json>):StudioImportObservationArgs {
  if(a.formatVersion!==2)observationFailure();const target=observationTarget(a.target),modelRef=observationModelRef(a.modelRef);if(modelRef.sessionId!==target.sessionId||modelRef.instanceId===target.parentRef)observationFailure();
  return {formatVersion:2,observationId:observationString(a.observationId,OBS_UUID),source:observationSource(a.source),target,continuity:observationContinuity(a.continuity),modelRef};
}
export function parseStudioImportObservationArgs(value:unknown):StudioImportObservationArgs {return freezeObservation(observationArgsBody(observationFields(observationSnapshot(value),['formatVersion','observationId','source','target','continuity','modelRef'])));}
function observationChildren(value:Json|undefined):StudioImportObservedChild[]{
  const seen=new Set<string>();return observationList(value,0,STUDIO_IMPORT_OBSERVATION_LIMITS.preservedChildren).map(raw=>{const a=observationFields(raw,['instanceRef','kind','stateSha256']);if(a.kind!=='script'&&a.kind!=='attachment'&&a.kind!=='constraint')observationFailure();const instanceRef=observationString(a.instanceRef,OBS_ID);if(seen.has(instanceRef))observationFailure();seen.add(instanceRef);return {instanceRef,kind:a.kind,stateSha256:observationString(a.stateSha256,OBS_HASH)};});
}
function observationState(a:Record<string,Json>):Pick<StudioImportObservationReceipt,'modelOwnedStateSha256'|'nodes'|'objects'> {
  const nodeKeys=new Set<string>(),nodeRefs=new Set<string>(),objectIds=new Set<string>(),objectRefs=new Set<string>();
  const nodes:StudioImportObservedNode[]=observationList(a.nodes,1,STUDIO_IMPORT_OBSERVATION_LIMITS.nodes).map(raw=>{const n=observationFields(raw,['nodeKey','instanceRef','ownedStateSha256','authoredChildren']),nodeKey=observationString(n.nodeKey,OBS_NODE),instanceRef=observationString(n.instanceRef,OBS_ID);if(nodeKeys.has(nodeKey)||nodeRefs.has(instanceRef))observationFailure();nodeKeys.add(nodeKey);nodeRefs.add(instanceRef);return {nodeKey,instanceRef,ownedStateSha256:observationString(n.ownedStateSha256,OBS_HASH),authoredChildren:observationChildren(n.authoredChildren)};});
  const objects:StudioImportObservedObject[]=observationList(a.objects,1,STUDIO_IMPORT_OBSERVATION_LIMITS.objects).map(raw=>{const o=observationFields(raw,['sourceObjectId','instanceRef','ownedStateSha256','authoredChildren','meshAssetId']),sourceObjectId=observationString(o.sourceObjectId,OBS_OBJECT),instanceRef=observationString(o.instanceRef,OBS_ID);if(objectIds.has(sourceObjectId)||objectRefs.has(instanceRef))observationFailure();objectIds.add(sourceObjectId);objectRefs.add(instanceRef);return {sourceObjectId,instanceRef,ownedStateSha256:observationString(o.ownedStateSha256,OBS_HASH),authoredChildren:observationChildren(o.authoredChildren),meshAssetId:o.meshAssetId===null?null:observationString(o.meshAssetId,/^[1-9][0-9]{0,19}$/)};});
  const refs=new Set([...nodeRefs,...objectRefs]);if(refs.size+1>STUDIO_RECONSTRUCTION_LIMITS.objects)observationFailure();
  const model=observationModelRef(a.modelRef);if(refs.has(model.instanceId))observationFailure();refs.add(model.instanceId);const children=new Set<string>();
  for(const owner of [...nodes,...objects]){
    const node='sourceObjectId'in owner?nodes.find(n=>n.instanceRef===owner.instanceRef):undefined;
    if(node&&(node.ownedStateSha256!==owner.ownedStateSha256||observationCanonical(node.authoredChildren)!==observationCanonical(owner.authoredChildren)))observationFailure();
    if(node)continue;
    for(const child of owner.authoredChildren){if(refs.has(child.instanceRef)||children.has(child.instanceRef))observationFailure();children.add(child.instanceRef);}
  }
  return {modelOwnedStateSha256:observationString(a.modelOwnedStateSha256,OBS_HASH),nodes,objects};
}
const OBS_RECEIPT_FIELDS=['formatVersion','observationId','source','target','continuity','modelRef','modelOwnedStateSha256','nodes','objects','receiptScope','imported','engineVerification'] as const;
export function parseStudioImportObservationReceipt(value:unknown):StudioImportObservationReceipt {
  const a=observationFields(observationSnapshot(value),OBS_RECEIPT_FIELDS);if(a.receiptScope!=='live-import-observation'||a.imported!==false||a.engineVerification!=='pending')observationFailure();return freezeObservation({...observationArgsBody(a),...observationState(a),receiptScope:'live-import-observation',imported:false,engineVerification:'pending'});
}
export function parseStudioImportObservationWitness(value:unknown):StudioImportObservationWitness {
  const a=observationFields(observationSnapshot(value),['commandId','receiptSha256','observation']);return freezeObservation({commandId:observationString(a.commandId,OBS_UUID),receiptSha256:observationString(a.receiptSha256,OBS_HASH),observation:parseStudioImportObservationReceipt(a.observation)});
}
function observationSession(a:Pick<StudioImportObservationArgs,'target'|'continuity'>,session:StudioSession,method:string):void {
  const proof=session.proof;if(!session.capabilities.includes(method)||!session.allowedRoots.includes('Workspace')||session.revokedAt!==null||a.target.sessionId!==session.id||a.target.placeId!==session.placeId||a.target.universeId!==session.universeId||!proof||proof.sessionId!==session.id||proof.placeId!==session.placeId||proof.universeId!==session.universeId||proof.clientLifetimeId!==session.clientSessionId||!proof.connected||!proof.continuitySupported||proof.mode!=='Edit'||proof.clientLifetimeId!==a.continuity.clientLifetimeId||proof.pluginArtifactHash!==a.continuity.pluginArtifactHash||proof.playEpoch!==a.continuity.playEpoch)observationFailure();
}
export function validateStudioImportObservationArgs(value:unknown,session:StudioSession):Record<string,Json>{const a=parseStudioImportObservationArgs(value);observationSession(a,session,'scene.observe_import');return jsonObject(a);}
export function validateStudioImportObservationReceipt(args:unknown,value:unknown):StudioImportObservationReceipt {
  const a=parseStudioImportObservationArgs(args),r=parseStudioImportObservationReceipt(value);for(const key of ['formatVersion','observationId','source','target','continuity','modelRef'] as const)if(observationCanonical(a[key])!==observationCanonical(r[key]))observationFailure();return r;
}
export function parseStudioImportRevisionArgs(value:unknown):StudioImportRevisionArgs {
  const a=observationFields(observationSnapshot(value),['formatVersion','runId','expected','packetCount','byteLength','source','target','continuity','observation','currentObservation']);if(a.formatVersion!==2)observationFailure();
  const source=observationSource(a.source),target=observationTarget(a.target),continuity=observationContinuity(a.continuity),expected=observationFields(a.expected,['digest','payloadDigest','manifestDigest']);
  const observation=parseStudioImportObservationWitness(a.observation),currentObservation=parseStudioImportObservationWitness(a.currentObservation),old=observation.observation,current=currentObservation.observation;
  if(observation.commandId===currentObservation.commandId||old.observationId===current.observationId)observationFailure();
  const {observationId:_oldId,...oldState}=old,{observationId:_currentId,...currentState}=current;
  if(observationCanonical(oldState)!==observationCanonical(currentState)||observationCanonical(target)!==observationCanonical(old.target)||observationCanonical(continuity)!==observationCanonical(old.continuity)||source.projectId!==old.source.projectId||source.assetId!==old.source.assetId||source.sourceSha256!==old.source.sourceSha256)observationFailure();
  const triple={digest:observationString(expected.digest,OBS_HASH),payloadDigest:observationString(expected.payloadDigest,OBS_HASH),manifestDigest:observationString(expected.manifestDigest,OBS_HASH)};if(triple.digest!==source.transferDigest||triple.payloadDigest!==source.payloadDigest||triple.manifestDigest!==source.manifestDigest)observationFailure();
  return freezeObservation({formatVersion:2,runId:observationString(a.runId,OBS_UUID),expected:triple,packetCount:observationInteger(a.packetCount,1,STUDIO_ASSET_TRANSFER_LIMITS.packets),byteLength:observationInteger(a.byteLength,1,STUDIO_ASSET_TRANSFER_LIMITS.rawBytes),source,target,continuity,observation,currentObservation});
}
export function validateStudioImportRevisionArgs(value:unknown,session:StudioSession):Record<string,Json>{const a=parseStudioImportRevisionArgs(value);observationSession(a,session,'asset.apply_revision');if(!session.allowWrites)observationFailure();return jsonObject(a);}
/** Detached historical metadata only; this does not validate a current actor or graph. */
export function parseStudioImportRevisionReceipt(value:unknown):StudioImportRevisionReceipt {
  const a=observationFields(observationSnapshot(value),[...OBS_RECEIPT_FIELDS,'runId','state']);if(a.receiptScope!=='live-import-revision'||a.state!=='applied'||a.imported!==false||a.engineVerification!=='pending')observationFailure();
  const r:StudioImportRevisionReceipt={...observationArgsBody(a),...observationState(a),receiptScope:'live-import-revision',state:'applied',runId:observationString(a.runId,OBS_UUID),imported:false,engineVerification:'pending'};
  return freezeObservation(r);
}
export function validateStudioImportRevisionReceipt(args:unknown,value:unknown):StudioImportRevisionReceipt {
  const expected=parseStudioImportRevisionArgs(args),r=parseStudioImportRevisionReceipt(value);
  if(r.runId!==expected.runId||r.observationId!==expected.currentObservation.observation.observationId||observationCanonical(r.source)!==observationCanonical(expected.source)||observationCanonical(r.target)!==observationCanonical(expected.target)||observationCanonical(r.continuity)!==observationCanonical(expected.continuity)||observationCanonical(r.modelRef)!==observationCanonical(expected.observation.observation.modelRef))observationFailure();return freezeObservation(r);
}
