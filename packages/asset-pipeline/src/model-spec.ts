import { AssetError } from './types.js';
import type { Vec3 } from './types.js';

/** Declarative model spec ("part graph") for assets_procedural kind "spec": parts built by
 * spatial-math operators (box, cylinder, sphere, revolve, extrude, loft, sweep, sdf) with
 * transforms, symmetry, arrays, scatter, CSG, noise and up to three PBR material slots.
 * Data only (numbers, enums, ids, point lists). The worker (workers/blender/grammar/model_spec.py)
 * enforces the same rules; this host copy rejects bad specs early with an actionable message.
 * Normalization is canonical: material defaults become explicit, every object is re-emitted
 * with known keys only in a fixed order, so a stored request re-normalizes to itself. */
export const MODEL_OPS = ['box', 'cylinder', 'sphere', 'revolve', 'extrude', 'loft', 'sweep', 'sdf'] as const;
export const MODEL_FINISHES = ['wood', 'stone', 'metal', 'plaster', 'ceramic', 'leather', 'fabric', 'plastic', 'glass'] as const;
export type ModelFinish = typeof MODEL_FINISHES[number];
const SHAPES = ['circle', 'ellipse', 'rect', 'ngon', 'star', 'polygon'] as const;
const PRIMS = ['sphere', 'box', 'capsule', 'torus', 'cone', 'cylinder', 'ellipsoid'] as const;
const CSG = ['union', 'subtract', 'intersect'] as const;
const MIRRORS = ['x', 'y', 'z', 'xy', 'xz', 'yz', 'xyz'] as const;
const AXES = ['x', 'y', 'z'] as const;
/** finish -> [evidence profile, roughness, metallic, edge wear, cavity, default linear colour]; must match model_spec.FINISHES. */
export const MODEL_FINISH_DEFAULTS: Readonly<Record<ModelFinish, readonly ['bark' | 'stone' | 'weathered', number, number, number, number, Vec3]>> = Object.freeze({
  wood: ['bark', .7, 0, .35, .5, [.34, .2, .1]], stone: ['stone', .86, 0, .4, .6, [.46, .44, .4]],
  metal: ['weathered', .42, 1, .45, .55, [.3, .3, .31]], plaster: ['stone', .9, 0, .25, .45, [.74, .71, .65]],
  ceramic: ['stone', .32, 0, .2, .4, [.78, .76, .7]], leather: ['weathered', .62, 0, .35, .45, [.24, .13, .07]],
  fabric: ['weathered', .92, 0, .15, .4, [.4, .3, .24]], plastic: ['weathered', .45, 0, .15, .3, [.55, .1, .08]],
  glass: ['weathered', .06, 0, .05, .2, [.5, .58, .55]],
});
export const MODEL_LIMITS = Object.freeze({ parts: 48, materials: 3, instances: 640, points: 64, sections: 32, prims: 24, coord: 50, size: [0.02, 40] as const,
  length: [0.0005, 40] as const, count: 64, scatter: 256, defaultTriangles: 8000 });
export interface ModelMaterial { id: string; finish: ModelFinish; color: Vec3; roughness: number; metallic: number; wear: number; cavity: number }
export interface ModelSpec {
  kind: 'spec'; finish?: 'natural' | 'flat'; size: Vec3; pivot?: 'base' | 'origin'; smoothAngle?: number;
  materials: ModelMaterial[]; parts: Record<string, unknown>[];
}

