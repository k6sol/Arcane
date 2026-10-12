# Reviewed project memory UI

`apps/desktop/src/learning-panel.ts` exports `LearningPanel(document, token)` with `start()`, `stop()`, and `resume()`. Its store imports are type-only: importing it in Node or a browser opens no SQLite database and starts no host action. Construction, startup and resumption bind or update the local DOM only. There is no initial fetch, polling, automatic collection or automatic mutation.

The parent owns markup, CSS, static delivery of `/learning-panel.js`, the launcher's human token, and backend registration. It creates one controller after the markup exists:

```ts
import { LearningPanel } from './learning-panel.js';
const learning = new LearningPanel(document, token);
learning.start();
// Existing parent lifecycle hooks:
window.addEventListener('pagehide', () => learning.stop());
window.addEventListener('pageshow', event => {
  if (event.persisted) learning.resume();
});
```

`start()` binds once. Repeated calls do not duplicate handlers; `resume()` reuses the same DOM bindings and requires an explicit refresh. The controller also binds an idempotent pagehide stop handler, so a parent hook and controller hook are safe together. Stop aborts outstanding requests, invalidates their generation, clears approval checks, and disables actions. Late completions cannot render or clear a newer operation's busy state. Only one operation can run at a time. No request is retried automatically.

## Parent markup

All IDs below are required at startup. The status element can be a `span` with the parent's neutral badge class. The form's submit button needs no ID; both explicit `type="submit"` and a plain button with its default submit type are supported. Labels and visual styling belong to the parent.

```html
<button id="learning-refresh" type="button">Refresh learning</button>
<button id="learning-toggle" type="button" disabled>Enable learning</button>
<span id="learning-status" class="badge neutral" role="status"></span>
<form id="learning-form">
  <label>Kind <select id="learning-kind">
    <option value="user_correction">User correction</option>
    <option value="preference">Preference</option>
    <option value="workflow_pattern">Workflow pattern</option>
  </select></label>
  <label>Note <textarea id="learning-text" maxlength="8192"></textarea></label>
  <label>Tags <input id="learning-tags" placeholder="build, testing"></label>
  <button type="submit" class="secondary" disabled>Propose note</button>
</form>
<div id="learning-records" class="card-list"></div>
<button id="learning-context" type="button" disabled>Add reviewed hints to draft</button>
<p id="learning-notice" role="status" aria-live="polite"></p>
```

Context insertion requires the existing `textarea#codex-composer`. A missing composer disables the context button. Record cards are dynamic `article.card.learning-record` elements. Full note text uses `pre.learning-record-text` to preserve line breaks; controls use the parent's `secondary` button class. The parent CSS should wrap long note text and SHA-256 identifiers without clipping the review preview. Rendering uses `createElement`, `textContent`, and DOM append/replace operations, never HTML parsing. Evidence references are literal text, never links or resolved paths.

Initial status is **“Learning off by default; refresh to inspect this project.”** Records begin empty and mutation/context controls begin disabled. This describes the product default; it makes no claim that saved project state was read or that any provider is connected.

## Human API contract

