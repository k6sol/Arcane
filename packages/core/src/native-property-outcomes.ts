import { types } from 'node:util';
import type { Json } from '../../protocol/src/studio.js';
import { BASE_PART_CLASSES, MATERIALS, MAX_PROPERTIES, PART_SHAPE_CLASSES, SHAPES } from './studio-policy.js';

type Triple = [number, number, number];
const ROTATION_TOLERANCE = 1e-6;

// Read only plain, own, enumerable data fields. Do not run getters, toJSON,
// coercions or proxy traps while checking an untrusted native observation.
function fields(value: unknown, maximum: number): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return;
    result[key] = descriptor.value;
  }
  return result;
}

function boundedNumber(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
}

function triple(value: unknown, tag: string, low: number, high: number): Triple | undefined {
  const tagged = fields(value, 2);
  if (!tagged || Object.keys(tagged).length !== 2 || tagged.type !== tag) return;
  const components = tagged.value;
  if (components === null || typeof components !== 'object' || types.isProxy(components)
    || !Array.isArray(components) || Object.getPrototypeOf(components) !== Array.prototype) return;
  const keys = Reflect.ownKeys(components);
  if (keys.length !== 4 || keys.some(key => !['0', '1', '2', 'length'].includes(key as string))
    || Object.getOwnPropertyDescriptor(components, 'length')?.value !== 3) return;
  const result: number[] = [];
  for (let index = 0; index < 3; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(components, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || !boundedNumber(descriptor.value, low, high)) return;
    result.push(descriptor.value);
  }
  return result as Triple;
}

// CFrame.fromOrientation uses YXZ: Ry(y) * Rx(x) * Rz(z).
function rotation([x, y, z]: Triple): number[] {
  const radians = Math.PI / 180;
  const sx = Math.sin(x * radians), cx = Math.cos(x * radians);
  const sy = Math.sin(y * radians), cy = Math.cos(y * radians);
  const sz = Math.sin(z * radians), cz = Math.cos(z * radians);
  return [
    cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx,
  ];
}

function propertyMatches(key: string, requested: unknown, observed: unknown, className: string): boolean {
  if (key === 'Name') {
    return typeof requested === 'string' && requested.length >= 1 && requested.length <= 100
      && !requested.includes('\0') && observed === requested;
  }
  if (!(BASE_PART_CLASSES as readonly string[]).includes(className)) return false;
  if (key === 'Shape') {
    return (PART_SHAPE_CLASSES as readonly string[]).includes(className)
      && typeof requested === 'string' && (SHAPES as readonly string[]).includes(requested) && observed === requested;
  }
  if (key === 'Material') {
    return typeof requested === 'string' && (MATERIALS as readonly string[]).includes(requested) && observed === requested;
  }
  if (key === 'Anchored' || key === 'CanCollide' || key === 'CastShadow') {
    return typeof requested === 'boolean' && observed === requested;
  }
  if (key === 'Transparency' || key === 'Reflectance') {
    return boundedNumber(requested, 0, 1) && boundedNumber(observed, 0, 1) && observed === Math.fround(requested);
  }
  if (!['Size', 'Position', 'Orientation', 'Color'].includes(key)) return false;
  const low = key === 'Color' ? 0 : key === 'Size' ? 0.05 : key === 'Orientation' ? -360 : -100000;
  const high = key === 'Color' ? 1 : key === 'Size' ? 2048 : key === 'Orientation' ? 360 : 100000;
  const tag = key === 'Color' ? 'Color3' : 'Vector3';
  const desired = triple(requested, tag, low, high), actual = triple(observed, tag, low, high);
  if (!desired || !actual || actual.some(value => value !== Math.fround(value))) return false;
  const native = desired.map(Math.fround) as Triple;
  if (key === 'Color') {
    return actual.every((value, index) => value === Math.fround(Math.trunc(Math.fround(native[index]! * 255)) / 255));
  }
  if (key === 'Orientation') {
    const expectedRotation = rotation(native), actualRotation = rotation(actual);
    return actualRotation.every((value, index) => Math.abs(value - expectedRotation[index]!) <= ROTATION_TOLERANCE);
  }
  return actual.every((value, index) => value === native[index]);
}

/** Post-assignment outcomes only; expected-baseline comparison must stay strict. */
export function nativePropertiesMatch(requested: Record<string, Json>, observed: unknown, className: string): boolean {
  if (typeof className !== 'string') return false;
  const desired = fields(requested, MAX_PROPERTIES), actual = fields(observed, MAX_PROPERTIES);
  if (!desired || !actual) return false;
  const keys = Object.keys(desired);
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key)
    && propertyMatches(key, desired[key], actual[key], className));
}