type R = Record<string, unknown>;
const ID = /^[a-z][a-z0-9_]{0,23}$/, MATERIAL_ID = /^[a-z][a-z0-9]{0,15}$/;
function fail(message: string): never { throw new AssetError('INPUT', 'Model spec: ' + message); }
function fields(value: unknown, allowed: readonly string[], where: string): R {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where + ' must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where + ' has an unsupported field' + (ID.test(key) ? ' ' + key : ''));
  return value as R;
}
function num(v: unknown, low: number, high: number, where: string, optional = false): number | undefined {
  if (v === undefined || v === null) { if (optional) return undefined; fail(where + ' is required'); }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high) fail(`${where} must be a number in ${low}..${high}`);
  return v;
}
function int(v: unknown, low: number, high: number, where: string, optional = false): number | undefined {
  const n = num(v, low, high, where, optional);
  if (n !== undefined && !Number.isInteger(n)) fail(where + ' must be an integer');
  return n;
}
function pick<T extends string>(v: unknown, options: readonly T[], where: string, optional = false): T | undefined {
  if (v === undefined || v === null) { if (optional) return undefined; fail(where + ' is required'); }
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) fail(where + ' must be one of ' + options.join(', '));
  return v as T;
}
function bool(v: unknown, where: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') fail(where + ' must be true or false');
  return v;
}
function vec(v: unknown, n: number, low: number, high: number, where: string, optional = false): number[] | undefined {
  if (v === undefined || v === null) { if (optional) return undefined; fail(where + ' is required'); }
  if (!Array.isArray(v) || v.length !== n) fail(`${where} must be ${n} numbers`);
  return v.map(x => num(x, low, high, where)!);
}
function points(v: unknown, dims: number, low: number, where: string, lo = -50, hi = 50): number[][] {
  if (!Array.isArray(v) || v.length < low || v.length > MODEL_LIMITS.points) fail(`${where} needs ${low}..${MODEL_LIMITS.points} points`);
  return v.map(p => vec(p, dims, lo, hi, where + ' point')!);
}
const area2 = (pts: number[][]) => pts.reduce((sum, a, i) => { const b = pts[(i + 1) % pts.length]!; return sum + a[0]! * b[1]! - b[0]! * a[1]!; }, 0) / 2;
/** Re-emit with defined values only, in the given key order. */
function out(entries: [string, unknown][]): R { return Object.fromEntries(entries.filter(([, v]) => v !== undefined)); }

