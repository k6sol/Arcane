/**
 * terrain_generate `caves`: a compact, seeded cave plan compiled locally into the explicit wire form the plugin carves
 * (terrain.caves): chains of overlapping, jittered subtractive spheres [x, y above floor, z, r]. Entrance tunnels start on
 * the flank of a rock outcrop (a mountain feature added here) so their mouths open in the hillside, wind inwards and
 * descend into chambers (a main sphere plus flat-floored satellites, floor material Slate); chambers link to each other.
 * Every node stays clear of keep-out circles and of every flatten/plateau pad (spawn clearings), and the plugin refuses to
 * carve keep-out columns itself. The report lists mouths and chambers in world space plus a ready scene_build fixture set
 * (hanging stalactites and dim PointLights), all deterministic by seed.
 */
import type { Json } from '../../../packages/protocol/src/studio.js';
import { TERRAIN_LIMITS as L } from '../../../packages/protocol/src/studio.js';
import { BridgeError } from './daemon-client.js';
import { mulberry32 } from './scene-kits.js';

export interface CaveInput { at: [number, number]; radius: number; rise: number; entrances: number; chambers: number; tunnel: number; floor: string;
  avoid?: [number, number, number][] | undefined }
type Node = [number, number, number, number];
type Feature = Record<string, Json> & { kind: string; center?: [number, number]; radius?: number; height?: number; blend?: number };
export interface CaveReport { nodes: number; dropped: number; mouths: number[][]; chambers: number[][];
  /** scene_build arguments (merge with sessionId + parent): stalactites and dim cave lights. */
  fixtures: { name: string; prototypes: Record<string, Json>; items: Json[] } }

const r2 = (value: number) => Number(value.toFixed(2));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const smooth = (t: number) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };

/** Ground lift above baseHeight from hill/mountain features at [x,z]; `safe` uses the plugin's lowest profile (noise-scaled
 * radius, roughness floor), otherwise a typical value. */
function lift(features: Feature[], x: number, z: number, safe: boolean): number {
  let sum = 0;
  for (const f of features) {
    if ((f.kind !== 'hill' && f.kind !== 'mountain') || !f.center) continue;
    const d = Math.hypot(x - f.center[0], z - f.center[1]), t = d / (f.radius! * (safe ? 0.9 : 1));
    if (t >= 1) continue;
    const roughness = typeof f.roughness === 'number' ? f.roughness : f.kind === 'mountain' ? 0.4 : 0;
    sum += f.kind === 'hill' ? f.height! * (1 - t * t) ** 2 : f.height! * (1 - t) ** 1.6 * (safe ? 1 - roughness * 0.5 : 1 - roughness * 0.2);
  }
  return sum;
}

