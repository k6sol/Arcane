/** Display metadata only. Percentages and reset times never authorize inference. */
export interface NativeRateLimitWindow {
  usedPercent: number; windowDurationMins: number | null; resetsAt: number | null;
}
export type NativeLimitReason = 'rate_limit_reached' | 'workspace_owner_credits_depleted' |
  'workspace_member_credits_depleted' | 'workspace_owner_usage_limit_reached' | 'workspace_member_usage_limit_reached';
export interface NativeRateLimitBucket {
  limitId: string | null; limitName: string | null; normalModelSlug: string | null;
  primary: NativeRateLimitWindow | null; secondary: NativeRateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean } | null;
  spendControlReached: boolean | null; rateLimitReachedType: NativeLimitReason | null;
}
export interface NativeRateLimits {
  source: 'account/rateLimits/read' | 'account/rateLimits/updated'; observedAt: number;
  ordinaryUsageAllowed: boolean | null; buckets: NativeRateLimitBucket[];
}
const REASONS: readonly string[] = ['rate_limit_reached', 'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'];
const MAX_BUCKETS = 16, MAX_TIMESTAMP = 253_402_300_799;
function data(value: unknown, bound = 32): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= bound && keys.every(key => typeof key === 'string' &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
function number(value: unknown, max: number, integral = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max && (!integral || Number.isSafeInteger(value));
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
const nullableLabel = (value: unknown) => value === undefined || value === null || label(value);
function window(value: unknown): NativeRateLimitWindow | null | false {
  if (value === undefined || value === null) return null;
  if (!data(value) || !number(value.usedPercent, 1_000_000) ||
      !(value.windowDurationMins === null || number(value.windowDurationMins, 5_256_000, true) && value.windowDurationMins > 0) ||
      !(value.resetsAt === null || number(value.resetsAt, MAX_TIMESTAMP, true))) return false;
  return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins as number | null, resetsAt: value.resetsAt as number | null };
}
function bucket(value: unknown): NativeRateLimitBucket | null {
  if (!data(value) || !['limitId','limitName','normalModelSlug'].every(key => nullableLabel(value[key])) ||
      !(value.spendControlReached === undefined || value.spendControlReached === null || typeof value.spendControlReached === 'boolean') ||
      !(value.rateLimitReachedType === undefined || value.rateLimitReachedType === null || REASONS.includes(value.rateLimitReachedType as string))) return null;
  const primary = window(value.primary), secondary = window(value.secondary);
  if (primary === false || secondary === false) return null;
  let credits: NativeRateLimitBucket['credits'] = null;
  if (value.credits !== undefined && value.credits !== null) {
    if (!data(value.credits) || typeof value.credits.hasCredits !== 'boolean' || typeof value.credits.unlimited !== 'boolean') return null;
    credits = { hasCredits: value.credits.hasCredits, unlimited: value.credits.unlimited };
  }
  return { limitId: value.limitId as string | null ?? null, limitName: value.limitName as string | null ?? null,
    normalModelSlug: value.normalModelSlug as string | null ?? null, primary, secondary, credits,
    spendControlReached: value.spendControlReached as boolean | null ?? null,
    rateLimitReachedType: value.rateLimitReachedType as NativeLimitReason | null ?? null };
}
/** Whitelist a full response; account IDs, balances, banners and reset handles stay private. */
export function parseNativeRateLimits(value: unknown, observedAt: number): NativeRateLimits | null {
  if (!data(value) || !number(observedAt, MAX_TIMESTAMP * 1000, true) ||
      !(value.ordinaryUsageAllowed === undefined || value.ordinaryUsageAllowed === null || typeof value.ordinaryUsageAllowed === 'boolean')) return null;
  const fallback = bucket(value.rateLimits);
  if (!fallback) return null;
  let buckets: NativeRateLimitBucket[] = [fallback];
  if (value.rateLimitsByLimitId !== undefined && value.rateLimitsByLimitId !== null) {
    if (!data(value.rateLimitsByLimitId, MAX_BUCKETS) || !Object.keys(value.rateLimitsByLimitId).length) return null;
    buckets = [];
    for (const [key, raw] of Object.entries(value.rateLimitsByLimitId)) {
      const parsed = bucket(raw);
      if (!label(key) || !parsed || parsed.limitId !== key) return null;
      buckets.push(parsed);
    }
    // The historical view must not contradict its corresponding metered bucket.
    const same = buckets.find(row => row.limitId === fallback.limitId);
    if (same && JSON.stringify(same) !== JSON.stringify(fallback)) return null;
  }
  return { source: 'account/rateLimits/read', observedAt, ordinaryUsageAllowed: value.ordinaryUsageAllowed as boolean | null ?? null, buckets };
}
/** Sparse updates cannot announce account recovery. A full read replaces the snapshot. */
export function mergeNativeRateLimitUpdate(previous: NativeRateLimits | undefined, value: unknown, observedAt: number): NativeRateLimits | null {
  if (!data(value) || !number(observedAt, MAX_TIMESTAMP * 1000, true)) return null;
  const next = bucket(value.rateLimits);
  if (!next) return null;
  const buckets = structuredClone(previous?.buckets ?? []), index = buckets.findIndex(row => row.limitId === next.limitId), old = buckets[index];
  if (index < 0 && buckets.length === MAX_BUCKETS) return null;
  if (old) {
    next.limitName ??= old.limitName; next.normalModelSlug ??= old.normalModelSlug;
    next.primary ??= old.primary; next.secondary ??= old.secondary; next.credits ??= old.credits;
    next.rateLimitReachedType ??= old.rateLimitReachedType;
    // The backend explicitly defines null spendControlReached as unavailable.
  }
  if (index < 0) buckets.push(next); else buckets[index] = next;
  return { source: 'account/rateLimits/updated', observedAt, ordinaryUsageAllowed: previous?.ordinaryUsageAllowed === false ? false : null, buckets };
}
