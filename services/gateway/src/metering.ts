/**
 * Token-to-credit metering. Integer math only (BigInt), always rounded up, so a request never costs less than its
 * provider cost times the markup.
 *
 *   credits = ceil( (inputTokens * inputPerMTok + outputTokens * outputPerMTok) * markupBps / (1,000,000 * 10,000) )
 */
import type { ModelEntry } from './config.ts';

export function creditsFor(model: Pick<ModelEntry, 'inputPerMTok' | 'outputPerMTok'>, inputTokens: number, outputTokens: number, markupBps: number): number {
  for (const value of [inputTokens, outputTokens, markupBps]) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Metering inputs must be non-negative integers.');
  const numerator = (BigInt(inputTokens) * BigInt(model.inputPerMTok) + BigInt(outputTokens) * BigInt(model.outputPerMTok)) * BigInt(markupBps);
  const denominator = 10_000_000_000n;
  return Number((numerator + denominator - 1n) / denominator);
}

/** Conservative upper estimate of prompt tokens before the provider reports the real count (about 2 characters per token). */
export function estimateInputTokens(messages: { content: string }[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 2) + 8, 16);
}

/** Fallback when a stream ends without a usage report (for example, the client disconnected first). */
export const estimateOutputTokens = (text: string) => Math.ceil(text.length / 3);

/** UTC billing period key, e.g. "2026-10". */
export const periodKey = (now = new Date()) => now.toISOString().slice(0, 7);
