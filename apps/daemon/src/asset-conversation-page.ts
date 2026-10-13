import { types } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import type { NativeConversation } from '../../../packages/storage/src/conversation-work-store.js';
import type { AssetConversationHost, AssetConversationListing } from './asset-conversation-host.js';
import { HISTORY_PAGE_BYTES, type AssetJobRecord, type AssetService } from './asset-service.js';

export interface AssetConversationJobPage {
  projectId: string;
  projectPath: string;
  conversation: NativeConversation;
  jobs: AssetJobRecord[];
  nextCursor: string | null;
  byteLimit: number;
}

// Existing storage cursor: 64 hex scope characters, colon, 1..16 sequence digits.
// Only the trusted host supplies a cursor. Never construct one from a binding ID.
const CURSOR = /^[a-f0-9]{64}:[1-9][0-9]{0,15}(?![\s\S])/;
const MAX_CURSOR_JSON_BYTES = 64 + 1 + 16 + 2;
const MIN_CURSOR_JSON_BYTES = 64 + 1 + 1 + 2;
function stale(): never {
  throw new ArcaneError('ASSET_CONVERSATION_STALE', 'The captured asset conversation page could not be verified.');
}
function historyLimit(): never {
  throw new ArcaneError('HISTORY_LIMIT', 'Asset conversation history exceeds its byte bound; inspect retained job evidence.');
}
function sameNative(a: NativeConversation, b: NativeConversation): boolean {
  return a.provider === b.provider && a.threadId === b.threadId && a.sessionId === b.sessionId;
}
function native(value: NativeConversation): NativeConversation {
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
      (value.provider !== 'codex' && value.provider !== 'claude-code') ||
      typeof value.threadId !== 'string' || (value.sessionId !== null && typeof value.sessionId !== 'string')) stale();
  return { provider: value.provider, threadId: value.threadId, sessionId: value.sessionId };
}
function snapshot(value: AssetConversationListing, limit: number): AssetConversationListing {
  if (!value || typeof value !== 'object' || types.isProxy(value) ||
      typeof value.projectId !== 'string' || typeof value.projectPath !== 'string' ||
      !Array.isArray(value.items) || value.items.length > limit ||
      (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !CURSOR.test(value.nextCursor))) ||
      (value.items.length < limit && value.nextCursor !== null)) stale();
  const conversation = native(value.conversation), ids = new Set<string>();
  // Detach metadata before service hydration or a second host call can mutate it.
  const items = Array.from(value.items, binding => {
    if (!binding || binding.kind !== 'asset-job' || binding.projectId !== value.projectId ||
        typeof binding.id !== 'string' || binding.id.length < 1 || binding.id.length > 64 ||
        /[^A-Za-z0-9_-]/.test(binding.id) || ids.has(binding.id)) stale();
    const recorded = native(binding.conversation);
    if (!sameNative(recorded, conversation)) stale();
    ids.add(binding.id);
    return { projectId: binding.projectId, kind: binding.kind, id: binding.id, conversation: recorded };
  });
  return { projectId: value.projectId, projectPath: value.projectPath, conversation, items, nextCursor: value.nextCursor };
}

/** Authenticated host read seam only. The parent attests the borrowed service's
 * project and authorizes human access. No binding, work start, live-context lookup,
 * storage open or provider read occurs here. Limit counts bindings, including orphans.
 * At most one regular host page and one exact prefix verification are requested. */