/** Expands `caves` into wire nodes, the outcrop feature and the fixture report. `args` is the compiled wire input. */
export function planCaves(input: CaveInput, args: Record<string, Json> & { features?: Feature[] }): { caves: Record<string, Json>; outcrop: Feature | null; report: CaveReport } {
  const base = args.baseHeight as number, height = Math.round((args.height as number) / L.voxel) * L.voxel;
  const floorY = Math.round(((args.floor as number | undefined) ?? 0) / L.voxel) * L.voxel;
  const noise = args.noise as { amplitude?: number } | undefined, slack = noise ? (noise.amplitude ?? 24) * 0.6 : 0;
  const random = mulberry32(((args.seed as number) * 7919 + 4099) % 2 ** 31);
  const [ax, az] = input.at, R = input.radius, rt = input.tunnel;
  const outcrop: Feature | null = input.rise > 0 ? { kind: 'mountain', center: [ax, az], radius: R, height: input.rise, roughness: 0.5 } : null;
  const features = [...(outcrop ? [outcrop] : []), ...(args.features ?? [])];
  // Keep-outs: explicit circles plus every pad (the spawn clearing, its ground rings, any flattened landmark site).
  if (input.avoid?.some(circle => !(circle[2] >= 1 && circle[2] <= L.extent))) throw new BridgeError('INPUT', `caves.avoid radius must be 1..${L.extent}.`);
  const avoid: [number, number, number][] = [...(input.avoid ?? [])];
  for (const f of features) if ((f.kind === 'flatten' || f.kind === 'plateau') && f.center) avoid.push([f.center[0], f.center[1], r2(f.radius! + Math.min(f.blend ?? 0, 16) * 0.5 + 2)]);
  // Concentric ground rings of one pad collapse into its outermost circle.
  for (let i = avoid.length - 1; i >= 0; i--) {
    const [x, z, r] = avoid[i]!;
    if (avoid.some((o, j) => j !== i && Math.hypot(o[0] - x, o[1] - z) + r <= o[2] && (o[2] > r || j < i))) avoid.splice(i, 1);
  }
  if (avoid.some(([x, z, r]) => Math.hypot(ax - x, az - z) < r + rt)) throw new BridgeError('INPUT', 'caves.at is inside a keep-out circle or pad (spawn clearing); move the outcrop away from it.');
  const surface = (x: number, z: number) => base + lift(features, x, z, true) - slack; // conservative ground height above floor
  const typical = (x: number, z: number) => base + lift(features, x, z, false);
  const mouthFloor = Math.max(L.voxel * 2, base - 1), chamberFloor = Math.max(L.voxel * 2, base - 10);
  const nodes: Node[] = [];
  const add = (x: number, y: number, z: number, r: number) => { nodes.push([r2(x), r2(clamp(y, r * 0.5, height - 2)), r2(z), r2(clamp(r, 2, L.caveRadius))]); };
  // Chambers: a main sphere whose roof keeps >= 5 studs of cover, plus 3-4 satellites sharing its floor level.
  const chambers: { x: number; z: number; r: number; floor: number; main: number }[] = [];
  const phase = random() * Math.PI * 2;
  for (let c = 0; c < input.chambers; c++) {
    const angle = phase + c * Math.PI * 2 / input.chambers + (random() - 0.5) * 0.6;
    let d = R * (0.08 + 0.2 * random()), x = 0, z = 0, r = 0;
    for (let attempt = 0; attempt < 2 && r < 6; attempt++, d *= 0.5) {
      x = ax + d * Math.cos(angle); z = az + d * Math.sin(angle);
      r = Math.min(16, (surface(x, z) - 5 - chamberFloor) / 2);
    }
    if (r < 6) continue;
    const main = nodes.length;
    add(x, chamberFloor + r * 0.9, z, r);
    const satellites = 3 + Math.floor(random() * 2);
    for (let s = 0; s < satellites; s++) {
      const a = random() * Math.PI * 2, o = r * (0.5 + 0.4 * random()), sx = x + o * Math.cos(a), sz = z + o * Math.sin(a);
      const rs = Math.min(r * (0.5 + 0.25 * random()), (surface(sx, sz) - 4 - chamberFloor) / 1.9);
      if (rs >= 4) add(sx, chamberFloor + rs * 0.9, sz, rs);
    }
    chambers.push({ x, z, r, floor: chamberFloor, main });
  }
  /** A winding chain of overlapping spheres from p0 to p1 (x, z, floor), roofed under the conservative surface past the mouth. */
  const chain = (p0: number[], p1: number[], r: number, open: boolean) => {
    const dx = p1[0]! - p0[0]!, dz = p1[1]! - p0[1]!, length = Math.hypot(dx, dz), steps = Math.max(2, Math.ceil(length / (r * 0.75)));
    const px = -dz / length, pz = dx / length, amp = Math.min(length * 0.15, 18) * (0.6 + 0.4 * random()), waves = 1 + Math.floor(random() * 2), shift = random() * Math.PI * 2;
    const first = nodes.length;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, envelope = Math.sin(Math.PI * u), offset = amp * envelope * Math.sin(waves * Math.PI * u + shift) + (random() - 0.5) * r * 0.4 * envelope;
      const x = p0[0]! + dx * u + px * offset, z = p0[1]! + dz * u + pz * offset, floor = p0[2]! + (p1[2]! - p0[2]!) * smooth(u) + (random() - 0.5) * 0.6;
      let ri = r * (0.85 + 0.3 * random());
      if (!open || u > 0.3) { const room = surface(x, z) - 3 - floor; if (ri * 1.85 > room) ri = Math.max(3.5, room / 1.85); }
      add(x, floor + ri * 0.85, z, ri);
    }
    return first;
  };
  const mouths: number[][] = [];
  const turn = random() * Math.PI * 2;
  for (let e = 0; e < input.entrances; e++) {
    const angle = turn + e * Math.PI * 2 / input.entrances + (random() - 0.5) * 0.7;
    const start = [ax + R * 0.78 * Math.cos(angle), az + R * 0.78 * Math.sin(angle), mouthFloor];
    const target = chambers.length ? chambers.reduce((best, c) => Math.hypot(c.x - start[0]!, c.z - start[1]!) < Math.hypot(best.x - start[0]!, best.z - start[1]!) ? c : best)
      : { x: ax + R * 0.12 * Math.cos(angle + 2), z: az + R * 0.12 * Math.sin(angle + 2), floor: chamberFloor, r: rt };
    const first = chain(start, [target.x, target.z, target.floor], rt, true);
    // The mouth: the first node whose top a typical hillside covers.
    const mouth = nodes.slice(first).find(n => typical(n[0], n[2]) >= n[1] + n[3] + 1) ?? nodes[first]!;
    mouths.push([mouth[0], r2(floorY + mouth[1] - mouth[3] * 0.85), mouth[2]]);
  }
  for (let c = 1; c < chambers.length; c++) {
    const a = chambers[c - 1]!, b = chambers[c]!;
    chain([a.x, a.z, a.floor], [b.x, b.z, b.floor], Math.max(4, rt * 0.8), false);
  }
  const kept = nodes.filter(n => !avoid.some(([x, z, r]) => Math.hypot(n[0] - x, n[2] - z) < r + n[3]));
  if (!kept.length) throw new BridgeError('INPUT', 'Every cave node falls inside a keep-out circle or pad; move caves.at or shrink its radius.');
  if (kept.length > L.caveNodes) throw new BridgeError('BODY_LIMIT', `The cave plan needs ${kept.length} nodes (max ${L.caveNodes}); lower entrances/chambers or raise tunnel.`);
  if (avoid.length > L.caveAvoid) throw new BridgeError('INPUT', `Caves allow at most ${L.caveAvoid} keep-out circles and pads together.`);
  const caves: Record<string, Json> = { nodes: kept, floor: input.floor, wall: 'Rock', ...(avoid.length ? { avoid } : {}) };
  const keptChambers = chambers.filter(c => kept.includes(nodes[c.main]!));
  return { caves, outcrop, report: { nodes: kept.length, dropped: nodes.length - kept.length, mouths,
    chambers: keptChambers.map(c => [r2(c.x), r2(floorY + c.floor), r2(c.z), r2(c.r)]), fixtures: fixtures(kept, keptChambers.map(c => nodes[c.main]!), mouths, floorY, random) } };
}