function shape(value: unknown, where: string): R {
  const s = fields(value, ['type', 'r', 'rx', 'ry', 'w', 'h', 'n', 'r2', 'points', 'round'], where);
  const type = pick(s.type, SHAPES, where + '.type')!, [lo, hi] = MODEL_LIMITS.length;
  const round = num(s.round, 0, 10, where + '.round', true);
  const o: [string, unknown][] = [['type', type]];
  if (type === 'circle') o.push(['r', num(s.r, lo, hi, where + '.r')]);
  else if (type === 'ellipse') o.push(['rx', num(s.rx, lo, hi, where + '.rx')], ['ry', num(s.ry, lo, hi, where + '.ry')]);
  else if (type === 'rect') {
    const w = num(s.w, lo, hi, where + '.w')!, h = num(s.h, lo, hi, where + '.h')!;
    if ((round ?? 0) * 2 >= Math.min(w, h)) fail(where + '.round must be less than half the smaller side');
    o.push(['w', w], ['h', h]);
  } else if (type === 'ngon' || type === 'star') {
    o.push(['n', int(s.n, 3, 64, where + '.n')], ['r', num(s.r, lo, hi, where + '.r')]);
    if (type === 'star') o.push(['r2', num(s.r2, lo, hi, where + '.r2')]);
  } else {
    const pts = points(s.points, 2, 3, where + '.points');
    if (area2(pts) === 0) fail(where + '.points enclose no area');
    o.push(['points', pts]);
  }
  o.push(['round', round]);
  return out(o);
}
function path(value: unknown, where: string): R {
  const p = fields(value, ['points', 'curve', 'closed'], where);
  const closed = bool(p.closed, where + '.closed') ?? false, curve = pick(p.curve, ['linear', 'catmull', 'bezier'] as const, where + '.curve', true) ?? 'catmull';
  const pts = points(p.points, 3, closed ? 3 : 2, where + '.points');
  if (curve === 'bezier' && !closed && (pts.length - 1) % 3) fail(where + ' bezier paths need 3k+1 points (anchor, handle, handle, anchor, ...)');
  if (curve === 'bezier' && closed && pts.length % 3) fail(where + ' closed bezier paths need 3k points');
  if (pts.some((a, i) => i > 0 && Math.hypot(a[0]! - pts[i - 1]![0]!, a[1]! - pts[i - 1]![1]!, a[2]! - pts[i - 1]![2]!) < 1e-5)) fail(where + ' has repeated consecutive points');
  return out([['points', pts], ['curve', p.curve === undefined ? undefined : curve], ['closed', p.closed === undefined ? undefined : closed]]);
}
function curveSamples(v: unknown, where: string): number[][] | undefined {
  if (v === undefined || v === null) return undefined;
  const pts = points(v, 2, 2, where, -100, 100);
  if (pts.some(([t]) => t! < 0 || t! > 1) || pts.some((p, i) => i > 0 && p[0]! <= pts[i - 1]![0]!)) fail(where + ' needs ascending t in 0..1');
  if (pts.some(([, s]) => s! < 0 || s! > 20)) fail(where + ' values must be 0..20');
  return pts;
}
function noise(v: unknown, where: string): R | undefined {
  if (v === undefined || v === null) return undefined;
  const n = fields(v, ['amp', 'scale', 'octaves', 'warp', 'mask', 'seed'], where);
  let mask: R | undefined;
  if (n.mask !== undefined && n.mask !== null) {
    const m = fields(n.mask, ['axis', 'from', 'to'], where + '.mask');
    const from = num(m.from, -50, 50, where + '.mask.from'), to = num(m.to, -50, 50, where + '.mask.to');
    if (from === to) fail(where + '.mask from and to must differ');
    mask = out([['axis', pick(m.axis, AXES, where + '.mask.axis', true)], ['from', from], ['to', to]]);
  }
  return out([['amp', num(n.amp, 0, 2, where + '.amp')], ['scale', num(n.scale, .005, 20, where + '.scale', true)], ['octaves', int(n.octaves, 1, 6, where + '.octaves', true)],
    ['warp', num(n.warp, 0, 2, where + '.warp', true)], ['mask', mask], ['seed', int(n.seed, 0, 65535, where + '.seed', true)]]);
}
function prim(value: unknown, where: string): R {
  const p = fields(value, ['prim', 'at', 'rot', 'r', 'r2', 'size', 'a', 'b', 'h', 'radii', 'round', 'op', 'blend'], where);
  const kind = pick(p.prim, PRIMS, where + '.prim')!, [lo, hi] = MODEL_LIMITS.length, c = MODEL_LIMITS.coord;
  const round = num(p.round, 0, 5, where + '.round', true) ?? 0;
  const o: [string, unknown][] = [['prim', kind], ['at', vec(p.at, 3, -c, c, where + '.at', true)], ['rot', vec(p.rot, 3, -720, 720, where + '.rot', true)]];
  if (kind === 'sphere') o.push(['r', num(p.r, lo, hi, where + '.r')]);
  else if (kind === 'box') {
    const size = vec(p.size, 3, lo, hi, where + '.size')!;
    if (round * 2 >= Math.min(...size)) fail(where + '.round must be less than half the smallest size');
    o.push(['size', size]);
  } else if (kind === 'capsule') o.push(['a', vec(p.a, 3, -c, c, where + '.a')], ['b', vec(p.b, 3, -c, c, where + '.b')], ['r', num(p.r, lo, hi, where + '.r')], ['r2', num(p.r2, lo, hi, where + '.r2', true)]);
  else if (kind === 'torus') {
    const r = num(p.r, lo, hi, where + '.r')!, r2 = num(p.r2, lo, hi, where + '.r2')!;
    if (r2 >= r) fail(where + ' torus tube radius r2 must be smaller than r');
    o.push(['r', r], ['r2', r2]);
  } else if (kind === 'cone' || kind === 'cylinder') {
    const r = num(p.r, kind === 'cylinder' ? lo : 0, hi, where + '.r')!, h = num(p.h, lo, hi, where + '.h');
    const r2 = num(p.r2, 0, hi, where + '.r2', true);
    if (Math.max(r, r2 ?? (kind === 'cone' ? 0 : r)) <= 0) fail(where + ' needs a positive radius');
    o.push(['r', r], ['r2', r2], ['h', h]);
  } else o.push(['radii', vec(p.radii, 3, lo, hi, where + '.radii')]);
  o.push(['round', p.round === undefined ? undefined : round], ['op', pick(p.op, CSG, where + '.op', true)], ['blend', num(p.blend, 0, 5, where + '.blend', true)]);
  return out(o);
}

const COMMON = ['id', 'op', 'material', 'at', 'rot', 'scale', 'parent', 'mirror', 'radial', 'array', 'scatter', 'csg', 'with', 'noise', 'smooth', 'detail', 'grain', 'segments'] as const;
const OP_FIELDS: Record<typeof MODEL_OPS[number], readonly string[]> = {
  box: ['size', 'bevel'], cylinder: ['radius', 'radiusTop', 'height', 'bevel'], sphere: ['radius'], revolve: ['profile', 'curve', 'flutes', 'closed'],
  extrude: ['shape', 'height', 'bevel', 'inset'], loft: ['sections', 'curve'], sweep: ['path', 'shape', 'twist', 'taper'], sdf: ['shapes', 'resolution'],
};
const ALL_FIELDS = [...COMMON, ...new Set(Object.values(OP_FIELDS).flat())];

