import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { SCENE_BUILD_LIMITS, ENVIRONMENT_LIMITS, ASSET_PLACE_LIMITS } from '../../../packages/protocol/src/studio.js';
import { BUILD_GROUP_CLASSES, BUILD_PART_CLASSES, ENVIRONMENT_PROPERTIES, MATERIALS, SHAPES, TERRAIN_MATERIALS, TERRAIN_SHAPES, validateProperties,
  EFFECT_CLASSES, EFFECT_PROPERTIES, EFFECT_HOSTS, ENVIRONMENT_PRESET_NAMES, LIGHTING_TECHNOLOGIES, VARIANT_MAPS, isEffectClass, validateEffectProperties,
  EFFECT_HOST_CLASSES, EFFECT_REF_CLASSES, REVERB_TYPES, SOUND_SERVICE_PROPERTIES, type EffectClass, type EffectKind, type EffectRefKind, type EffectHost,
  GUI_CLASSES, GUI_PROPERTIES, GUI_HOSTS, GUI_HOST_CLASSES, isGuiClass, validateGuiProperties, type GuiClass } from '../../../packages/core/src/studio-policy.js';
import { EFFECT_LIMITS } from '../../../packages/protocol/src/studio.js';
import { BridgeError } from './daemon-client.js';
import { id, ref } from './schemas.js';
import { expandKits, KIT_TRIANGLE_BUDGET, PRIMITIVE_TRIANGLES, TEMPLATE_TRIANGLES, type FieldScatter, type KitReport } from './scene-kits.js';

/** Compact model-facing build input. It is compiled locally into the strict scene.build wire
 * form (explicit prototypes and placements), so a forest is one short call, not hundreds. */
const n = z.number().finite();
const v3 = z.tuple([n, n, n]);
const unit = z.number().min(0).max(1);
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Use #rrggbb.');
export const colorInput = z.union([z.tuple([unit, unit, unit]), hex, z.strictObject({ type: z.literal('Color3'), value: z.tuple([unit, unit, unit]) })])
  .describe('[r,g,b] 0..1, "#rrggbb" or tagged Color3.');
const vector = z.union([v3, z.strictObject({ type: z.literal('Vector3'), value: v3 })]);
const name = id.max(100);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const compactProps = z.strictObject({
  Size: vector.optional(), Position: vector.optional(), Orientation: vector.optional(), Color: colorInput.optional(),
  Material: z.enum(MATERIALS).optional(), Shape: z.enum(SHAPES).optional(), Anchored: z.boolean().optional(), CanCollide: z.boolean().optional(),
  CastShadow: z.boolean().optional(), Transparency: unit.optional(), Reflectance: unit.optional(),
});
const BUILD_CLASSES: readonly string[] = [...BUILD_GROUP_CLASSES, ...BUILD_PART_CLASSES, ...EFFECT_CLASSES, ...GUI_CLASSES];
// Checked against the same class list, advertised as a string: the effect/GUI classes are already enumerated on scene_create.
const buildClass = z.string().max(40).refine(value => BUILD_CLASSES.includes(value), `Use one of ${BUILD_CLASSES.join(', ')}.`);
/** Compact effect properties; compileEffectProps converts them to the tagged wire form. */
export const effectProps = z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.unknown())
  .describe('Effect props by class (see tool description). Colors [r,g,b]/"#hex"; NumberSequence as a number, evenly spaced numbers or [[t,v,env?],...]; ColorSequence as a color, evenly spaced colors or [[t,"#hex"],...]; NumberRange as n or [min,max]; Vector2/3 arrays; enums by name; Texture "rbxassetid://123" or "rbxasset://textures/..."; Attachment0/1 = key of an earlier Attachment item; Sound.SoundId "rbxassetid://<digits>" only (user-given or from studio_asset_search category Audio, never invented); Sound.SoundGroup = key of an earlier SoundGroup item.');
/** One-line per-class property list for tool descriptions. */
export function effectCatalog(): string {
  // Classes with the same key list share one entry (e.g. SpotLight/SurfaceLight).
  const groups = new Map<string, string[]>();
  for (const className of EFFECT_CLASSES) { const keys = Object.keys(EFFECT_PROPERTIES[className]).join(','); groups.set(keys, [...(groups.get(keys) ?? []), className]); }
  return [...groups].map(([keys, classes]) => `${classes.join('/')}(${keys})`).join('; ');
}
function spread<T>(values: T[]): [number, T][] { return values.map((value, index) => [Number((index / (values.length - 1)).toFixed(4)), value]); }
function rgb(value: unknown, label: string): number[] {
  const color = tagged('Color3', value) as { type?: string; value?: unknown };
  if (!color || color.type !== 'Color3' || !Array.isArray(color.value)) throw new BridgeError('INPUT', `${label}: use [r,g,b] 0..1 or "#rrggbb".`);
  return color.value as number[];
}
/** Compact GUI properties; compileGuiProps converts them to the tagged wire form. */
export const guiProps = z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.unknown())
  .describe(`GUI props (keys on scene_create): UDim2 [xScale,xOffset,yScale,yOffset], UDim [scale,offset] or px, colors [r,g,b]/#hex, enums by name, FontFace family or {family,weight,style}, Text one line <=2000 bytes, Image rbxassetid:// or rbxasset://textures/ only. Stamp: root overrides.`);
