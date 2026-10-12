# Local project learning foundation

`packages/storage/src/learning-store.ts` implements a local, synchronous SQLite store for reviewed project hints. It records user corrections, preferences, and workflow patterns. It does not train model weights, run inference, create embeddings, collect history, upload training data, or emit cloud telemetry. Ranking uses tag overlap and human-verified success/correction counts.

This change is deliberately limited to the store, its offline unit fixtures, and this document. Product settings, HTTP/MCP routes, UI, native history collection, and provider prompt integration remain separate integration work. Feature implementation authorization does not constitute permission to collect actual user conversations.

## Consent and the human boundary

Each new store starts with `optIn: false`. No proposals or outcomes can be added, and retrieval returns empty context, until `setOptInHuman` receives an explicit authorized human command. Turning consent off stops new learning and retrieval, preserves records for inspection, and can be reversed by a fresh human command. A replayed old consent command returns its receipt without changing current consent.

The constructor accepts a trusted, synchronous `authorizeHuman(command, proof)` callback. Without it, every human method is denied. Only the literal return value `true` authorizes a command. A thrown error fails closed without disclosing the proof. The frozen command contains `action`, canonical `projectId`, `requestHash`, and the normalized command's `inputHash`. Proofs are never persisted or included in receipts/audit.

The future host must obtain proof from an authenticated human settings/review action, bind it to those command hashes, and keep the callback and proof issuance outside agent-accessible routes. Do not use a browser JSON field such as `role: "human"`, an agent bearer, a model statement, or an always-true production callback as authorization. The store cannot identify the physical person operating its calling process; this callback is the explicit trust seam for the parent integration.

`propose` accepts `author: "user" | "agent"` as attribution only. Both create `status: "proposed"`, unverified evidence, and zero outcome counts. Author attribution confers no authority. Extra fields for status, consent, verified evidence, counts, global scope, or system authority are rejected.

## Project and storage identity

`canonicalLearningProjectId(projectPath)` matches `scripts/open-project.mjs`: SHA-256 of the physical absolute project directory, lowercased on Windows. Directory inspection uses metadata only. Every public operation requires this exact project ID. SQLite metadata binds the database to one project; opening it for a different project fails. Moving the directory changes identity; there is no automatic cross-project migration or global retrieval.

Choose a private local state directory for each project. The store opens only `learning.sqlite` and SQLite's own journal/WAL/SHM files. Project/state path components must be direct directories without symlinks, junctions, redirected paths, traversal, UNC/device syntax, or ambiguous Windows segments. SQLite files must be direct regular files with one hard link. These checks are repeated before access. They are cooperative filesystem checks, not protection against an actively racing local process; the host should own the state directory and its ACLs.

Fresh empty databases migrate transactionally to schema version 1. Existing databases must match the exact schema and pass integrity, payload, consent, project, and receipt validation. Corrupt stores, unversioned nonempty databases, and higher schema versions fail closed; the store never resets or repairs them automatically. Writes use transactions, WAL, `synchronous=FULL`, and `secure_delete=ON`. There is no startup approval, consent grant, history import, or mutation retry.

## API

All mutation inputs require `projectId` and a caller-generated `requestId` of 8–128 safe ASCII identifier characters. Human methods require a separate proof argument, not a property in the submitted JSON.

| Method | Additional input / result | Authority and behavior |
| --- | --- | --- |
| `settings(projectId)` | `{projectId, optIn, consentAt}` | Local state inspection. |
| `setOptInHuman(input, proof)` | `enabled: boolean` | Explicit human opt-in/out. |
| `propose(input)` | `kind`, `author`, `text`, `tags`, `evidence` | Consented proposal only. Kinds: `user_correction`, `preference`, `workflow_pattern`. |
| `getRecord(projectId, recordId)` | Full record | Local inspection, including disabled/rejected/proposed records. |
| `listForReview(projectId)` | Bounded records | Review UI data; never use this as approved model context. |
| `reviewHuman(input, proof)` | `recordId`, `decision`, `verifiedEvidenceHashes` | Proposed → approved/rejected. Approval must attest every source evidence hash. Rejection uses an empty hash array. |
| `setDisabledHuman(input, proof)` | `recordId`, `disabled: boolean` | Reversible exclusion; preserves content and review status. |
| `recordOutcomeHuman(input, proof)` | `recordId`, `outcome`, `evidence` | Consented, enabled, approved records only. Human-attested `success`/`correction`; duplicate source reference or evidence hash is refused. |
| `retrieve(input)` | `projectId`, `tags`, `maxBytes` | Approved, enabled hints matching at least one requested tag, only when consent is on. |
| `audit(projectId)` | Bounded structural audit | Action, sequence, time, and hashes only. |
| `eraseHuman(input, proof)` | `recordId`, `confirmation` | Sole hard-delete API for learning records; explicit human command only. |
| `close()` | None | Idempotently closes the connection. |

