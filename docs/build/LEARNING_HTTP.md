# Local reviewed project memory HTTP contract

`apps/daemon/src/learning-service.ts` adapts the existing `LearningStore` to a human settings/review controller. `learning-routes.ts` supplies the HTTP handler. These modules have no Studio, provider, inference, native-history, MCP, upload, or weight-training integration. They inspect project directory metadata and the local learning SQLite database only; evidence references never cause file reads, including auth/config/upload contents.

## Parent integration

```ts
import { createLearningService, type LearningService } from './learning-service.js';
import { learningRoutes } from './learning-routes.js';

const learning: LearningService = createLearningService({
  directory: join(directory, 'learning'),
  projectPath, // trusted selected project, never the immutable installation root
});
const route = learningRoutes(learning);
const handled = await route(request, response, url, controlToken, origin, agentToken);
// Parent shutdown:
learning.close();
```

The factory is synchronous, exports `LearningService` as its return type, and returns `state()`, `context(input)`, `mutate(action, input, request, controlToken, origin, agentToken)`, and `close()`. Methods are synchronous; the route returns `Promise<boolean>`. `close()` is idempotent. Unrelated paths return `false` without reading the request or accessing storage. Every path in `/v1/learning/` (and `/v1/learning`) is handled, including refusals for unknown endpoints.

Initialization is lazy: factory construction makes no filesystem or database accesses. A parent default factory should be enabled only for an actual existing direct selected project directory. Legacy/nonexistent-project fixtures can omit the service entirely. The first explicit state/context/mutation opens the store, deriving its canonical project ID internally from the trusted `projectPath`. No read automatically opts in, imports history, authors a proposal, or approves anything. A fresh metadata GET may initialize the empty database with consent off.

The parent owns service creation, HTTP routing, and shutdown. Keep these methods and HTTP credentials outside agent/MCP surfaces. `state()` and `context()` are trusted host reads; the routes authenticate them before calling. `mutate()` independently revalidates HTTP authentication and origin. It does not accept a proof or an authorization callback.

## Human HTTP boundary

All learning endpoints require the exact human `Authorization: Bearer <controlToken>` header. Agent bearers are refused on every endpoint, including state/context/unknown paths; an accidental human/agent token collision also denies access. No JSON role, author, proof, capability, or scope claim grants authority. Authentication uses constant-time equality for equal-length token bytes. Duplicate Host/Authorization/Origin/Sec-Fetch-Site headers are refused.

Every request must have the configured origin's exact Host. If `Sec-Fetch-Site` is present, it must equal `same-origin`. Every POST requires the exact configured Origin header; omitted, null, same-site, or cross-origin values fail. GET permits an absent Origin for local clients, rejects a mismatched Origin, and rejects Content-Length other than zero or any Transfer-Encoding. Query parameters, absolute URLs for a different origin, URL credentials, and fragments are refused. There are no redirects or permissive CORS responses.

Only after these checks does a mutation mint a private, per-command `Symbol`. The store's `authorizeHuman` callback accepts only that exact symbol, while it is active for the synchronous command, and checks action, canonical project ID, and scoped request hash. The symbol is never returned, serialized, logged, stored, or caller selectable. Proposals also pass the human checks and always receive `author: 'user'` internally.

## Endpoints and exact JSON fields

| Endpoint | Method | Request fields | Successful response |
| --- | --- | --- | --- |
| `/v1/learning/state` | GET | No body/query | `{settings, records}` |
| `/v1/learning/context` | POST | `{tags, maxBytes}` | `{authority, context, bytes, recordIds}` |
| `/v1/learning/consent` | POST | `{requestHash, enabled}` | Store receipt |
| `/v1/learning/propose` | POST | `{requestHash, kind, text, tags, evidence}` | Store receipt; `targetHash` identifies proposed record |
| `/v1/learning/review` | POST | `{requestHash, recordId, decision, verifiedEvidenceHashes}` | Store receipt |
| `/v1/learning/disable` | POST | `{requestHash, recordId, disabled}` | Store receipt |
| `/v1/learning/erase` | POST | `{requestHash, recordId, confirmation}` | Store receipt plus `checkpoint` |

Responses use status 200 on success, including idempotent replay, and JSON with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. `settings` is `{projectId, optIn, consentAt}`. Review records include text, status, author, tags, evidence hashes, and verification timestamps; proposed/rejected/disabled records appear here for human inspection. This collection is not model context.

All fields in each request row are required, including `verifiedEvidenceHashes`, `recordId`, and `confirmation`. Unknown fields are refused rather than ignored. In particular, browser `projectId`, `projectPath`, `requestId`, `proof`, `author`, `capability`, `scope`, `authority`, `status`, and outcome counts are forbidden. Nested evidence goes through the store's exact-field validation. There is no HTTP outcome API or global scope API.

