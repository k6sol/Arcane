import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { SCENE_BUILD_LIMITS, ENVIRONMENT_LIMITS } from '../../../packages/protocol/src/studio.js';
import { BUILD_GROUP_CLASSES, BUILD_PART_CLASSES, ENVIRONMENT_PROPERTIES, MATERIALS, SHAPES, TERRAIN_MATERIALS, TERRAIN_SHAPES, validateProperties } from '../../../packages/core/src/studio-policy.js';
import { BridgeError } from './daemon-client.js';
import { id } from './schemas.js';

/** Compact model-facing build input. It is compiled locally into the strict scene.build wire
 * form (explicit prototypes and placements), so a forest is one short call, not hundreds. */
const n = z.number().finite();
const v3 = z.tuple([n, n, n]);
const unit = z.number().min(0).max(1);
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Use #rrggbb.');
export const colorInput = z.union([z.tuple([unit, unit, unit]), hex, z.strictObject({ type: z.literal('Color3'), value: z.tuple([unit, unit, unit]) })])
  .describe('[r,g,b] 0..1, "#rrggbb" or tagged Color3.');
const vector = z.union([v3, z.strictObject({ type: z.literal('Vector3'), value: v3 })]).describe('[x,y,z] or tagged Vector3.');
const name = id.max(100);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const compactProps = z.strictObject({
  Size: vector.optional(), Position: vector.optional(), Orientation: vector.optional(), Color: colorInput.optional(),
  Material: z.enum(MATERIALS).optional(), Shape: z.enum(SHAPES).optional(), Anchored: z.boolean().optional(), CanCollide: z.boolean().optional(),
  CastShadow: z.boolean().optional(), Transparency: unit.optional(), Reflectance: unit.optional(),
}).describe('Part properties. Vectors as [x,y,z]; Color as [r,g,b] or "#rrggbb". Anchored defaults true.');
const buildClass = z.enum([...BUILD_GROUP_CLASSES, ...BUILD_PART_CLASSES]);
const range = z.tuple([n, n]);
const tint = z.tuple([z.number().min(0).max(2), z.number().min(0).max(2), z.number().min(0).max(2)]);

export const sceneBuildShape = {
  name: name.describe('Name of the Model/Folder that holds the whole build.'),
  container: z.enum(BUILD_GROUP_CLASSES).default('Model'),
  defaults: compactProps.optional().describe('Properties applied to every part before its own props (Anchored:true is already implied).'),
  prototypes: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.strictObject({
    parts: z.array(z.strictObject({ name, className: z.enum(BUILD_PART_CLASSES).default('Part'), props: compactProps.optional(),
      tint: z.boolean().default(true).describe('Whether placement tint multiplies this part Color.') })).min(1).max(SCENE_BUILD_LIMITS.prototypeParts),
    weld: z.boolean().default(false).describe('WeldConstraint every part to the first (only useful when unanchored).'),
  })).optional().describe('Reusable multi-part templates (trees, rocks, lamps). Part Position/Orientation are relative to the placement origin at ground level; Size scales with placement scale.'),
  items: z.array(z.strictObject({
    key: key.optional().describe('Local id; returned with a real ref, and usable as "in" for later items.'),
    in: key.optional().describe('Key of an earlier Model/Folder item; default is the build root.'),
    name: name.optional(), className: buildClass.optional().describe('Model/Folder group, or a part class (default Part when props are given).'),
    props: compactProps.optional(), use: z.string().optional().describe('Prototype name to place.'),
    at: v3.optional(), yaw: z.number().min(-360).max(360).optional(), scale: z.number().min(0.1).max(20).optional(), tint: tint.optional(),
    ground: z.boolean().optional().describe('Drop the placement onto the surface below (terrain or parts).'),
  })).max(SCENE_BUILD_LIMITS.items).default([]),
  scatter: z.array(z.strictObject({
    use: z.union([z.string(), z.array(z.string()).min(1).max(16)]).describe('Prototype name(s); one is chosen per point (repeat a name to weight it).'),
    in: key.optional(), name: name.optional(),
    count: z.number().int().min(1).max(SCENE_BUILD_LIMITS.items),
    center: v3.describe('Area centre; y is the ground height.'),
    radius: z.number().positive().max(4096).optional(), innerRadius: z.number().min(0).max(4096).optional(),
    size: z.tuple([z.number().positive().max(8192), z.number().positive().max(8192)]).optional().describe('Rectangle [width, depth] instead of radius.'),
    minSpacing: z.number().min(0.5).max(512).describe('Poisson-disk spacing at scale 1; also keeps clear of earlier scatter points.'),
    clusters: z.number().int().min(1).max(64).optional().describe('Group points into this many natural clumps.'),
    clusterSpread: z.number().positive().max(2048).optional(),
    clearing: z.strictObject({ center: z.tuple([n, n]).optional(), inner: z.number().min(0), outer: z.number().min(0) }).optional()
      .describe('Density falloff: no points within inner of the centre [x,z], ramping to full density at outer.'),
    avoid: z.array(z.strictObject({ at: z.tuple([n, n]), radius: z.number().positive() })).max(32).optional().describe('Keep-out circles [x,z].'),
    yaw: range.optional(), scale: range.optional().describe('Default [0.75, 1.25].'),
    tint: z.strictObject({ min: tint, max: tint }).optional(), seed: z.number().int().min(0).max(2 ** 31).default(1),
    ground: z.boolean().default(false),
  })).max(16).default([]),
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