export function assetConversationJobPage(
  service: AssetService,
  host: AssetConversationHost,
  options: { limit: number; after: string | null },
): AssetConversationJobPage {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options) as object | null)) {
    throw new ArcaneError('INPUT', 'History limit must be 1..64 with a storage cursor or null.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options), keys = Reflect.ownKeys(options);
  if (keys.length !== 2 || keys.some(key => key !== 'limit' && key !== 'after') ||
      !descriptors.limit?.enumerable || !Object.hasOwn(descriptors.limit, 'value') ||
      !descriptors.after?.enumerable || !Object.hasOwn(descriptors.after, 'value')) {
    throw new ArcaneError('INPUT', 'Use own limit and after data fields.');
  }
  const limit = descriptors.limit.value as number, after = descriptors.after.value as string | null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || (after !== null && typeof after !== 'string')) {
    throw new ArcaneError('INPUT', 'History limit must be 1..64 with a storage cursor or null.');
  }
  const pagination = (count: number) => ({ limit: count, ...(after === null ? {} : { after }) });
  const first = snapshot(host.listHuman(pagination(limit)), limit);
  if (first.nextCursor !== null && first.nextCursor === after) stale();
  const result: AssetConversationJobPage = {
    projectId: first.projectId, projectPath: first.projectPath, conversation: { ...first.conversation },
    jobs: [], nextCursor: first.nextCursor, byteLimit: HISTORY_PAGE_BYTES,
  };
  const known = new Map(service.jobs().map(job => [job.jobId, job]));
  const hydrated = first.items.map(binding => known.get(binding.id));
  // Serialize matching jobs once. Foreign records are never serialized or returned.
  const sizes = hydrated.map(job => job ? Buffer.byteLength(JSON.stringify(job)) : 0);
  const all = hydrated.filter((job): job is AssetJobRecord => job !== undefined);
  const contents = sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, all.length - 1);
  const wrapperBytes = Buffer.byteLength(JSON.stringify(result));
  if (wrapperBytes + contents <= HISTORY_PAGE_BYTES) {
    result.jobs = all;
    return result; // Preserve the exact full-page cursor, including terminal null.
  }

  // A cut requires an interior storage cursor that the first page does not expose.
  // Reserve its bounded JSON size so no third read is needed after verification.
  const nullWrapperBytes = wrapperBytes - (first.nextCursor === null ? 0 : Buffer.byteLength(JSON.stringify(first.nextCursor)) - 4);
  const cursorBytes = first.nextCursor === null ? MAX_CURSOR_JSON_BYTES : Buffer.byteLength(JSON.stringify(first.nextCursor));
  let consumed = 0, jobBytes = 0;
  for (let i = 0; i < hydrated.length; i++) {
    const job = hydrated[i];
    if (job) {
      const candidate = jobBytes + sizes[i]! + (result.jobs.length ? 1 : 0);
      if (nullWrapperBytes + cursorBytes - 4 + candidate > HISTORY_PAGE_BYTES) {
        if (!result.jobs.length) {
          if (nullWrapperBytes + MIN_CURSOR_JSON_BYTES - 4 + candidate > HISTORY_PAGE_BYTES) historyLimit();
          // A first record within the cursor-size uncertainty may still fit exactly.
          // Verify exactly that record once, rather than reject it
          // solely because of reserved cursor bytes. No further record can be tried.
          result.jobs.push(job);
          consumed = i + 1;
          // Do not consume following orphans here: their larger sequence cursor
          // may make this otherwise fitting record exceed the exact byte cap.
        }
        break;
      }
      result.jobs.push(job); jobBytes = candidate;
    }
    consumed = i + 1;
  }
  if (consumed < 1 || consumed >= first.items.length) historyLimit();

  let prefix: AssetConversationListing;
  try { prefix = snapshot(host.listHuman(pagination(consumed)), consumed); }
  catch { stale(); } // No verified cursor exists if the second observation fails.
  if (prefix.projectId !== first.projectId || prefix.projectPath !== first.projectPath ||
      !sameNative(prefix.conversation, first.conversation) || prefix.items.length !== consumed ||
      prefix.nextCursor === null || prefix.nextCursor === after ||
      prefix.items.some((binding, i) => {
        const captured = first.items[i]!;
        return binding.id !== captured.id || binding.projectId !== captured.projectId || binding.kind !== captured.kind ||
          !sameNative(binding.conversation, captured.conversation);
      })) stale();
  result.nextCursor = prefix.nextCursor;
  if (Buffer.byteLength(JSON.stringify(result)) > HISTORY_PAGE_BYTES) historyLimit();
  return result;
}