function copies(p: R): number {
  let n = 1;
  const a = p.array as R | undefined, r = p.radial as R | undefined;
  if (a) n *= a.grid ? (a.grid as number[]).reduce((x, y) => x * y, 1) : a.count as number;
  if (r) n *= r.count as number;
  if (p.mirror) n *= 2 ** (p.mirror as string).length;
  return n;
}

function part(value: unknown, index: number, materials: string[]): R {
  let where = `parts[${index}]`;
  const p = fields(value, ALL_FIELDS, where);
  if (typeof p.id !== 'string' || !ID.test(p.id)) fail(where + '.id must be a lowercase id (a-z, 0-9, _; up to 24 characters)');
  where = 'part ' + p.id;
  const op = pick(p.op, MODEL_OPS, where + '.op')!;
  const extra = Object.keys(p).filter(k => !(COMMON as readonly string[]).includes(k) && !OP_FIELDS[op].includes(k)).sort();
  if (extra.length) fail(`${where} (${op}) does not take ${extra.join(', ')}`);
  const c = MODEL_LIMITS.coord, [lo, hi] = MODEL_LIMITS.length;
  const csg = pick(p.csg, CSG, where + '.csg', true);
  const cutter = csg === 'subtract' || csg === 'intersect';
  if (p.material !== undefined || !cutter) {
    if (typeof p.material !== 'string' || !materials.includes(p.material)) fail(where + '.material must name one of the spec materials');
  }
  const smooth = p.smooth === false ? false : num(p.smooth, 0, 180, where + '.smooth', true);
  let scale: unknown;
  if (typeof p.scale === 'number') scale = num(p.scale, .01, 100, where + '.scale');
  else scale = vec(p.scale, 3, .01, 100, where + '.scale', true);
  if (p.parent !== undefined && (typeof p.parent !== 'string' || !ID.test(p.parent))) fail(where + '.parent must be a part id');
  if (p.with !== undefined && (!cutter || !Array.isArray(p.with) || p.with.length < 1 || p.with.length > 16 || p.with.some(i => typeof i !== 'string' || !ID.test(i))))
    fail(where + '.with lists 1..16 part ids and needs csg subtract or intersect');
  let radial: R | undefined, array: R | undefined, scatter: R | undefined;
  if (p.radial !== undefined) {
    const r = fields(p.radial, ['count', 'axis', 'center', 'offset'], where + '.radial');
    radial = out([['count', int(r.count, 2, MODEL_LIMITS.count, where + '.radial.count')], ['axis', pick(r.axis, AXES, where + '.radial.axis', true)],
      ['center', vec(r.center, 3, -c, c, where + '.radial.center', true)], ['offset', num(r.offset, -360, 360, where + '.radial.offset', true)]]);
  }
  if (p.array !== undefined) {
    const a = fields(p.array, ['count', 'step', 'grid', 'path', 'align', 'rotStep'], where + '.array');
    const step = vec(a.step, 3, -c, c, where + '.array.step', true), rotStep = vec(a.rotStep, 3, -360, 360, where + '.array.rotStep', true);
    let grid: number[] | undefined, count: number | undefined, arrPath: R | undefined;
    if (a.grid !== undefined) {
      grid = vec(a.grid, 3, 1, MODEL_LIMITS.count, where + '.array.grid')!;
      if (grid.some(n => !Number.isInteger(n))) fail(where + '.array.grid must be an integer');
      if (grid[0]! * grid[1]! * grid[2]! < 2) fail(where + '.array.grid must make at least two copies');
    } else {
      count = int(a.count, 2, MODEL_LIMITS.count, where + '.array.count');
      if (a.path !== undefined) arrPath = path(a.path, where + '.array.path');
      else if ((step ?? [0, 0, 0]).every(v => v === 0) && (rotStep ?? [0, 0, 0]).every(v => v === 0)) fail(where + '.array needs step, rotStep, grid or path');
    }
    array = out([['count', count], ['step', step], ['grid', grid], ['path', arrPath], ['align', bool(a.align, where + '.array.align')], ['rotStep', rotStep]]);
  }
  if (p.scatter !== undefined) {
    const s = fields(p.scatter, ['on', 'count', 'spacing', 'align', 'minUp', 'scaleRange', 'yaw', 'sink', 'seed'], where + '.scatter');
    if (typeof s.on !== 'string' || !ID.test(s.on)) fail(where + '.scatter.on must name a part');
    const range = vec(s.scaleRange, 2, .05, 10, where + '.scatter.scaleRange', true);
    if (range && range[1]! < range[0]!) fail(where + '.scatter.scaleRange must ascend');
    scatter = out([['on', s.on], ['count', int(s.count, 1, MODEL_LIMITS.scatter, where + '.scatter.count')], ['spacing', num(s.spacing, 0, 20, where + '.scatter.spacing', true)],
      ['align', num(s.align, 0, 1, where + '.scatter.align', true)], ['minUp', num(s.minUp, -1, 1, where + '.scatter.minUp', true)], ['scaleRange', range],
      ['yaw', num(s.yaw, 0, 360, where + '.scatter.yaw', true)], ['sink', num(s.sink, -5, 5, where + '.scatter.sink', true)], ['seed', int(s.seed, 0, 65535, where + '.scatter.seed', true)]]);
  }
  const o: [string, unknown][] = [['id', p.id], ['op', op], ['material', p.material], ['at', vec(p.at, 3, -c, c, where + '.at', true)],
    ['rot', vec(p.rot, 3, -720, 720, where + '.rot', true)], ['scale', scale], ['parent', p.parent]];
  if (op === 'box') {
    const size = vec(p.size, 3, lo, hi, where + '.size')!, bevel = num(p.bevel, 0, 10, where + '.bevel', true);
    if ((bevel ?? 0) * 2 >= Math.min(...size)) fail(where + '.bevel must be less than half the smallest size');
    o.push(['size', size], ['bevel', bevel]);
  } else if (op === 'cylinder') {
    const radius = num(p.radius, lo, hi, where + '.radius')!, height = num(p.height, lo, hi, where + '.height')!;
    const top = num(p.radiusTop, 0, hi, where + '.radiusTop', true), bevel = num(p.bevel, 0, 10, where + '.bevel', true);
    if ((bevel ?? 0) * 2 >= Math.min(height, 2 * Math.min(radius, top || radius))) fail(where + '.bevel is too large for this cylinder');
    o.push(['radius', radius], ['radiusTop', top], ['height', height], ['bevel', bevel]);
  } else if (op === 'sphere') o.push(['radius', num(p.radius, lo, hi, where + '.radius')]);
  else if (op === 'revolve') {
    const prof = points(p.profile, 2, 2, where + '.profile');
    if (prof.some(([r]) => r! < 0)) fail(where + '.profile radii must be >= 0');
    if (prof.every(([r]) => r === 0)) fail(where + '.profile needs a nonzero radius');
    const closed = bool(p.closed, where + '.closed');
    if (closed && (prof.length < 3 || prof.some(([r]) => r! <= 0) || area2(prof) === 0)) fail(where + ' a closed profile needs 3+ points with radius > 0 enclosing an area');
    if (!closed && prof.slice(1, -1).some(([r]) => r! <= 0)) fail(where + '.profile interior radii must be > 0 (only the ends may touch the axis)');
    let flutes: R | undefined;
    if (p.flutes !== undefined) {
      const f = fields(p.flutes, ['count', 'depth', 'width', 'from', 'to'], where + '.flutes');
      flutes = out([['count', int(f.count, 3, 64, where + '.flutes.count')], ['depth', num(f.depth, 0, 1, where + '.flutes.depth')], ['width', num(f.width, .02, 1, where + '.flutes.width', true)],
        ['from', num(f.from, -50, 50, where + '.flutes.from', true)], ['to', num(f.to, -50, 50, where + '.flutes.to', true)]]);
    }
    o.push(['profile', prof], ['curve', pick(p.curve, ['linear', 'smooth'] as const, where + '.curve', true)], ['flutes', flutes], ['closed', closed]);
  } else if (op === 'extrude') {
    const sh = shape(p.shape, where + '.shape'), height = num(p.height, lo, hi, where + '.height')!, bevel = num(p.bevel, 0, 10, where + '.bevel', true) ?? 0;
    let inset: R | undefined;
    if (p.inset !== undefined) {
      const i = fields(p.inset, ['width', 'depth'], where + '.inset');
      inset = out([['width', num(i.width, lo, hi, where + '.inset.width')], ['depth', num(i.depth, -hi, hi, where + '.inset.depth')]]);
    }
    if (bevel * 2 >= height) fail(where + '.bevel must be less than half the height');
    const round = (sh.round as number | undefined) ?? 0;
    if (round > 0 && bevel + ((inset?.width as number | undefined) ?? 0) >= round) fail(where + '.shape.round must exceed bevel + inset width (or be 0)');
    o.push(['shape', sh], ['height', height], ['bevel', p.bevel === undefined ? undefined : bevel], ['inset', inset]);
  } else if (op === 'loft') {
    if (!Array.isArray(p.sections) || p.sections.length < 2 || p.sections.length > MODEL_LIMITS.sections) fail(`${where}.sections needs 2..${MODEL_LIMITS.sections} sections`);
    const secs = p.sections.map((raw, k) => {
      const sw = `${where}.sections[${k}]`, s = fields(raw, ['z', 'shape', 'at', 'scale', 'rot'], sw);
      const sc = typeof s.scale === 'number' ? num(s.scale, 0, 100, sw + '.scale') : vec(s.scale, 2, 0, 100, sw + '.scale', true);
      return out([['z', num(s.z, -c, c, sw + '.z')], ['shape', shape(s.shape, sw + '.shape')], ['at', vec(s.at, 2, -c, c, sw + '.at', true)], ['scale', sc], ['rot', num(s.rot, -720, 720, sw + '.rot', true)]]);
    });
    if (secs.some((s, i) => i > 0 && (s.z as number) <= (secs[i - 1]!.z as number))) fail(where + '.sections z must strictly ascend');
    const zero = (s: R) => s.scale !== undefined && Math.min(...(typeof s.scale === 'number' ? [s.scale] : s.scale as number[])) === 0;
    if (secs.slice(1, -1).some(zero)) fail(where + ' only the first or last section may have scale 0 (a point)');
    o.push(['sections', secs], ['curve', pick(p.curve, ['linear', 'smooth'] as const, where + '.curve', true)]);
  } else if (op === 'sweep') {
    o.push(['path', path(p.path, where + '.path')], ['shape', shape(p.shape, where + '.shape')], ['twist', num(p.twist, -3600, 3600, where + '.twist', true)], ['taper', curveSamples(p.taper, where + '.taper')]);
  } else {
    if (!Array.isArray(p.shapes) || p.shapes.length < 1 || p.shapes.length > MODEL_LIMITS.prims) fail(`${where}.shapes needs 1..${MODEL_LIMITS.prims} primitives`);
    const shapes = p.shapes.map((s, k) => prim(s, `${where}.shapes[${k}]`));
    if ((shapes[0]!.op ?? 'union') !== 'union') fail(where + ' the first sdf primitive must be a union');
    o.push(['shapes', shapes], ['resolution', int(p.resolution, 16, 96, where + '.resolution', true)]);
  }
  o.push(['mirror', pick(p.mirror, MIRRORS, where + '.mirror', true)], ['radial', radial], ['array', array], ['scatter', scatter], ['csg', csg], ['with', p.with],
    ['noise', noise(p.noise, where + '.noise')], ['smooth', smooth], ['detail', num(p.detail, .1, 8, where + '.detail', true)],
    ['grain', pick(p.grain, AXES, where + '.grain', true)], ['segments', int(p.segments, 3, 128, where + '.segments', true)]);
  return out(o);
}

