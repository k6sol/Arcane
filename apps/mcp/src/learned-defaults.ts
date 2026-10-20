/**
 * Learned tool defaults for the MCP server: reads the daemon's learned preferences (read-only, short cache, short timeout)
 * and fills arguments a tool call omitted. Explicit arguments always win, learning off or an unreachable daemon means no
 * change, and every applied default is reported back in the result's `learned` notes so the model can see and override it.
 */
import { applyLearnedDefaults, readLearnedBias, type LearnedBias } from '../../../packages/core/src/preference-learning.js';

export interface LearnedBiasSource { learnedBias(options: { timeoutMs?: number }): Promise<unknown> }
const NONE: LearnedBias = Object.freeze({ prefer: {}, avoid: {}, boosts: {} }) as LearnedBias;
export const LEARNED_DEFAULTS_CACHE_MS = 15_000;

export function createLearnedDefaults(source: LearnedBiasSource | null, now: () => number = Date.now) {
  let cached: { at: number; bias: LearnedBias } | null = null, pending: Promise<LearnedBias> | null = null;
  async function bias(): Promise<LearnedBias> {
    if (!source) return NONE;
    if (cached && now() - cached.at < LEARNED_DEFAULTS_CACHE_MS) return cached.bias;
    pending ??= (async () => {
      try {
        const value = await source.learnedBias({ timeoutMs: 1500 }) as { enabled?: unknown };
        const read = value && value.enabled === true ? readLearnedBias(value) : NONE;
        cached = { at: now(), bias: read }; return read;
      } catch { cached = { at: now(), bias: NONE }; return NONE; }
      finally { pending = null; }
    })();
    return pending;
  }
  return {
    bias,
    /** Input with learned defaults filled in, plus the notes to return alongside the tool result. */
    async apply<T>(tool: string, input: T): Promise<{ input: T; learned: string[] }> {
      try { const result = applyLearnedDefaults(tool, input, await bias()); return { input: result.input, learned: result.applied }; }
      catch { return { input, learned: [] }; }
    },
    /** Skill boosts from the last read only (no daemon call): skills_recommend stays a local read. */
    cachedBoosts(): Record<string, number> { return { ...(cached?.bias.boosts ?? {}) }; },
  };
}
export type LearnedDefaults = ReturnType<typeof createLearnedDefaults>;