/** One-line per-class GUI property list for tool descriptions. */
export function guiCatalog(): string {
  // Shared GuiObject and text keys are listed once; each class then lists only its extra keys.
  const common = Object.keys(GUI_PROPERTIES.Frame), text = Object.keys(GUI_PROPERTIES.TextLabel).filter(key => !common.includes(key));
  const extra = (className: GuiClass) => Object.keys(GUI_PROPERTIES[className]).filter(key => GUI_HOST_CLASSES[className] !== 'guiObject' || (!common.includes(key) && !(className.startsWith('Text') && text.includes(key))));
  return [`GuiObject(${common.join(',')})`, `Text*(+${text.join(',')})`, ...GUI_CLASSES.filter(className => className !== 'Frame' && className !== 'TextLabel')
    .map(className => `${className}(${GUI_HOST_CLASSES[className] === 'guiObject' ? '+' : ''}${extra(className).join(',')})`)].join('; ');
}
/** Converts compact effect values to tagged wire values, then runs the shared policy validator. */
export function compileEffectProps(className: EffectClass, input: Record<string, unknown>, resolveRef: (value: unknown, label: string, kind: EffectRefKind) => Json): Record<string, Json> {
  const out = compileValues(className, EFFECT_PROPERTIES[className] as Record<string, EffectKind>, 'effect', input, resolveRef);
  try { return validateEffectProperties(out, className, () => undefined); }
  catch (error) { throw new BridgeError('INPUT', (error as Error).message); }
}
/** Converts compact GUI values to tagged wire values, then runs the shared policy validator. */
export function compileGuiProps(className: GuiClass, input: Record<string, unknown>): Record<string, Json> {
  const out = compileValues(className, GUI_PROPERTIES[className] as Record<string, EffectKind>, 'GUI', input, (_value, label) => { throw new BridgeError('INPUT', `${label} takes no references.`); });
  try { return validateGuiProperties(out, className); }
  catch (error) { throw new BridgeError('INPUT', (error as Error).message); }
}
function compileValues(className: string, table: Record<string, EffectKind>, what: string, input: Record<string, unknown>, resolveRef: (value: unknown, label: string, kind: EffectRefKind) => Json): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    const spec = table[k], label = `${className}.${k}`;
    if (!spec || !Object.hasOwn(table, k)) throw new BridgeError('INPUT', `${label} is not an allowed ${what} property. Allowed: ${Object.keys(table).join(', ')}.`);
    const isTagged = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'type' in raw;
    if (spec === 'attachment' || spec === 'soundGroup') { out[k] = resolveRef(raw, label, spec); continue; }
    if (isTagged || spec === 'boolean' || spec === 'content' || spec === 'audio' || spec === 'text' || (Array.isArray(spec) && (spec[0] === 'enum' || spec[0] === 'number' || spec[0] === 'integer'))) { out[k] = raw as Json; continue; }
    if (spec === 'udim2') { out[k] = { type: 'UDim2', value: raw as Json }; continue; }
    if (spec === 'udim') { out[k] = { type: 'UDim', value: (typeof raw === 'number' ? [0, raw] : raw) as Json }; continue; }
    if (spec === 'font') { out[k] = (typeof raw === 'string' ? { type: 'Font', family: raw } : { type: 'Font', ...(raw as Record<string, Json>) }) as Json; continue; }
    if (spec === 'color') { out[k] = { type: 'Color3', value: rgb(raw, label) }; continue; }
    if (spec === 'colorSequence') {
      const list = Array.isArray(raw) && raw.length >= 2 && (typeof raw[0] === 'string' || Array.isArray(raw[0])) ? raw : [raw, raw];
      const points = list.every(p => Array.isArray(p) && (p.length === 2 || p.length === 4))
        ? list.map(p => { const point = p as unknown[]; return [point[0] as number, ...(point.length === 2 ? rgb(point[1], label) : point.slice(1) as number[])]; })
        : spread(list).map(([t, c]) => [t, ...rgb(c, label)]);
      out[k] = { type: 'ColorSequence', value: points as Json }; continue;
    }
    const kind = spec[0];
    if (kind === 'vector3') { out[k] = { type: 'Vector3', value: raw as Json }; continue; }
    if (kind === 'vector2') { out[k] = { type: 'Vector2', value: raw as Json }; continue; }
    if (kind === 'range') { out[k] = { type: 'NumberRange', value: (typeof raw === 'number' ? [raw, raw] : raw) as Json }; continue; }
    const list = typeof raw === 'number' ? [raw, raw] : raw;
    out[k] = { type: 'NumberSequence', value: (Array.isArray(list) && list.every(p => typeof p === 'number') ? spread(list as number[]).map(([t, v]) => [t, v]) : list) as Json };
  }
  return out;
}
const range = z.tuple([n, n]);
const tint = z.tuple([z.number().min(0).max(2), z.number().min(0).max(2), z.number().min(0).max(2)]);
const seed = z.number().int().min(0).max(2 ** 31).default(1);
const clearingShape = z.strictObject({ center: z.tuple([n, n]).optional(), inner: z.number().min(0), outer: z.number().min(0) });
const avoidCircles = z.array(z.strictObject({ at: z.tuple([n, n]), radius: z.number().positive() })).max(32);
const avoidRoutes = z.array(z.strictObject({
  points: z.array(z.tuple([n.min(-1_000_000).max(1_000_000), n.min(-1_000_000).max(1_000_000)])).min(2).max(32),
  width: z.number().positive().max(512),
})).max(8);
const stone = z.enum(['Limestone', 'Marble', 'Granite', 'Sandstone', 'Slate', 'Basalt', 'Concrete', 'Cobblestone', 'Pavement']);
const layer = z.strictObject({ use: z.string().max(64), share: z.number().positive().max(100).optional(), spacing: z.number().min(0.5).max(512),
  tris: z.number().int().min(0).max(200000).optional() });