/** Hanging stalactites under each chamber roof (only where that sphere is the roof) and one dim PointLight per chamber and
 * entrance; a scene_build call places them. Positions are world space. */
function fixtures(nodes: Node[], mains: Node[], mouths: number[][], floorY: number, random: () => number): CaveReport['fixtures'] {
  const stone = (name: string, y: number, length: number, d: number) => ({ name, props: { Shape: 'Cylinder', Size: [length, d, d], Position: [0, y, 0], Orientation: [0, 0, 90],
    Material: 'Slate', Color: '#77726a' } }) as unknown as Json;
  const prototypes: Record<string, Json> = { stalactite: { parts: [stone('Root', -1, 2.4, 1.2), stone('Body', -2.7, 1.9, 0.75), stone('Tip', -3.9, 1.1, 0.38)] } };
  const items: Json[] = [];
  const hidden = { Size: [1, 1, 1], Transparency: 1, CanCollide: false, CastShadow: false };
  mains.forEach((node, c) => {
    const [x, y, z, r] = node;
    for (let s = 0, placed = 0; s < 10 && placed < 5; s++) {
      const a = random() * Math.PI * 2, d = r * 0.6 * Math.sqrt(random()), sx = x + d * Math.cos(a), sz = z + d * Math.sin(a), roof = y + Math.sqrt(r * r - d * d);
      if (nodes.some(n => n !== node && Math.hypot(sx - n[0], roof + 1 - n[1], sz - n[2]) < n[3])) continue; // another sphere is the roof here
      items.push({ name: 'Stalactite', use: 'stalactite', at: [r2(sx), r2(floorY + roof + 1.5), r2(sz)], yaw: Math.round(random() * 360 - 180), scale: r2(0.6 + random() * 0.8) });
      placed++;
    }
    items.push({ key: 'chamber' + (c + 1), name: 'ChamberLight' + (c + 1), props: { ...hidden, Position: [x, r2(floorY + y), z] } },
      { name: 'Glow', className: 'PointLight', in: 'chamber' + (c + 1), fx: { Brightness: 0.35, Range: r2(clamp(r * 1.6, 12, 30)), Color: '#ffc68a', Shadows: true } });
  });
  mouths.forEach((m, e) => items.push({ key: 'mouth' + (e + 1), name: 'MouthLight' + (e + 1), props: { ...hidden, Position: [m[0]!, r2(m[1]! + 4), m[2]!] } },
    { name: 'Spill', className: 'PointLight', in: 'mouth' + (e + 1), fx: { Brightness: 0.2, Range: 16, Color: '#a9c4e0', Shadows: false } }));
  return { name: 'CaveFixtures', prototypes, items };
}