`requestHash` must be a lowercase, 64-hex SHA-256 identifier generated for the explicit human operation. Preserve the same hash and identical command for a transport retry; use a fresh hash for a different operation. The adapter passes this identifier as the foundation's `requestId`; the store derives the project-scoped receipt `requestHash` as SHA-256 of `projectId + '\0' + submittedRequestHash`. Therefore the returned receipt hash differs from the submitted identifier. Receipts contain `{action, requestHash, inputHash, targetHash, replayed}`. The persisted ledger stores hashes, never the raw request identifier or proof. A normalized identical retry does not repeat a mutation, changed input/action under the same identifier fails with 409, and failed transactions do not consume a receipt. Historical receipts do not describe current consent or record existence: inspect state afterward.

Proposal kinds are `user_correction`, `preference`, and `workflow_pattern`. `tags` contains 1–16 simple ASCII identifiers. `evidence` contains 1–8 exact `{source, reference, sha256}` objects. Sources are `user_message`, `native_message`, `artifact`, and `human_report`; references are opaque ASCII identifiers, never paths or URLs. Hashes are lowercase SHA-256. The service never resolves references or computes evidence by reading files/history. The UI must obtain evidence through an explicit user-selected flow.

## Consent, approval, context, and erase

Consent defaults off and survives restart. New proposals and context retrieval require consent. Turning consent off preserves records for inspection and yields empty context; replaying an old opt-in receipt cannot reenable it. No mount, metadata read, capacity management, or shutdown changes consent.

Proposals remain unverified until review. `decision` must be `approved` or `rejected`. Approval must explicitly submit the exact complete set of the proposal's evidence hashes in `verifiedEvidenceHashes`; partial, missing, unrelated, and automatically inferred attestations fail. Rejection requires an empty array. The parent UI must show the record text and each evidence hash with a human verification checkbox before submitting the explicit selected hashes. Verification timestamps attest that human action; they do not claim independent evidence validation. Review applies only to a proposed record in this exact project; revisions require a new proposal.

Context accepts an integer `maxBytes` from 0 through 16,384 UTF-8 bytes, including the store's policy envelope. It returns whole JSON-escaped hints, only from approved, enabled records matching an explicit tag while consent is on. Proposed, rejected, disabled, other-tag, and other-project records cannot appear. Tiny budgets return empty context. Context declares `authority: 'untrusted_supplemental_hints'` and cannot change permissions/policy or become system instructions. The parent should render text safely and pass any future model context as clearly delimited supplemental data.

`disabled: true` reversibly excludes a record from context. Erase is an explicit separate human command:

- One record: its SHA-256 `recordId` and `confirmation: 'delete-learning-record'`.
- All project records: `recordId: null` and `confirmation: 'delete-project-learning'`; this also turns consent off.

Missing/mismatched confirmation fails. No automatic erase exists. A delete receipt survives restart, and replaying a deleted record's original proposal cannot resurrect it. `checkpoint: 'complete' | 'pending'` reports SQLite WAL cleanup after committed deletion. Erase performs logical deletion with best-effort journal cleanup; backups/snapshots and previously supplied context are outside that operation.

## Bounds and failures

POST requires JSON with no Content-Encoding. The declared and streamed request limit is **32 KiB**. UTF-8 must be valid and JSON must parse. A **2-second** deadline bounds the complete body read, including slow streams. Rejection cleanup drains at most 32 KiB for at most 100 milliseconds to deliver the HTTP error reliably; incomplete/excessive streams close after the response instead of reusing the connection. Store text/count/byte/evidence/receipt limits remain unchanged and cannot be raised through HTTP.

Errors expose only a code and fixed generic message, never exception text, paths, proofs, request bodies, credentials, or database output. Known human/control credentials are refused in mutation content even if they do not resemble a provider key; the store also rejects credential-like content across text/metadata. Success responses redact any occurrence of the live host tokens as a defensive final check. These modules emit no logs.

Invalid input returns 400; missing/wrong bearer 401; agent/origin/Host/Fetch-Site violations 403; unknown endpoint/record 404; wrong method 405; body deadline 408; consent/review/idempotency conflict 409; oversized body 413; unsupported content type/encoding 415; store capacity 429; and closed/damaged/unavailable storage 503. Recoverable command refusal leaves the store usable. Constructor, path, scope, schema, corruption, and unexpected store failures close the connection and leave the service closed until the parent explicitly recreates it. No automatic reset, repair, reopening, retry, consent, or approval occurs.

## Scoped verification

`tests/unit/learning-http.test.ts` runs real isolated loopback HTTP servers over generated temporary project/state directories and a real LearningStore-seeded fixture. It exercises inert/lazy construction, consent persistence/replay, all-route agent denial, strict same-origin/Host/Fetch-Site checks, GET bodies, exact schemas, explicit complete evidence review, cross-project approval/storage isolation, secret rejection/redaction, UTF-8/context bounds, declared/chunked body limits and deadline, reversible disable, confirmed erase/restart/no resurrection, and sticky storage failures. It does not instantiate the product host, Studio, native clients, MCP, providers, inference, uploads, or actual conversation/history stores.

Compile these test/source dependencies explicitly and run this test alone while other parent files are being written. Parent integration owns its broader host smoke checks.
