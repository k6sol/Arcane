# Canonical Codex session ACK identity

P2 implementation and verification record, 2026-10-13. The original findings in NATIVE_ASSET_REVIEW.md are unchanged; this document records the separate resolution.

## Edits

Only these repository files were written for this task:

- packages/codex-client/src/session.ts
- tests/unit/codex-session-identity.test.ts
- docs/build/CODEX_SESSION_IDENTITY.md

The session stores a frozen decoded ACK thread/session tuple at session.ts:117 and :567. That tuple includes null and is the canonical scope for the connection. Initial setup and subsequent turn inventory checks compare the complete tuple before and after their asynchronous metadata requests at :427.

Notification adoption at :580 distinguishes an omitted sessionId from an explicit value. An omitted notification field makes no session claim. Explicit null is an exact claim, not a wildcard. Matching notifications remain valid, and notifications never enrich or replace an acknowledged tuple.

The thread/started handler at :699 checks same-thread notifications after setup as well as during setup. A conflicting value fails with the existing PROTOCOL error, stops the transport and retires native hooks. Unrelated late threads are ignored. An active intent ends once, cached approvals are cleared, and grants are fenced.

If a decoded ACK conflicts with earlier provisional notification evidence, its exact tuple is retained in the diagnostic snapshot, including null, while setup becomes unknown and cannot configure/seal the connection. If the transport closes before decoding an ACK, its original provisional evidence remains unconfigured. Neither case creates a durable acknowledged binding.

Public methods, snapshot shapes, human envelopes, lifecycle enums, settings validation and the successful native-config path remain unchanged. An omitted ACK session continues to decode as null.

## Focused proof

The new tests run the actual CodexSession and JsonlTransport. Their only spawned executable is process.execPath running an inline synthetic Node JSONL peer. The peer reads owned fixture gates and writes owned receipts; it has no installed provider, configuration, authentication or Studio path.

The 29 tests cover:

- Start/resume with matching, duplicate and omitted notifications, including canonical string and null sessions.
- Conflicting notifications before the ACK, during held inventory and on a later inventory page.
- Same-thread conflicts after configuration and during later turn preflight, with no new turn dispatch.
- Active-turn conflicts that end the original intent once and clear approvals/write grants.
- An omitted ACK session remaining null, defensive snapshots and no-hooks native-config compatibility.
- Actual CodexService, registry and SQLite fixtures proving that failed setup preserves an existing durable binding and never seals authority.
- Actual durable seals followed by a conflict, proving that persisted ACK scope remains unchanged while old credentials and already captured actors are refused.

The durable cases run for both a string session and null. They use the service as read-only product code; the P1 service changes remain owned by the parent.

## Private verification result

| Suite | Passed | Failed |
| --- | ---: | ---: |
| codex-session-identity.test.ts | 29 | 0 |
| codex-mcp-isolation.test.ts | 47 | 0 |
| codex-client.test.ts | 102 | 0 |
| Total | 178 | 0 |

Private scoped TypeScript 7.0.2 compile: exit 0, with strict options inherited from the repository. It uses three explicit test roots and their import closure, empty include/exclude lists, an absolute Node type root, and an owned temporary outDir. No repository root compile or root dist output was used.

Owned verification directory:

C:\Users\alexk\AppData\Local\Temp\arcane-session-identity-build-poIeO2

Retained evidence:

- tsconfig.json and manifest.json: exact compiler inputs and output location.
- identity-tests.txt: 29/29 result.
- isolation-tests.txt: 47/47 result.
- client-tests.txt: 102/102 result.
- dependencies.mjs: temporary loader that resolves the existing local zod dependency.

All test commands ran from the owned temporary workspace. The existing client suite's repository-relative fixture writes consequently stayed inside that temporary workspace. Its MCP entry path was an explicitly labelled inert path-validation fixture, never executed. The emitted session/transport and imported product modules were compiled from current source.

Reproduction from PowerShell, using the saved configuration and temporary workspace:

    node C:\Users\alexk\OneDrive\Documents\GitHub\Arcane\node_modules\typescript\bin\tsc -p C:\Users\alexk\AppData\Local\Temp\arcane-session-identity-build-poIeO2\tsconfig.json

From the temporary workspace, each emitted test suite was run with node --test --test-concurrency=1 and the file URL of dependencies.mjs supplied through --import.

No installed CLI/config/auth probe, Studio, Blender, AV/ACL operation or Git mutation was performed. Source edits stopped after these tests passed, before the parent's final full private verification.

## Fingerprints

Final source SHA-256:

- session.ts: 1B2D463A2AC82E52CD56D6B7445EE02A76EE1B969666C2EB346FD26122962DDA
- codex-session-identity.test.ts: 63D77DBE5A7E7F96D7FCA0CC3B9717FBDCD9B8A97FB6BCC8F950EDB9C667CB35

Unchanged original review SHA-256:

FB8B9C74975BF9A8CF592BFE02A633C4A7116BA68C79A66AB4BA94CB9D42EE88