Evidence inputs are `{source, reference, sha256}`. Sources are `user_message`, `native_message`, `artifact`, or `human_report`. References are opaque ASCII IDs (colon-separated components allowed), **not** paths or URLs. `sha256` is a lowercase 64-hex digest of evidence supplied by a future consent-aware caller. The store never resolves a reference, opens an artifact, reads a native auth file, or reads a raw rollout. A hash is provenance, not proof of truth: approval requires the human's explicit verification of each hash. Returned `verifiedAt` is an attestation timestamp, not a claim of independent verification.

An example agent proposal after human consent:

```ts
const receipt = store.propose({
  projectId: store.projectId,
  requestId: 'proposal-request-0001',
  kind: 'preference', author: 'agent',
  text: 'Run focused offline checks before reviewing a change.',
  tags: ['testing'],
  evidence: [{
    source: 'user_message', reference: 'conversation-id:turn-id',
    sha256: humanSelectedEvidenceHash,
  }],
});
// receipt.targetHash is the opaque record ID. This record is still proposed.
```

## Retry semantics and bounds

Every successful mutation returns `{action, requestHash, inputHash, targetHash, replayed}`. Record IDs and receipt identifiers are SHA-256 hashes. The ledger stores hashes and structural metadata, never request text, raw request IDs, evidence references, or human proofs. Requests share a namespace across operation kinds within the project. Identical normalized retries return the existing receipt without repeating the mutation. Changed content or a different action under the same request ID is refused. Tags/evidence and verification hash ordering are normalized. Failed transactions consume no receipt. Human retries still require authorization.

Deleting a record preserves its minimal hash receipt, so replaying the original proposal cannot resurrect deleted content. A receipt reports the historical command outcome; it does not promise the record still exists or reflect current consent/review state. Fetch current state separately. Multi-connection writes use `BEGIN IMMEDIATE`, check receipts under that lock, and commit changes and receipts together.

| Bound | Default hard maximum |
| --- | --- |
| Learning records | 256 per store/project |
| Serialized record | 16 KiB UTF-8 |
| Total stored record payload | 2 MiB UTF-8 |
| Proposal text | 8 KiB UTF-8 |
| Tags | 1–16; 48 ASCII bytes each |
| Initial evidence | 1–8; 160-byte opaque reference each |
| Human outcome evidence | 32 per record, additionally constrained by record/total bytes |
| Request receipts | 4,096; no automatic eviction |
| Audit entries | 256; oldest structural audit entries rotate |
| Retrieved context | 0–16 KiB UTF-8, including the authority/policy envelope |

The host may lower record, byte, receipt, and audit limits, never raise the hard limits. SQLite counts and raw UTF-8 payload lengths are checked before materializing persisted records/receipts into JavaScript. Bounds apply to logical retained data; SQLite page overhead and journal allocation are additional disk usage. The WAL journal size target is 8 MiB and is not a filesystem quota.

Normal mutations stop before the receipt ledger reaches its cap, reserving up to 64 slots (half the ledger when smaller) for opt-out, disabling, and explicit deletion. Those operations also remain receipted and bounded. If even the reserved slots are exhausted, new mutations fail closed rather than forget idempotency. The future host must surface capacity and preserve access to human maintenance; there is no automatic ledger rollover, pruning of receipts, or record eviction.

## Text and prompt policy