// Field meanings live in the arcane-natural-scenes:scene-build skill reference; the advertised schema keeps types and limits,
// plus the few hints whose names alone would mislead. Validation is unchanged.
export const sceneBuildShape = {
  name,
  container: z.enum([...BUILD_GROUP_CLASSES, 'ScreenGui']).default('Model'),
  screen: guiProps.optional().describe(''),
  defaults: compactProps.optional(),
  prototypes: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.strictObject({
    parts: z.array(z.strictObject({ name, className: z.enum(BUILD_PART_CLASSES).default('Part'), props: compactProps.optional(),
      tint: z.boolean().default(true) })).min(1).max(SCENE_BUILD_LIMITS.prototypeParts).optional(),
    weld: z.boolean().default(false),
    ui: z.array(z.strictObject({ name, className: z.string().max(40), in: name.optional(),
      ui: z.record(z.string(), z.unknown()).optional() })).min(1).max(SCENE_BUILD_LIMITS.prototypeParts).optional(),
  })).optional(),
  templates: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), ref).optional()
    .refine(value => !value || Object.keys(value).length <= ASSET_PLACE_LIMITS.templates, `At most ${ASSET_PLACE_LIMITS.templates} templates.`),
  items: z.array(z.strictObject({
    key: key.optional(), in: key.optional(),
    name: name.optional(), className: buildClass.optional(),
    props: compactProps.optional(), fx: effectProps.optional().describe(''), ui: guiProps.optional().describe(''),
    use: z.string().optional(),
    at: v3.optional(), yaw: z.number().min(-360).max(360).optional(), scale: z.number().min(0.1).max(20).optional(), tint: tint.optional(),
    ground: z.boolean().optional(),
  })).max(SCENE_BUILD_LIMITS.items).default([]),
  scatter: z.array(z.strictObject({
    use: z.union([z.string(), z.array(z.string()).min(1).max(16)]),
    in: key.optional(), name: name.optional(),
    count: z.number().int().min(1).max(SCENE_BUILD_LIMITS.items),
    center: v3,
    radius: z.number().positive().max(4096).optional(), innerRadius: z.number().min(0).max(4096).optional(),
    size: z.tuple([z.number().positive().max(8192), z.number().positive().max(8192)]).optional(),
    minSpacing: z.number().min(0.5).max(512),
    clusters: z.number().int().min(1).max(64).optional(),
    clusterSpread: z.number().positive().max(2048).optional(),
    clearing: clearingShape.optional(),
    avoid: avoidCircles.optional(),
    avoidPaths: avoidRoutes.optional(),
    footprintRadius: z.number().min(0).max(512).optional(),
    yaw: range.optional(), scale: range.optional(),
    tint: z.strictObject({ min: tint, max: tint }).optional(), seed,
    ground: z.boolean().default(false),
    edge: z.number().min(0).max(512).optional(), tilt: z.number().min(0).max(25).optional(),
    hug: unit.optional(),
  })).max(16).default([]),
  kits: z.array(z.strictObject({ kind: z.enum(['plinth', 'forest']), key: key.optional(), in: key.optional(), name: name.optional(),
    at: v3, radius: z.number().min(3).max(2048).optional(), seed,
    style: z.enum(['fluted', 'smooth', 'platform']).optional(), tiers: z.number().int().min(1).max(6).optional(), height: z.number().min(4).max(120).optional(),
    column: z.string().max(64).optional(), material: stone.optional(), color: colorInput.optional(),
    weathering: unit.optional(), spawn: z.boolean().optional(), life: z.enum(['day', 'dusk']).optional(),
    safeZone: z.strictObject({ radius: z.number().min(5).max(200), style: z.enum(['glow', 'stone']).optional() }).optional(),
    clearing: clearingShape.optional(), trees: z.number().int().min(0).max(1500).optional(), undergrowth: z.number().int().min(0).max(1500).optional(),
    species: z.array(layer).min(1).max(8).optional(), cover: z.array(layer).min(1).max(8).optional(),
    paths: avoidRoutes.optional(),
  })).max(4).optional(),
};
export type SceneBuildInput = z.output<z.ZodObject<typeof sceneBuildShape>>;

