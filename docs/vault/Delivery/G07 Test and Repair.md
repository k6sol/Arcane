---
type: goal
project: Arcane
tags: [arcane]
---
# Close the task → test → repair loop

Status: **Queued**. Priority and original scope: Close the task → test → repair loop — P0, queued.

Deliver: automatic chat permissions follow the selected development policy; the actual bounded scenario is prepared, run, inspected and repaired against its original task; human reviews and later Keep/import actions survive task retirement.

Done when: pass, assertion failure, one supported repair, cancellation, stale evidence and unknown cleanup have distinct truthful outcomes; tests restore inputs and temporary changes; accepted evidence is freshly validated; no visible status alone manufactures success or human approval. Repaired and unplanned tasks need explicit supported acceptance paths.

Depends on: 2, 4 and 6. Owner: task/playtest integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

Current source6c07b74 passes105 integrated checks with frozen source/compiled inputs: chat-task-loop, codex-task-retirement, chat-task-store and codex-chat-ui. The run includes real HTTP/SQLite persistence, spawned-node JSONL native-peer fixtures and actual Edge UI journeys; no installed Codex inference or Studio calls occur.

The selection exercises one same-thread repair and reverify after native terminal plus fresh source checks, exact-job cancellation and permission revocation, missing capture/source/cleanup refusal, source edits, durable unknown ACK retention without replay, pending preflight Stop, navigation ownership, normal retirement, and human review after task completion. Approval UI decisions are checked against the actual policy. These controlled outcomes support implementation confidence; they do not prove real Studio scenario execution/restoration, complete-game quality, customer acceptance or whole-goal completion. Repaired and unplanned task acceptance still need explicit outcome-by-outcome audit.

## Next action

Audit current scenario preparation/execution/restoration and explicit repaired/unplanned acceptance against their exact requirements. Preserve the controlled105-case checkpoint while keeping actual Studio execution unverified under the current restriction.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