/** Shared occupancy across scatter groups: natural spacing with no grid or ring structure. */
class Occupancy {
  readonly cell = 8; readonly points = new Map<string, { x: number; z: number; r: number }[]>(); maxR = 0;
  ok(x: number, z: number, r: number): boolean {
    const reach = Math.ceil((r + this.maxR) / this.cell), cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let i = cx - reach; i <= cx + reach; i++) for (let j = cz - reach; j <= cz + reach; j++)
      for (const p of this.points.get(i + ',' + j) ?? []) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2) return false;
    return true;
  }
  add(x: number, z: number, r: number): void {
    const k = Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell);
    (this.points.get(k) ?? this.points.set(k, []).get(k)!).push({ x, z, r }); this.maxR = Math.max(this.maxR, r);
  }
}

export interface CompiledBuild { args: Record<string, Json>; scatter: { requested: number; placed: number }[]; instances: number }
export function compileSceneBuild(input: SceneBuildInput, parent: Json): CompiledBuild {
  const protoNames = Object.keys(input.prototypes ?? {});
  const prototypes: Json[] = protoNames.map(protoName => {
    const proto = input.prototypes![protoName]!;
    return { name: protoName, weld: proto.weld, parts: proto.parts.map(part => ({ className: part.className, name: part.name,
      properties: props(part.props, input.defaults, part.className), tint: part.tint })) };
  });
  const protoIndex = (useName: string) => {
    const index = protoNames.indexOf(useName);
    if (index < 0) throw new BridgeError('INPUT', `Unknown prototype "${useName}". Declare it under prototypes.`);
    return index + 1;
  };
  const items: Json[] = [], groups = new Map<string, number>(), keys = new Set<string>();
  const occupancy = new Occupancy();
  const parentOf = (inKey: string | undefined) => {
    if (inKey === undefined) return 0;
    const index = groups.get(inKey);
    if (index === undefined) throw new BridgeError('INPUT', `"in":"${inKey}" must name an earlier Model/Folder item key.`);
    return index;
  };
  for (const item of input.items) {
    const parent = parentOf(item.in);
    const extra: Record<string, Json> = item.key ? { key: item.key } : {};
    if (item.key) { if (keys.has(item.key)) throw new BridgeError('INPUT', `Duplicate key "${item.key}".`); keys.add(item.key); }
    if (item.use !== undefined) {
      if (!item.at) throw new BridgeError('INPUT', 'A placement ("use") needs "at".');
      items.push({ kind: 'place', template: protoIndex(item.use), name: item.name ?? item.use, parent, at: item.at, yaw: item.yaw ?? 0,
        scale: item.scale ?? 1, tint: item.tint ?? null, ...(item.ground ? { ground: true } : {}), ...extra });
      occupancy.add(item.at[0], item.at[2], 1);
    } else if (item.className === 'Model' || item.className === 'Folder') {
      if (!item.name) throw new BridgeError('INPUT', 'A group needs a name.');
      items.push({ kind: 'group', className: item.className, name: item.name, parent, ...extra });
      if (item.key) groups.set(item.key, items.length);
    } else {
      const className = item.className ?? 'Part';
      if (!item.name) throw new BridgeError('INPUT', 'A part needs a name.');
      items.push({ kind: 'part', className, name: item.name, parent, properties: props(item.props, input.defaults, className), ...extra });
    }
  }
  const report: CompiledBuild['scatter'] = [];
  for (const spec of input.scatter) {
    if ((spec.radius === undefined) === (spec.size === undefined)) throw new BridgeError('INPUT', 'Each scatter needs exactly one of radius or size.');
    const random = mulberry32(spec.seed), uses = (Array.isArray(spec.use) ? spec.use : [spec.use]).map(protoIndex);
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
    let placed = 0;
    for (let attempt = 0; attempt < spec.count * 60 && placed < spec.count; attempt++) {
      let x: number, z: number;
      if (centres.length && random() < 0.85) { const c = centres[Math.floor(random() * centres.length)]!; x = c[0] + gauss() * spread * 0.5; z = c[1] + gauss() * spread * 0.5; }
      else [x, z] = uniform();
      if (!inArea(x, z) || spec.avoid?.some(a => (x - a.at[0]) ** 2 + (z - a.at[1]) ** 2 < a.radius ** 2)) continue;
      if (spec.clearing) {
        const d = Math.hypot(x - fx, z - fz), { inner: c0, outer: c1 } = spec.clearing;
        if (d < c0 || (d < c1 && random() > (d - c0) / Math.max(1e-6, c1 - c0))) continue;
      }
      const scale = smin + random() * (smax - smin), r = (spec.minSpacing / 2) * scale;
      if (!occupancy.ok(x, z, r)) continue;
      occupancy.add(x, z, r);
      const use = uses[Math.floor(random() * uses.length)]!;
      const t = spec.tint ? spec.tint.min.map((low, i) => round(low + random() * (spec.tint!.max[i]! - low), 3)) : null;
      items.push({ kind: 'place', template: use, name: spec.name ?? protoNames[use - 1]!, parent, at: [round(x, 2), round(cy, 2), round(z, 2)],
        yaw: round(ymin + random() * (ymax - ymin), 1), scale: round(scale, 3), tint: t, ...(spec.ground ? { ground: true } : {}) });
      placed++;
    }
    report.push({ requested: spec.count, placed });
  }
  if (!items.length) throw new BridgeError('INPUT', 'Add at least one item or scatter.');
  if (items.length > SCENE_BUILD_LIMITS.items) throw new BridgeError('BODY_LIMIT', `A build may contain at most ${SCENE_BUILD_LIMITS.items} items; split it into a few builds.`);
  const args: Record<string, Json> = { parent, container: { className: input.container, name: input.name }, prototypes, items };
  let instances = 1;
  for (const item of items as { kind: string; template?: number }[]) {
    if (item.kind !== 'place') { instances++; continue; }
    const proto = (prototypes[item.template! - 1] as { parts: unknown[]; weld: boolean }), count = proto.parts.length;
    instances += count === 1 ? 1 : 1 + count + (proto.weld ? count - 1 : 0);
  }
  if (instances > SCENE_BUILD_LIMITS.instances) throw new BridgeError('BODY_LIMIT', `This build would create ${instances} instances (max ${SCENE_BUILD_LIMITS.instances}); split it into a few builds.`);
  if (Buffer.byteLength(JSON.stringify(args)) > 250 * 1024) throw new BridgeError('BODY_LIMIT', 'Compiled build exceeds 250 KiB; split it into a few builds.');
  return { args, scatter: report, instances };
}

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
  if (!Object.keys(out).length) throw new BridgeError('INPUT', 'Choose terrain shapes or lighting/effect settings.');
  return out;
}
