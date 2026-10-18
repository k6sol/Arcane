/** In-process per-key rate limiting (sliding one-minute window) and concurrency caps. Single-instance reference. */

export class RateLimiter {
  readonly perMinute: number;
  private hits = new Map<string, number[]>();
  constructor(perMinute: number) { this.perMinute = perMinute; }
  /** Records one hit; false when the key is over its limit for the last 60 seconds. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= this.perMinute) { this.hits.set(key, recent); return false; }
    recent.push(now); this.hits.set(key, recent);
    if (this.hits.size > 50_000) for (const [entry, times] of this.hits) if (!times.some(at => now - at < 60_000)) this.hits.delete(entry);
    return true;
  }
}

export class ConcurrencyCap {
  readonly max: number;
  private active = new Map<string, number>();
  constructor(max: number) { this.max = max; }
  /** Returns a release function, or null when the key already has `max` active requests. */
  acquire(key: string): (() => void) | null {
    const current = this.active.get(key) ?? 0;
    if (current >= this.max) return null;
    this.active.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key); else this.active.set(key, left);
    };
  }
  count(key: string): number { return this.active.get(key) ?? 0; }
}