function tagged(kind: 'Vector3' | 'Color3', value: unknown): Json {
  if (typeof value === 'string') {
    const h = value.replace('#', '');
    return { type: 'Color3', value: [0, 2, 4].map(i => Number((parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4))) };
  }
  if (Array.isArray(value)) return { type: kind, value: value as number[] };
  return value as Json;
}
function props(input: Record<string, unknown> | undefined, defaults: Record<string, unknown> | undefined, className: string): Record<string, Json> {
  const merged: Record<string, unknown> = { Anchored: true, ...(defaults ?? {}), ...(input ?? {}) };
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) continue;
    if (k === 'Shape' && !['Part', 'SpawnLocation'].includes(className)) continue;
    out[k] = ['Size', 'Position', 'Orientation'].includes(k) ? tagged('Vector3', v) : k === 'Color' ? tagged('Color3', v) : v as Json;
  }
  const size = (out.Size as { value?: number[] } | undefined)?.value;
  if (out.Shape === 'Ball' && size && (size[0] !== size[1] || size[1] !== size[2])) throw new BridgeError('INPUT', 'A Ball needs equal Size channels.');
  try { return validateProperties(out, className, false); }
  catch (error) { throw new BridgeError('INPUT', `${className} props: ${(error as Error).message}`); }
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** Squared distance to a closed segment, including a repeated path point. */
function segmentDistanceSquared(x: number, z: number, a: readonly number[], b: readonly number[]): number {
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!, length = dx * dx + dz * dz;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]!) * dx + (z - a[1]!) * dz) / length));
  return (x - a[0]! - t * dx) ** 2 + (z - a[1]! - t * dz) ** 2;
}

/** Shared occupancy across scatter groups: natural spacing with no grid or ring structure. */
class Occupancy {
  readonly cell = 8; readonly points = new Map<string, { x: number; z: number; r: number; group: number }[]>(); maxR = 0;
  /** soft (hugging undergrowth): points of other scatter groups only reserve their trunk core, CORE x their radius. */
  ok(x: number, z: number, r: number, group = -1, soft = false): boolean {
    const reach = Math.ceil((r + this.maxR) / this.cell), cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let i = cx - reach; i <= cx + reach; i++) for (let j = cz - reach; j <= cz + reach; j++)
      for (const p of this.points.get(i + ',' + j) ?? []) if ((p.x - x) ** 2 + (p.z - z) ** 2 < ((soft && p.group !== group ? p.r * CORE : p.r) + r) ** 2) return false;
    return true;
  }
  add(x: number, z: number, r: number, group = -1): void {
    const k = Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell);
    (this.points.get(k) ?? this.points.set(k, []).get(k)!).push({ x, z, r, group }); this.maxR = Math.max(this.maxR, r);
  }
}
/** Share of a scatter point's spacing radius that hugging undergrowth still keeps clear (the trunk/rock core). */
export const CORE = 0.3;

