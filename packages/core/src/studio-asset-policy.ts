import { ArcaneError } from '../../protocol/src/providers.js';
import { instanceRef, object, textField, ASSET_PLACE_LIMITS, type Json, type StudioSession } from '../../protocol/src/studio.js';

/** Wire validation for native asset adoption and scene.build clone items. The plugin
 * (AssetPlacement.luau) re-validates every field and owns the engine-side checks. */
export const ASSET_METHODS = ['scene.asset_watch', 'scene.place_asset', 'scene.apply_material'] as const;
export type AssetMethod = typeof ASSET_METHODS[number];
/** Base materials the built-in material generator accepts (recorded native inventory). */
export const GENERATED_BASE_MATERIALS = ['Plastic', 'SmoothPlastic', 'Wood', 'WoodPlanks', 'Marble', 'Basalt', 'Slate', 'CrackedLava', 'Concrete', 'Limestone',
  'Granite', 'Pavement', 'Brick', 'Pebble', 'Cobblestone', 'Rock', 'Sandstone', 'CorrodedMetal', 'DiamondPlate', 'Foil', 'Metal', 'Grass', 'LeafyGrass', 'Sand',
  'Fabric', 'Snow', 'Mud', 'Ground', 'Asphalt', 'Salt', 'Ice', 'Glacier', 'Cardboard', 'Carpet', 'CeramicTiles', 'ClayRoofTiles', 'RoofShingles', 'Leather',
  'Plaster', 'Rubber'] as const;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const VARIANT = /^[A-Za-z0-9_]{1,100}$/;

function keys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new ArcaneError('INPUT', 'Unexpected command field.');
}
function number(value: unknown, low: number, high: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new ArcaneError('INPUT', `${label} must be ${low}..${high}.`);
  return value;
}
function triple(value: unknown, low: number, high: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 3) throw new ArcaneError('INPUT', `${label} needs three numbers.`);
  return value.map(n => number(n, low, high, label));
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ArcaneError('INPUT', `${label} must be a boolean.`);
  return value;
}
function scopedRef(value: unknown, session: StudioSession) {
  const r = instanceRef(value);
  if (r.sessionId !== session.id || !session.allowedRoots.includes(r.root)) throw new ArcaneError('SCOPE', 'Instance reference is outside this exact paired Studio scope.');
  return r;
}
function capable(session: StudioSession, feature: string): void {
  if (!session.capabilities.includes('scene.place_asset')) throw new ArcaneError('PLUGIN_UPDATE_REQUIRED', `The connected Arcane Studio plugin (${session.pluginVersion}) predates ${feature}. Update the Studio plugin from Arcane, restart Studio and connect again. No command was queued.`);
}
function workspace(session: StudioSession): void {
  if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Native asset insertion lands in Workspace; it requires the Workspace grant.');
}

export function isAssetMethod(method: string): method is AssetMethod { return (ASSET_METHODS as readonly string[]).includes(method); }

export function validateAssetCommand(method: AssetMethod, a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  capable(session, 'native asset placement');
  if (method === 'scene.asset_watch') { keys(a, []); workspace(session); return a; }
  if (method === 'scene.place_asset') {
    keys(a, ['watch', 'expectName', 'parent', 'name', 'maxSize', 'position', 'yaw', 'ground', 'anchor', 'allowScripts']);
    workspace(session);
    if (typeof a.watch !== 'string' || !TOKEN.test(a.watch)) throw new ArcaneError('INPUT', 'Expected the opaque insertion watch token.');
    if (a.expectName !== undefined) textField(a.expectName, 'expected asset name', 100);
    scopedRef(a.parent, session); textField(a.name, 'asset name', 100);
    if (a.maxSize !== undefined) triple(a.maxSize, 0.2, 2048, 'Asset maxSize');
    triple(a.position, -100000, 100000, 'Asset position');
    number(a.yaw, -360, 360, 'Asset yaw');
    boolean(a.ground, 'ground'); boolean(a.anchor, 'anchor'); boolean(a.allowScripts, 'allowScripts');
    return a;
  }
  keys(a, ['refs', 'material', 'variant']);
  if (!Array.isArray(a.refs) || a.refs.length < 1 || a.refs.length > ASSET_PLACE_LIMITS.materialTargets) throw new ArcaneError('INPUT', `Apply a material to 1..${ASSET_PLACE_LIMITS.materialTargets} parts.`);
  const seen = new Set<string>();
  for (const raw of a.refs) {
    const r = scopedRef(raw, session);
    if (seen.has(r.instanceId)) throw new ArcaneError('INPUT', 'Material targets must be distinct.');
    seen.add(r.instanceId);
  }
  if (!(GENERATED_BASE_MATERIALS as readonly string[]).includes(a.material as string)) throw new ArcaneError('PROPERTY', 'Unsupported generated base material.');
  if (typeof a.variant !== 'string' || !VARIANT.test(a.variant)) throw new ArcaneError('INPUT', 'Material variant names are [A-Za-z0-9_]{1,100}.');
  return a;
}

/** scene.build templates: script-free Model/BasePart instances already in scope (typically an
 * adopted asset kept in a hidden template folder). Clone items reference them by 1-based index. */
export function validateBuildTemplates(value: unknown, session: StudioSession): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > ASSET_PLACE_LIMITS.templates) throw new ArcaneError('INPUT', `Use 1..${ASSET_PLACE_LIMITS.templates} clone templates.`);
  capable(session, 'scene_build clone templates');
  const seen = new Set<string>();
  return value.map(raw => {
    const r = scopedRef(raw, session);
    if (seen.has(r.instanceId)) throw new ArcaneError('INPUT', 'Clone templates must be distinct.');
    seen.add(r.instanceId);
    return raw as Json;
  });
}
export function validateBuildClone(item: Record<string, unknown>, templates: number): Json {
  keys(item, ['kind', 'template', 'name', 'parent', 'at', 'yaw', 'scale', 'ground', 'key']);
  if (!Number.isInteger(item.template) || (item.template as number) < 1 || (item.template as number) > templates) throw new ArcaneError('INPUT', 'Clone item names an unknown template index.');
  triple(item.at, -100000, 100000, 'Clone position');
  number(item.yaw, -360, 360, 'Clone yaw');
  number(item.scale, 0.1, 20, 'Clone scale');
  if (item.ground !== undefined) boolean(item.ground, 'Clone ground');
  return item as Json;
}
/** Receipt checks for the adoption methods (the store calls this for succeeded commands). */
export function validateAssetReceipt(method: AssetMethod, args: Record<string, Json>, mutation: Record<string, unknown>): void {
  const after = object(mutation.after, 'asset receipt');
  if (method === 'scene.place_asset') {
    if (mutation.before !== null || !Number.isInteger(after.descendants) || (after.descendants as number) < 1 || (after.descendants as number) > ASSET_PLACE_LIMITS.descendants
      || !Number.isInteger(after.removedScripts) || (after.removedScripts as number) < 0 || (args.allowScripts === false && after.keptScripts !== 0))
      throw new ArcaneError('RECEIPT', 'Asset placement receipt does not match the exact adoption.');
    return;
  }
  const before = object(mutation.before, 'material baseline');
  if (!Array.isArray(before.items) || before.items.length !== (args.refs as Json[]).length || after.variant !== args.variant || after.material !== args.material)
    throw new ArcaneError('RECEIPT', 'Material receipt does not match the exact requested targets.');
}