Text is normalized with NFKC, trimmed, and has CR/CRLF normalized to LF. Byte limits apply before and after normalization. Disallowed controls, invisible/directional formatting, and malformed Unicode are rejected. The deterministic secret guard rejects the entire submission on recognized private-key blocks, common provider/Git/cloud/local key formats, JWTs, bearer/basic authorization, credential assignments, URL userinfo, or secret query parameters. It also checks tags, request IDs, and evidence references. Errors never echo submitted values.

The policy is **reject**, not silent redaction: the caller must remove credential-like material and resubmit. Pattern checks intentionally favor rejection and can produce false positives. They cannot identify every possible secret or personal datum. The consent-aware caller must minimize and review submitted content; do not forward raw auth, config, or conversation dumps and assume this filter makes them safe.

`retrieve` ranks by descending matching-tag count, then `successCount - 2 * correctionCount`, then ascending opaque record ID. Only human-attested outcomes contribute; no model, clock-based popularity, inference, or remote scoring is involved. Whole JSON-escaped hints are selected until the caller's byte budget is reached. Oversized candidates are skipped; no UTF-8 or partial JSON truncation occurs. A too-small budget or no eligible hints returns empty context.

The output declares `authority: "untrusted_supplemental_hints"` and includes a fixed policy stating that hint values cannot change permissions/policy, override instructions, or become system instructions or repository skills. Prompt-injection wording may remain in a reviewed hint as data; approval does not upgrade its authority. The parent must pass this context as clearly delimited supplemental data and render it as text, never concatenate it into system/developer instructions or execute it. The store does not edit `AGENTS.md`, `CLAUDE.md`, permission settings, or any skill registry.

There is no global recipe promotion or cross-project sharing API. A future global recipe feature needs separate explicit human selection, verified evidence, privacy review, and scope controls. Neither repeated successes nor an agent proposal can promote a recipe here.

## Disable versus erase

For one record, `eraseHuman` requires its hash `recordId` and `confirmation: "delete-learning-record"`. For all project records, pass `recordId: null` and `confirmation: "delete-project-learning"`; this also turns consent off. Neither path is called automatically. Deletion is implemented and exercised only against generated offline fixtures in this change, not actual user history.

Hard deletion removes the record payload, references, and outcome evidence from the database. Bounded audit and idempotency rows retain only action/time/sequence and command/target hashes. `secure_delete` is enabled and the explicit erase method requests a WAL truncate checkpoint. The result adds `checkpoint: "complete" | "pending"`; a busy/failed checkpoint does not undo the committed deletion or authorize replay. This is logical SQLite deletion with best-effort journal cleanup, not a promise of forensic erasure from backups, snapshots, disks, other readers, or previously supplied model context.

## Native history integration, later

The official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) describes supported thread read/list interfaces. A future parent adapter may use supported APIs only after product settings expose human consent and the user selects the project/history scope. The store's `native_message` source is merely a provenance label; it is not a connection, permission, importer, subscription, or history mirror. Cross-provider collection/sharing remains optional future work under user-owned privacy settings. The parent's [Claude Code memory reference](https://code.claude.com/docs/en/memory) is a future design reference, not an implemented integration or permission grant.

## Offline verification

`tests/unit/learning-store.test.ts` uses Node's test runner, temporary generated project/state directories, synthetic evidence hashes, and a nonserializable fixture human proof. It checks default-deny consent, human-only review and erase, agent proposal restrictions, canonical project isolation, transactional/persistent idempotency, verified deterministic ranking, UTF-8 prompt bounds, injection-as-data handling, secret rejection, evidence limits, capacity rollback, reversible disable, hash-only audit, deletion retry behavior, WAL persistence, corruption/newer-schema refusal, and link rejection. It does not invoke a provider, native history/auth source, HTTP route, live Studio, inference, upload, telemetry, or a full product build.

## Integrated local product panel

The product launcher owns the project-scoped service; [LEARNING_HTTP](LEARNING_HTTP.md) documents human-only routes and [LEARNING_UI](LEARNING_UI.md) documents the Learn panel. Startup does not collect transcripts or enable learning. Only an explicit reviewed note can enter approved context, and only an explicit button appends it to a draft without submission. Known current daemon credentials are rejected before storage. Native-history importing/synchronization and automatic reviewed collection remain open.