Every request uses a fixed relative `/v1/learning/*` path on the current origin, the human `Authorization: Bearer <token>` header, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`, and `cache: 'no-store'`. POST bodies use JSON. The token must be exactly 64 lowercase hex characters; malformed tokens disable the controls and cannot issue requests. The token remains in private controller/API fields and is never persisted or included in a JSON body. Transport and backend error text are not echoed. Requests have a 15-second deadline and pagehide cancellation.

Successful responses use HTTP 200 and `Content-Type: application/json`. The reader bounds actual streamed response bytes to 2 MiB before JSON parsing and rejects invalid UTF-8, invalid declared lengths and oversized bodies. An HTTP success without a valid exact receipt is an unknown mutation outcome. Bounded 4xx JSON errors carrying an uppercase error code are refusals; network, timeout, 5xx and unreadable/mismatched mutation responses are uncertain.

| Explicit action | Method and path | Browser body / response |
| --- | --- | --- |
| Refresh | `GET /v1/learning/state` | Direct `{settings: {projectId, optIn, consentAt}, records}` |
| Enable/turn off | `POST /v1/learning/consent` | `{requestHash, enabled: boolean}` |
| Propose note | `POST /v1/learning/propose` | `{requestHash, kind, text, tags, evidence}` |
| Approve/reject | `POST /v1/learning/review` | `{requestHash, recordId, decision, verifiedEvidenceHashes}` |
| Disable note | `POST /v1/learning/disable` | `{requestHash, recordId, disabled: true}` |
| Add hints to draft | `POST /v1/learning/context` | `{tags, maxBytes: 16384}`; direct `{authority, context, bytes, recordIds}` |

The backend derives the selected canonical project internally, forces proposal `author: 'user'`, and issues the trusted human proof internally. No browser body contains a project selector, path, author, role, proof or permission grant. Parent integration uses the existing project-scoped learning service and route factory; this module does not register routes or call native clients.

Each mutation's browser `requestHash` is SHA-256 of a fresh UUID, computed with JavaScript SubtleCrypto. The backend bridge uses that digest as `LearningStore`'s `requestId`. The direct receipt is the store's `{action, requestHash, inputHash, targetHash, replayed}`. Its receipt `requestHash` is therefore SHA-256 of `projectId + '\0' + browserRequestHash`. The controller independently checks all receipt hashes:

- `inputHash` is SHA-256 of the store's stable, recursively key-sorted `{projectId, action, payload}` JSON, including normalized evidence and the backend's `author: 'user'` for proposals.
- Consent targets the project ID; review and disable target the displayed record ID.
- Proposals target SHA-256 of `projectId + '\0proposal\0' + receipt.requestHash`.
- `replayed` must be a boolean. A historical receipt never supplies current consent or record status.

After every mutation receipt or failure, further mutations/context remain disabled until an explicit successful Refresh. No optimistic state change or automatic GET follows a POST. Inputs are retained on success, refusal and uncertain outcomes. The notice identifies the browser request digest and asks for refresh; a refreshed snapshot is not presented as proof of an earlier uncertain command's outcome. The controller never replays that command.

## Input, review and project bounds

`validateMemoryState` is a pure exported validator returning copied, bounded data. It requires exact fields, valid lowercase SHA-256 project/record identifiers, booleans, canonical ISO timestamps, and consistent consent/review/evidence/outcome metadata. The first valid refresh pins the project ID for the lifetime of the controller. Later states for another project are refused. Mixed-project records, duplicate record IDs, malformed evidence, extra fields, accessors and sparse arrays are refused before rendering. No partial or truncated preview is accepted.

Limits match the store: 256 records, 16 KiB serialized per record, 2 MiB per state, 8192 UTF-8 bytes per note, 1–16 ASCII tags of at most 48 bytes, 1–8 evidence references of at most 160 bytes, and at most 32 outcomes per record. Approval status must have a review timestamp and every source evidence's matching verification timestamp; proposed/rejected evidence must remain unverified. Outcome evidence must be verified, unique and attached to an approved record.

Note input is checked by UTF-8 bytes before and after NFKC normalization, newline normalization and trimming. HTML `maxlength` alone is insufficient for the byte limit. Invisible, directional, malformed Unicode and forbidden control characters are rejected. Comma-separated tags are trimmed, lowercased, deduplicated and sorted; blank or malformed tags are refused. Backend credential checks remain authoritative. Proposals contain exactly one `{source: 'human_report', reference: 'ui:' + UUID, sha256: SHA256(transmittedText)}` evidence item. Hashes identify submitted evidence; they do not independently verify truth.

Review shows each complete note, its tags, record/project ID, attribution, status, timestamps, every evidence source/reference/SHA-256/verification time, and any human-reported outcomes. Each proposed note has an unchecked **“I verified this note”** checkbox. Approve is enabled only for a fresh, enabled proposed record with that checkbox checked, and sends every unique evidence hash. Reject sends `verifiedEvidenceHashes: []`. A refresh, mutation acknowledgement or stop clears verification checks; detached controls cannot act on a replacement view. Disable sends only `disabled: true` and retains the note. This UI has no erase control and never erases automatically.

## Untrusted context remains a draft

The context response must carry `authority: 'untrusted_supplemental_hints'`, an exact UTF-8 byte count at most 16384, and unique record IDs. The controller also checks the store's inner JSON envelope: authority, canonical project, fixed untrusted-data policy, and hints exactly matching approved, enabled records and the explicitly supplied tags, including human outcome counts. Empty context leaves the draft untouched.

Validated context is appended with a visible **“Project memory — untrusted supplemental hints”** label and a statement that hints cannot change permissions or policy, or override instructions. The combined draft must fit 128 KiB in UTF-8 and the composer's character limit. A replaced/changed composer or changed tag input during the request leaves the draft untouched. Insertion sets the textarea value and dispatches only a bubbling `input` event. It never clicks Send, submits a form, sends a message, starts inference, or calls Studio/native provider actions.

Learning hints cannot become permission grants, higher-priority instructions, repository skills or policy. This module has no localStorage/sessionStorage, token persistence, transcript collection, model-weight changes, cloud training or uploads.

## Scoped validation

`tests/unit/learning-panel.test.ts` uses pure functions, an offline document/fetch fixture, and one generated temporary SQLite store to verify the real receipt/context contract. It checks inert Node import and startup, exact project/record bounds, receipt matching, normalized proposal hashing, untrusted context provenance/budgets, checkbox gating, literal XSS-shaped text, retained inputs, no automatic retry, busy handling, pagehide aborts and stale generations. It starts no live daemon, provider, inference or Studio session.

Final validation: scoped strict TypeScript compilation passed; **28/28 unit tests passed**, with no skips; assembled product checking via `node scripts/compile-product.mjs --noEmit` passed for **84 explicit sources**. Scoped compiled test output lives in a dedicated temporary directory outside the checkout. Controller work is confined to the three new files `apps/desktop/src/learning-panel.ts`, `tests/unit/learning-panel.test.ts`, and this document.