function material(value: unknown, index: number): ModelMaterial {
  const where = `materials[${index}]`, m = fields(value, ['id', 'finish', 'color', 'roughness', 'metallic', 'wear', 'cavity'], where);
  if (typeof m.id !== 'string' || !MATERIAL_ID.test(m.id)) fail(where + '.id must be a lowercase id (a-z, 0-9; up to 16 characters)');
  const finish = pick(m.finish, MODEL_FINISHES, where + '.finish')!, [, rough, metal, wear, cavity, color] = MODEL_FINISH_DEFAULTS[finish];
  return { id: m.id, finish, color: (vec(m.color, 3, 0, 1, where + '.color', true) ?? [...color]) as Vec3, roughness: num(m.roughness, 0, 1, where + '.roughness', true) ?? rough,
    metallic: num(m.metallic, 0, 1, where + '.metallic', true) ?? metal, wear: num(m.wear, 0, 1, where + '.wear', true) ?? wear, cavity: num(m.cavity, 0, 1, where + '.cavity', true) ?? cavity };
}

export function normalizeModelSpec(value: unknown): ModelSpec {
  const s = fields(value, ['kind', 'finish', 'size', 'materials', 'parts', 'pivot', 'smoothAngle'], 'spec');
  if (s.kind !== 'spec') fail('kind must be spec');
  const [lo, hi] = MODEL_LIMITS.size;
  const size = vec(s.size, 3, lo, hi, 'size') as Vec3;
  if (!Array.isArray(s.materials) || s.materials.length < 1 || s.materials.length > MODEL_LIMITS.materials) fail(`materials needs 1..${MODEL_LIMITS.materials} entries`);
  const materials = s.materials.map(material), ids = materials.map(m => m.id);
  if (new Set(ids).size !== ids.length) fail('material ids must be unique');
  if (!Array.isArray(s.parts) || s.parts.length < 1 || s.parts.length > MODEL_LIMITS.parts) fail(`parts needs 1..${MODEL_LIMITS.parts} entries`);
  const parts = s.parts.map((p, i) => part(p, i, ids)), by = new Map<string, R>();
  for (const p of parts) { if (by.has(p.id as string)) fail('part ids must be unique (' + String(p.id) + ')'); by.set(p.id as string, p); }
  const cutter = (p: R) => p.csg === 'subtract' || p.csg === 'intersect';
  for (const p of parts) {
    const refs: [unknown, string][] = [[p.parent, 'parent'], [(p.scatter as R | undefined)?.on, 'scatter.on'], ...((p.with as string[] | undefined) ?? []).map(w => [w, 'with'] as [unknown, string])];
    for (const [ref, label] of refs) {
      if (ref === undefined) continue;
      if (!by.has(ref as string)) fail(`part ${String(p.id)}.${label} names an unknown part`);
      if (ref === p.id) fail(`part ${String(p.id)}.${label} cannot name itself`);
    }
    if (p.scatter && cutter(by.get((p.scatter as R).on as string)!)) fail(`part ${String(p.id)} cannot scatter on a cutter`);
    if (p.scatter && (p.array || p.radial || p.mirror || p.csg)) fail(`part ${String(p.id)} scatter cannot combine with array, radial, mirror or csg`);
  }
  for (const p of parts) {
    const seen = new Set<string>();
    for (let cursor: R | undefined = p; cursor?.parent !== undefined; cursor = by.get(cursor.parent as string)) {
      if (seen.has(cursor.id as string)) fail(`part ${String(p.id)} has a parent cycle`);
      seen.add(cursor.id as string);
    }
  }
  const used = new Set(parts.filter(p => !cutter(p)).map(p => p.material));
  for (const id of ids) if (!used.has(id)) fail(`material ${id} is not used by any solid part`);
  const instances = parts.reduce((sum, p) => sum + (p.scatter ? (p.scatter as R).count as number : copies(p)), 0);
  if (instances > MODEL_LIMITS.instances) fail(`parts expand to more than ${MODEL_LIMITS.instances} instances; reduce arrays/scatter`);
  return out([['kind', 'spec'], ['finish', pick(s.finish, ['natural', 'flat'] as const, 'finish', true) ?? 'natural'], ['size', size], ['materials', materials], ['parts', parts],
    ['pivot', pick(s.pivot, ['base', 'origin'] as const, 'pivot', true)], ['smoothAngle', num(s.smoothAngle, 0, 180, 'smoothAngle', true)]]) as unknown as ModelSpec;
}

/** One render mesh per material: the material ids are the source keys. */
export const modelSourceKeys = (spec: ModelSpec): string[] => spec.materials.map(m => m.id);
export const modelMaterialName = (id: string): string => id.slice(0, 1).toUpperCase() + id.slice(1);
/** Compiler modules (workers/blender/grammar), copied flat into kind "spec" jobs after the shared worker files. */
export const MODEL_WORKER_SCRIPTS: readonly string[] = ['model_spec.py', 'model_geom.py', 'model_sdf.py', 'model_plan.py', 'model_build.py', 'model_surface.py', 'model_review.py'];