export interface CompiledBuild { args: Record<string, Json>; scatter: { requested: number; placed: number }[]; instances: number; kits: KitReport[] }
export function compileSceneBuild(source: SceneBuildInput, parent: Json): CompiledBuild {
  const { input, plans } = expandKits(source);
  const protoNames = Object.keys(input.prototypes ?? {});
  const guiRoots = new Map<number, GuiClass>(); // prototype index -> root class of a GUI prototype
  const prototypes: Json[] = protoNames.map((protoName, protoIndexZero) => {
    const proto = input.prototypes![protoName]!;
    if (proto.ui) {
      if (proto.parts) throw new BridgeError('INPUT', `Prototype "${protoName}" needs parts or ui, not both.`);
      const names: string[] = [];
      const gui = proto.ui.map((element, index) => {
        if (!isGuiClass(element.className)) throw new BridgeError('INPUT', `Prototype "${protoName}": ${element.className} is not a GUI class. Use one of ${GUI_CLASSES.join(', ')}.`);
        let parent = 0;
        if (index === 0) { if (element.in !== undefined) throw new BridgeError('INPUT', `Prototype "${protoName}": the first element is the root and has no "in".`); }
        else {
          parent = element.in === undefined ? 1 : names.indexOf(element.in) + 1;
          if (parent < 1 || names.indexOf(element.in!) !== names.lastIndexOf(element.in!)) throw new BridgeError('INPUT', `Prototype "${protoName}": "in":"${element.in}" must name one earlier element.`);
        }
        names.push(element.name);
        return { className: element.className, name: element.name, parent, properties: compileGuiProps(element.className, element.ui ?? {}) };
      });
      guiRoots.set(protoIndexZero + 1, proto.ui[0]!.className as GuiClass);
      return { name: protoName, gui } as Json;
    }
    if (!proto.parts) throw new BridgeError('INPUT', `Prototype "${protoName}" needs parts or ui.`);
    return { name: protoName, weld: proto.weld, parts: proto.parts.map(part => ({ className: part.className, name: part.name,
      properties: props(part.props, input.defaults, part.className), tint: part.tint })) };
  });
  const guiRoot = input.container === 'ScreenGui';
  if (input.screen && !guiRoot) throw new BridgeError('INPUT', 'screen applies only to container ScreenGui.');
  const templateNames = Object.keys(input.templates ?? {});
  for (const name of templateNames) if (protoNames.includes(name)) throw new BridgeError('INPUT', `"${name}" is both a prototype and a template; rename one.`);
  const protoIndex = (useName: string) => {
    const index = protoNames.indexOf(useName);
    if (index >= 0) return index + 1;
    const template = templateNames.indexOf(useName);
    if (template < 0) throw new BridgeError('INPUT', `Unknown prototype or template "${useName}". Declare it under prototypes or templates.`);
    return -(template + 1);
  };
  /** One wire item for a prototype placement or a template clone (negative index). */
  const placeItem = (use: number, fields: { name: string; parent: number; at: number[]; yaw: number; scale: number; tint: Json; ground?: boolean | undefined }, extra: Record<string, Json> = {}): Json => use > 0
    ? { kind: 'place', template: use, name: fields.name, parent: fields.parent, at: fields.at, yaw: fields.yaw, scale: fields.scale, tint: fields.tint, ...(fields.ground ? { ground: true } : {}), ...extra }
    : { kind: 'clone', template: -use, name: fields.name, parent: fields.parent, at: fields.at, yaw: fields.yaw, scale: fields.scale, ...(fields.ground ? { ground: true } : {}), ...extra };
  const useName = (use: number) => use > 0 ? protoNames[use - 1]! : templateNames[-use - 1]!;
  const items: Json[] = [], groups = new Map<string, number>(), keys = new Set<string>();
  const occupancy = new Occupancy();
  const parentOf = (inKey: string | undefined) => {
    if (inKey === undefined) {
      if (guiRoot) throw new BridgeError('INPUT', 'A ScreenGui build holds only GUI items: a GUI className with ui, or use of a ui prototype.');
      return 0;
    }
    const index = groups.get(inKey);
    if (index === undefined) throw new BridgeError('INPUT', `"in":"${inKey}" must name an earlier Model/Folder item key.`);
    return index;
  };
  const hosts = new Map<string, { index: number; kind: EffectHost }>();
  /** Host of an effect or GUI item: the root (a ScreenGui root is a GUI layer), a group, or a keyed part/Attachment/Sound/GUI item. */
  const hostOf = (inKey: string | undefined): { index: number; kind: EffectHost } | undefined => {
    if (inKey === undefined) return { index: 0, kind: guiRoot ? 'layer' : 'group' };
    const group = groups.get(inKey);
    return group !== undefined ? { index: group, kind: 'group' } : hosts.get(inKey);
  };
  for (const item of input.items) {
    const effect = item.className !== undefined && isEffectClass(item.className) ? item.className : null;
    const gui = item.className !== undefined && isGuiClass(item.className) ? item.className : null;
    const stamp = item.use !== undefined && !gui && !effect && protoNames.includes(item.use) && guiRoots.has(protoIndex(item.use)) ? protoIndex(item.use) : null;
    const extra: Record<string, Json> = item.key ? { key: item.key } : {};
    if (item.key) { if (keys.has(item.key)) throw new BridgeError('INPUT', `Duplicate key "${item.key}".`); keys.add(item.key); }
    if (gui || stamp) {
      if (item.props || item.fx || (gui && item.use !== undefined)) throw new BridgeError('INPUT', 'A GUI item takes ui (not props/fx); stamp a ui prototype with use.');
      const host = hostOf(item.in);
      if (!host) throw new BridgeError('INPUT', `"in":"${item.in}" must name an earlier group, part, Attachment or GUI item key.`);
      const className = gui ?? guiRoots.get(stamp!)!;
      if (!(GUI_HOSTS[className] as readonly string[]).includes(host.kind)) throw new BridgeError('INPUT', `${className} must be inside a ${GUI_HOSTS[className].join(' or ')} item.`);
      const properties = compileGuiProps(className, item.ui ?? {});
      if (gui) {
        if (!item.name) throw new BridgeError('INPUT', 'A GUI item needs a name.');
        items.push({ kind: 'gui', className, name: item.name, parent: host.index, properties, ...extra });
      } else {
        const root = (prototypes[stamp! - 1] as { gui: { properties: Record<string, Json> }[] }).gui[0]!.properties;
        try { validateGuiProperties({ ...root, ...properties }, className); } catch (error) { throw new BridgeError('INPUT', `Stamp of "${item.use}": ${(error as Error).message}`); }
        items.push({ kind: 'stamp', template: stamp!, name: item.name ?? item.use!, parent: host.index, properties, ...extra });
      }
      const provides = GUI_HOST_CLASSES[className];
      if (item.key && provides) hosts.set(item.key, { index: items.length, kind: provides });
      continue;
    }
    if (item.ui) throw new BridgeError('INPUT', 'ui applies only to GUI classes and stamped ui prototypes.');
    const parent = effect ? 0 : parentOf(item.in);
    if (effect) {
      if (!item.name || item.props || item.use !== undefined) throw new BridgeError('INPUT', 'An effect item needs a name and fx (not props/use).');
      const host = hostOf(item.in);
      if (!host) throw new BridgeError('INPUT', `"in":"${item.in}" must name an earlier group, part, Attachment, Sound or SoundGroup item key.`);
      if (!EFFECT_HOSTS[effect].includes(host.kind)) throw new BridgeError('INPUT', `${effect} must be inside a ${EFFECT_HOSTS[effect].join(' or ')} item.`);
      const properties = compileEffectProps(effect, item.fx ?? {}, (value, label, kind) => {
        const target = typeof value === 'string' ? hosts.get(value) : undefined;
        if (!target || target.kind !== kind) throw new BridgeError('INPUT', `${label} must be the key of an earlier ${EFFECT_REF_CLASSES[kind]} item.`);
        return { type: 'Ref', item: target.index };
      });
      items.push({ kind: 'effect', className: effect, name: item.name, parent: host.index, properties, ...extra });
      const hostKind = EFFECT_HOST_CLASSES[effect];
      if (item.key && hostKind) hosts.set(item.key, { index: items.length, kind: hostKind });
      continue;
    }
    if (item.fx) throw new BridgeError('INPUT', 'fx applies only to effect classes.');
    if (item.use !== undefined) {
      if (!item.at) throw new BridgeError('INPUT', 'A placement ("use") needs "at".');
      items.push(placeItem(protoIndex(item.use), { name: item.name ?? item.use, parent, at: item.at, yaw: item.yaw ?? 0, scale: item.scale ?? 1, tint: item.tint ?? null, ground: item.ground }, extra));
      occupancy.add(item.at[0], item.at[2], 1);
    } else if (item.className === 'Model' || item.className === 'Folder') {
      if (!item.name) throw new BridgeError('INPUT', 'A group needs a name.');
      items.push({ kind: 'group', className: item.className, name: item.name, parent, ...extra });
      if (item.key) groups.set(item.key, items.length);
    } else {
      const className = item.className ?? 'Part';
      if (!item.name) throw new BridgeError('INPUT', 'A part needs a name.');
      items.push({ kind: 'part', className, name: item.name, parent, properties: props(item.props, input.defaults, className), ...extra });
      if (item.key) hosts.set(item.key, { index: items.length, kind: 'part' });
    }
  }
  const report: CompiledBuild['scatter'] = [], ranges: [number, number][] = [], anchors: { x: number; z: number; r: number }[] = [];
  for (const spec of input.scatter) {
    const first = items.length, hugAnchors = spec.hug ? anchors.slice() : [], group = report.length, soft = !!spec.hug;
    if ((spec.radius === undefined) === (spec.size === undefined)) throw new BridgeError('INPUT', 'Each scatter needs exactly one of radius or size.');
    const random = mulberry32(spec.seed), uses = (Array.isArray(spec.use) ? spec.use : [spec.use]).map(protoIndex), field = (spec as FieldScatter).field;
    if (uses.some(use => guiRoots.has(use))) throw new BridgeError('INPUT', 'scatter places part prototypes only; stamp ui prototypes with items.');
    const parent = parentOf(spec.in), [cx, cy, cz] = spec.center;
    const [smin, smax] = spec.scale ?? [0.75, 1.25], [ymin, ymax] = spec.yaw ?? [-180, 180];
    const inner = Math.min(spec.innerRadius ?? 0, spec.radius ?? 0);
    const inArea = (x: number, z: number) => spec.radius !== undefined
      ? (x - cx) ** 2 + (z - cz) ** 2 <= spec.radius ** 2 && (x - cx) ** 2 + (z - cz) ** 2 >= inner ** 2
      : Math.abs(x - cx) <= spec.size![0] / 2 && Math.abs(z - cz) <= spec.size![1] / 2;
    const uniform = (): [number, number] => {
      if (spec.radius !== undefined) {
        const r = Math.sqrt(random() * (spec.radius ** 2 - inner ** 2) + inner ** 2), t = random() * Math.PI * 2;
        return [cx + r * Math.cos(t), cz + r * Math.sin(t)];
      }
      return [cx + (random() - 0.5) * spec.size![0], cz + (random() - 0.5) * spec.size![1]];
    };
    const centres = spec.clusters ? Array.from({ length: spec.clusters }, uniform) : [];
    const spread = spec.clusterSpread ?? (spec.radius ?? Math.max(...spec.size!) / 2) / Math.sqrt(spec.clusters ?? 1);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const [fx, fz] = spec.clearing?.center ?? [cx, cz];
    const corridors = spec.avoidPaths?.flatMap(path => path.points.slice(1).map((to, i) => ({from: path.points[i]!, to, radius: path.width / 2}))) ?? [];
    let placed = 0;
    for (let attempt = 0; attempt < spec.count * 60 && placed < spec.count; attempt++) {
      let x: number, z: number;
      if (hugAnchors.length && random() < spec.hug!) { // just outside an earlier point's spacing disc, e.g. ferns at a trunk
        const a = hugAnchors[Math.floor(random() * hugAnchors.length)]!, d = a.r * CORE + spec.minSpacing / 2 * smax * (1.02 + random() * 1.5) + random() * a.r * 0.7, t = random() * Math.PI * 2;
        x = a.x + d * Math.cos(t); z = a.z + d * Math.sin(t);
      } else if (centres.length && random() < 0.85) { const c = centres[Math.floor(random() * centres.length)]!; x = c[0] + gauss() * spread * 0.5; z = c[1] + gauss() * spread * 0.5; }
      else [x, z] = uniform();
      if (!inArea(x, z) || spec.avoid?.some(a => (x - a.at[0]) ** 2 + (z - a.at[1]) ** 2 < a.radius ** 2)) continue;
      if (spec.edge) { // soft outer rim instead of a hard circular/rectangular forest edge
        const rim = spec.radius !== undefined ? spec.radius - Math.hypot(x - cx, z - cz) : Math.min(spec.size![0] / 2 - Math.abs(x - cx), spec.size![1] / 2 - Math.abs(z - cz));
        const t = Math.max(0, Math.min(1, rim / spec.edge));
        if (random() > t * t * (3 - 2 * t)) continue;
      }
      if (spec.clearing) {
        const d = Math.hypot(x - fx, z - fz), { inner: c0, outer: c1 } = spec.clearing;
        if (d < c0 || (d < c1 && random() > (d - c0) / Math.max(1e-6, c1 - c0))) continue;
      }
      // Kit layers carry spatial maps (scene-kits/spatial-maps): map density, age-driven scale, neighbour-aware variant/yaw/tint.
      if (field && random() > field.density(x, z)) continue;
      const scale = field ? field.scale(x, z, smin, smax, random()) : smin + random() * (smax - smin), r = (spec.minSpacing / 2) * scale;
      // Check the emitted coordinates and scale, so rounding cannot put a canopy back into a route.
      if (spec.footprintRadius !== undefined || spec.avoidPaths?.length) {
        const px = round(x, 2), pz = round(z, 2), footprint = (spec.footprintRadius ?? 0) * round(scale, 3);
        if (spec.clearing && Math.hypot(px - fx, pz - fz) < spec.clearing.inner + footprint) continue;
        if (spec.avoid?.some(a => Math.hypot(px - a.at[0], pz - a.at[1]) < a.radius + footprint)) continue;
        if (corridors.some(path => segmentDistanceSquared(px, pz, path.from, path.to) < (path.radius + footprint) ** 2)) continue;
      }
      if (!occupancy.ok(x, z, r, group, soft)) continue;
      occupancy.add(x, z, r, group); anchors.push({ x, z, r });
      const chosen = field?.pick(x, z, uses.map(useName), scale, random);
      const use = chosen ? uses[chosen.index]! : uses[Math.floor(random() * uses.length)]!;
      const t = chosen ? chosen.tint ?? null : spec.tint ? spec.tint.min.map((low, i) => round(low + random() * (spec.tint!.max[i]! - low), 3)) : null;
      items.push(placeItem(use, { name: spec.name ?? useName(use), parent, at: [round(x, 2), round(cy, 2), round(z, 2)],
        yaw: chosen ? chosen.yaw : round(ymin + random() * (ymax - ymin), 1), scale: round(scale, 3), tint: t, ground: spec.ground }));
      placed++;
    }
    report.push({ requested: spec.count, placed }); ranges.push([first, items.length]);
  }
  if (!items.length) throw new BridgeError('INPUT', 'Add at least one item or scatter.');
  if (items.length > SCENE_BUILD_LIMITS.items) throw new BridgeError('BODY_LIMIT', `A build may contain at most ${SCENE_BUILD_LIMITS.items} items; split it into a few builds.`);
  const container: Record<string, Json> = { className: input.container, name: input.name };
  if (guiRoot) container.properties = compileGuiProps('ScreenGui', { ResetOnSpawn: false, ZIndexBehavior: 'Sibling', ...(input.screen ?? {}) });
  const args: Record<string, Json> = { parent, container, prototypes, items,
    ...(templateNames.length ? { templates: templateNames.map(name => input.templates![name] as unknown as Json) } : {}) };
  let instances = 1;
  for (const item of items as { kind: string; template?: number }[]) {
    if (item.kind === 'stamp') { instances += (prototypes[item.template! - 1] as { gui: unknown[] }).gui.length; continue; }
    if (item.kind !== 'place') { instances++; continue; }
    const proto = (prototypes[item.template! - 1] as { parts: unknown[]; weld: boolean }), count = proto.parts.length;
    instances += count === 1 ? 1 : 1 + count + (proto.weld ? count - 1 : 0);
  }
  if (instances > SCENE_BUILD_LIMITS.instances) throw new BridgeError('BODY_LIMIT', `This build would create ${instances} instances (max ${SCENE_BUILD_LIMITS.instances}); split it into a few builds.`);
  if (Buffer.byteLength(JSON.stringify(args)) > 250 * 1024) throw new BridgeError('BODY_LIMIT', 'Compiled build exceeds 250 KiB; split it into a few builds.');
  const kits = plans.map(plan => {
    // Kit budgets: primitive triangle estimates per emitted part; template clones use the layer's tris or a default.
    const kit = { ...plan.report, parts: 0, triangles: 0 };
    const tally = (item: { kind: string; template?: number; className?: string; properties?: { Shape?: string } }) => {
      if (item.kind === 'part') { kit.parts++; kit.triangles += partTriangles(item.className!, item.properties?.Shape); }
      else if (item.kind === 'place') for (const p of (prototypes[item.template! - 1] as { parts: { className: string; properties: { Shape?: string } }[] }).parts) { kit.parts++; kit.triangles += partTriangles(p.className, p.properties.Shape); }
      else if (item.kind === 'clone') kit.triangles += plan.tris.get(templateNames[item.template! - 1]!) ?? TEMPLATE_TRIANGLES;
    };
    for (let i = plan.items[0]; i < plan.items[1]; i++) tally(items[i] as never);
    for (const si of plan.scatter) { for (let i = ranges[si]![0]; i < ranges[si]![1]; i++) tally(items[i] as never); kit.placed! += report[si]!.placed; }
    if (kit.triangles > KIT_TRIANGLE_BUDGET) throw new BridgeError('BODY_LIMIT', `Kit "${kit.key}" is about ${kit.triangles} triangles (max ${KIT_TRIANGLE_BUDGET}); lower counts or template triangleBudget.`);
    return kit;
  });
  return { args, scatter: report, instances, kits };
}
const partTriangles = (className: string, shape: string | undefined) => (className === 'Part' || className === 'SpawnLocation' ? PRIMITIVE_TRIANGLES[shape ?? 'Block'] : PRIMITIVE_TRIANGLES[className]) ?? 12;

