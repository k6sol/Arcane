import { CODEX_LIMITS, CodexClientError, type HumanAction, type LimitOptions, type Limits } from './types.js';
export function fail(code: string, message: string): never { throw new CodexClientError(code, message); }
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('ARGUMENTS', 'Expected an object.');
  return value as Record<string, unknown>;
}
export function exact(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).some(key => !allowed.includes(key))) fail('ARGUMENTS', 'Unexpected field.');
  return result;
}
export function str(value: unknown, maxBytes = 256): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || Buffer.byteLength(value) > maxBytes) fail('ARGUMENTS', 'Invalid bounded string.');
  return value;
}
export function optionalText(value: unknown, maxBytes = 4096): string | null {
  return value == null ? null : str(value, maxBytes);
}
export function human(value: HumanAction): void {
  if (exact(value, ['initiatedBy']).initiatedBy !== 'human') fail('HUMAN_REQUIRED', 'An explicit human action is required.');
}
export function limits(options: LimitOptions = {}): Limits {
  const raw = exact(options, Object.keys(CODEX_LIMITS));
  const result: Record<string, number> = { ...CODEX_LIMITS };
  for (const [key, value] of Object.entries(raw)) {
    const maximum = CODEX_LIMITS[key as keyof Limits];
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) fail('ARGUMENTS', 'Limits may only reduce the documented positive bounds.');
    result[key] = value as number;
  }
  return result as Limits;
}
