import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { LearningStore, type HumanLearningCommand } from '../../../packages/storage/src/learning-store.js';

export type LearningAction = 'consent' | 'propose' | 'review' | 'disable' | 'erase';
export interface LearningServiceOptions { directory: string; projectPath: string }
export class LearningHttpError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** Trusted HTTP boundary. No browser role, proof, or capability can authorize it. */
export function assertLearningHumanRequest(
  request: IncomingMessage, controlToken: string, origin: string, agentToken: string,
): void {
  const singleton = new Set(['host', 'authorization', 'origin', 'sec-fetch-site']);
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase();
    if (singleton.has(name) && seen.has(name)) throw new LearningHttpError('HEADER', 400);
    seen.add(name);
  }
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  // Deny the agent even if a host accidentally supplies equal human/agent tokens.
  if (matches(supplied, agentToken)) throw new LearningHttpError('HUMAN_ONLY', 403);
  if (!matches(supplied, controlToken)) throw new LearningHttpError('AUTH', 401);
  let expected: URL;
  try { expected = new URL(origin); } catch { throw new LearningHttpError('ORIGIN', 403); }
  if (expected.origin !== origin || !['http:', 'https:'].includes(expected.protocol) || request.headers.host !== expected.host) {
    throw new LearningHttpError('HOST', 403);
  }
  if (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new LearningHttpError('FETCH_SITE', 403);
  }
  if (request.method === 'GET') {
    if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new LearningHttpError('ORIGIN', 403);
    if (request.headers['transfer-encoding'] !== undefined ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
      throw new LearningHttpError('GET_BODY', 400);
    }
  } else if (request.headers.origin !== origin) {
    throw new LearningHttpError('ORIGIN', 403);
  }
}

const FIELDS: Record<LearningAction, readonly string[]> = {
  consent: ['requestHash', 'enabled'],
  propose: ['requestHash', 'kind', 'text', 'tags', 'evidence'],
  review: ['requestHash', 'recordId', 'decision', 'verifiedEvidenceHashes'],
  disable: ['requestHash', 'recordId', 'disabled'],
  erase: ['requestHash', 'recordId', 'confirmation'],
};
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArcaneError('LEARNING_INPUT', 'Expected an object.');
  const a = input as Record<string, unknown>;
  if (Object.keys(a).length !== fields.length || fields.some(field => !Object.hasOwn(a, field)) || Object.keys(a).some(field => !fields.includes(field))) {
    throw new ArcaneError('LEARNING_INPUT', 'Unexpected or missing fields.');
  }
  return a;
}
const INPUT_FAILURES = new Set([
  'LEARNING_INPUT', 'LEARNING_SECRET', 'LEARNING_HUMAN_REQUIRED', 'LEARNING_CONSENT',
  'LEARNING_RECORD', 'LEARNING_REVIEW', 'LEARNING_EVIDENCE', 'LEARNING_IDEMPOTENCY', 'LEARNING_CAPACITY',
]);

/** Lazy, project-scoped local storage. The parent owns HTTP dispatch and shutdown. */
export function createLearningService(options: LearningServiceOptions) {
  // Capture trusted host configuration; never consult a browser-selected path.
  const { directory, projectPath } = options;
  let store: LearningStore | undefined;
  let closed = false;
  let permit: { proof: symbol; action: LearningAction; requestHash: string } | undefined;
  function close(): void {
    closed = true; permit = undefined;
    const selected = store; store = undefined;
    selected?.close();
  }
  function opened(): LearningStore {
    if (closed) throw new ArcaneError('LEARNING_CLOSED', 'Learning service is closed.');
    if (!store) {
      store = new LearningStore({ directory, projectPath, authorizeHuman(command: Readonly<HumanLearningCommand>, proof: unknown) {
        return permit !== undefined && proof === permit.proof && command.action === permit.action &&
          command.projectId === store?.projectId && command.requestHash === permit.requestHash;
      } });
    }
    return store;
  }
  function guarded<T>(work: (selected: LearningStore) => T): T {
    try { return work(opened()); }
    catch (error) {
      // Invalid commands are recoverable. Storage/path/schema failures are sticky.
      if (!(error instanceof ArcaneError) || !INPUT_FAILURES.has(error.code)) {
        try { close(); } catch { /* Preserve failure without logging paths or credentials. */ }
      }
      throw error;
    }
  }
  function state() {
    return guarded(selected => ({ settings: selected.settings(selected.projectId), records: selected.listForReview(selected.projectId) }));
  }
  function context(input: unknown) {
    const a = object(input, ['tags', 'maxBytes']);
    return guarded(selected => selected.retrieve({ ...a, projectId: selected.projectId }));
  }
  function mutate(
    action: LearningAction, input: unknown, request: IncomingMessage,
    controlToken: string, origin: string, agentToken: string,
  ) {
    assertLearningHumanRequest(request, controlToken, origin, agentToken);
    if (request.method !== 'POST') throw new LearningHttpError('METHOD', 405);
    if (!Object.hasOwn(FIELDS, action)) throw new ArcaneError('LEARNING_INPUT', 'Unknown learning action.');
    const a = object(input, FIELDS[action]);
    // Inspect decoded values before JSON escaping so unusual bearer characters
    // cannot conceal a credential in submitted text or evidence metadata.
    JSON.stringify(a, (_key, value: unknown) => {
      if (typeof value === 'string' && [controlToken, agentToken].some(secret =>
        secret && (value.includes(secret) || value.normalize('NFKC').includes(secret)))) {
        throw new ArcaneError('LEARNING_SECRET', 'Host credentials cannot be stored as learning content.');
      }
      return value;
    });
    if (typeof a.requestHash !== 'string' || !HASH.test(a.requestHash)) throw new ArcaneError('LEARNING_INPUT', 'Expected a lowercase SHA-256 request identifier.');
    const { requestHash, ...payload } = a;
    return guarded(selected => {
      const command = { ...payload, projectId: selected.projectId, requestId: requestHash };
      // Issued only here, after authenticated same-origin validation. Never returned.
      const proof = Symbol('validated learning human request');
      permit = { proof, action, requestHash: digest(selected.projectId + '\0' + requestHash) };
      try {
        switch (action) {
          case 'consent': return selected.setOptInHuman(command, proof);
          case 'propose': return selected.propose({ ...command, author: 'user' });
          case 'review': return selected.reviewHuman(command, proof);
          case 'disable': return selected.setDisabledHuman(command, proof);
          case 'erase': return selected.eraseHuman(command, proof);
        }
      } finally { permit = undefined; }
    });
  }
  return { state, context, mutate, close };
}
export type LearningService = ReturnType<typeof createLearningService>;