// environment_apply: compact colours, then the daemon/plugin enforce the same fixed allowlist.
const sectionSchema = (spec: Record<string, readonly [number, number] | 'color' | 'boolean'>) => z.strictObject(Object.fromEntries(Object.entries(spec).map(([k, kind]) =>
  [k, (kind === 'boolean' ? z.boolean() : kind === 'color' ? colorInput : z.number().min(kind[0]).max(kind[1])).optional()])));
export const environmentShape = {
  terrain: z.array(z.strictObject({
    shape: z.enum(TERRAIN_SHAPES), material: z.enum(TERRAIN_MATERIALS).describe('Air carves.'), center: v3,
    size: v3.optional().describe('Block/Wedge size.'), radius: z.number().min(1).max(ENVIRONMENT_LIMITS.extent / 2).optional().describe('Ball/Cylinder radius.'),
    height: z.number().min(1).max(ENVIRONMENT_LIMITS.extent).optional().describe('Cylinder height.'), orientation: v3.optional(),
  })).min(1).max(ENVIRONMENT_LIMITS.terrainShapes).optional().describe('Ordered Terrain fills (later shapes overwrite earlier ones).'),
  ...Object.fromEntries(Object.entries(ENVIRONMENT_PROPERTIES).map(([section, spec]) => [section, sectionSchema(spec).optional()])),
  preset: z.enum(ENVIRONMENT_PRESET_NAMES as [string, ...string[]]).optional().describe('Look expanded host-side to exact section values (forest-*: Future, depthOfField, built-in sky, Forest reverb with Workspace grant); explicit values override.'),
  technology: z.enum(LIGHTING_TECHNOLOGIES).optional().describe('Lighting.Technology (Future for photoreal). If Studio refuses, the error names the Properties-window step.'),
  terrainDecoration: z.boolean().optional().describe('Workspace.Terrain.Decoration (animated grass on Grass terrain).'),
  materials: z.array(z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9_ -]{1,50}$/), baseMaterial: z.enum(MATERIALS), studsPerTile: z.number().min(0.1).max(1000).optional(),
    override: z.boolean().optional().describe('Make it the MaterialService override for baseMaterial (all parts/terrain of that material).'),
    ...Object.fromEntries(VARIANT_MAPS.map(map => [map, z.string().max(200).optional()])),
  })).min(1).max(EFFECT_LIMITS.materials).optional().describe('MaterialVariants created under MaterialService; maps are rbxassetid://<digits> or rbxasset://textures/... only.'),
  soundService: z.strictObject({
    AmbientReverb: z.enum(REVERB_TYPES).optional().describe('World reverb preset (per-area reverb: ReverbSoundEffect on a SoundGroup).'),
    DistanceFactor: z.number().min(SOUND_SERVICE_PROPERTIES.DistanceFactor[0]).max(SOUND_SERVICE_PROPERTIES.DistanceFactor[1]).optional().describe('Studs per metre (default 3.33).'),
    DopplerScale: z.number().min(SOUND_SERVICE_PROPERTIES.DopplerScale[0]).max(SOUND_SERVICE_PROPERTIES.DopplerScale[1]).optional(),
    RolloffScale: z.number().min(SOUND_SERVICE_PROPERTIES.RolloffScale[0]).max(SOUND_SERVICE_PROPERTIES.RolloffScale[1]).optional().describe('Global distance attenuation multiplier (default 1).'),
  }).optional().describe('SoundService settings (Workspace grant); verified after assignment and rolled back with the rest on failure.'),
} as Record<string, z.ZodTypeAny>;

