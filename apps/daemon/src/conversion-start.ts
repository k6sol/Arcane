import { types } from 'node:util';
import { assetName } from '../../../packages/asset-pipeline/src/paths.js';
import { AssetError } from '../../../packages/asset-pipeline/src/types.js';

/** Public options only. Managed bytes and native authority are supplied by the host. */
export interface ConvertGlbInput {
  readonly parentJobId: string;
  readonly name: string;
  readonly collision: 'none' | 'convex-hull';
  readonly renderResolution: number;
  readonly renderSamples: number;
}

const FIELDS = ['parentJobId', 'name', 'collision', 'renderResolution', 'renderSamples'] as const;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
function refuse(): never {
  throw new AssetError('ASSET_CONVERT_INPUT', 'Choose a managed parent job, safe name, collision mode and bounded preview settings.');
}

/** Copy five own scalar values without invoking caller accessors or coercion. */
export function parseConvertGlbInput(value: unknown): Readonly<ConvertGlbInput> {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) refuse();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) refuse();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== FIELDS.length || keys.some(key => typeof key !== 'string' || !FIELDS.some(field => field === key))) refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of FIELDS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) refuse();
      data[key] = descriptor.value as unknown;
    }
    if (typeof data.parentJobId !== 'string' || !UUID.test(data.parentJobId) ||
        typeof data.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}(?![\s\S])/.test(data.name) ||
        (data.collision !== 'none' && data.collision !== 'convex-hull') ||
        typeof data.renderResolution !== 'number' || !Number.isSafeInteger(data.renderResolution) || data.renderResolution < 128 || data.renderResolution > 1024 ||
        typeof data.renderSamples !== 'number' || !Number.isSafeInteger(data.renderSamples) || data.renderSamples < 1 || data.renderSamples > 64) refuse();
    const result: ConvertGlbInput = {
      parentJobId: data.parentJobId, name: assetName(data.name), collision: data.collision,
      renderResolution: data.renderResolution, renderSamples: data.renderSamples,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 1024) refuse();
    return Object.freeze(result);
  } catch { refuse(); }
}