export function compileEnvironment(input: Record<string, unknown>): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (input.terrain) out.terrain = (input.terrain as Record<string, unknown>[]).map(shape => {
    const kind = shape.shape as string, base: Record<string, Json> = { shape: kind, material: shape.material as string, center: shape.center as Json };
    if (kind === 'Ball') { if (shape.radius === undefined) throw new BridgeError('INPUT', 'A terrain Ball needs radius.'); return { ...base, radius: shape.radius as number }; }
    const orientation = shape.orientation ? { orientation: shape.orientation as Json } : {};
    if (kind === 'Cylinder') {
      if (shape.radius === undefined || shape.height === undefined) throw new BridgeError('INPUT', 'A terrain Cylinder needs radius and height.');
      return { ...base, radius: shape.radius as number, height: shape.height as number, ...orientation };
    }
    if (!shape.size) throw new BridgeError('INPUT', `A terrain ${kind} needs size.`);
    return { ...base, size: shape.size as Json, ...orientation };
  });
  for (const section of Object.keys(ENVIRONMENT_PROPERTIES)) {
    const values = input[section] as Record<string, unknown> | undefined;
    if (!values) continue;
    const spec = ENVIRONMENT_PROPERTIES[section as keyof typeof ENVIRONMENT_PROPERTIES] as Record<string, unknown>;
    out[section] = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, spec[k] === 'color' ? (tagged('Color3', v) as { value: number[] }).value : v as Json]));
  }
  for (const extra of ['preset', 'technology', 'terrainDecoration'] as const) if (input[extra] !== undefined) out[extra] = input[extra] as Json;
  if (input.soundService) {
    const values = Object.fromEntries(Object.entries(input.soundService as Record<string, unknown>).filter(([, v]) => v !== undefined)) as Record<string, Json>;
    if (Object.keys(values).length) out.soundService = values;
  }
  if (input.materials) out.materials = (input.materials as Record<string, unknown>[]).map(variant =>
    Object.fromEntries(Object.entries(variant).filter(([, v]) => v !== undefined)) as Json);
  if (!Object.keys(out).length) throw new BridgeError('INPUT', 'Choose terrain shapes or lighting/effect settings.');
  return out;
}
