---
type: goal
project: Arcane
tags: [arcane]
---
# Make every failure diagnosable

Scoped follow-up: [[Architecture/Error References]] supplies stable public numbers and explanations for connection, sign-in, request, model-stage, import and preview failures. Technical IDs remain available for correlation. Fixed recovery notices and reserved login-message space preserve the sign-in controls in four tested viewport widths. See [[Sessions/2026-10-31 Browser Sign-in and Error References]] for exact local evidence and remaining delivery/customer boundaries. This does not configure the central server or complete the whole diagnostics goal.

Status: **In progress**. Priority and original scope: Make every failure diagnosable — P1.

Deliver: message details show real operations, model/effort, timing and errors; failed jobs show stage, cause and remedy; bounded local reports feed the prepared central service through a redacted retry queue.

Done when: injected chat, mesh, texture, import, plugin and restart failures produce correlated actionable reports without keys, credentials or unnecessary prompt content; offline retry does not duplicate reports; unavailable hosting is shown honestly. Deployment is complete only after a real endpoint and its access controls are configured and verified.

Depends on: 1; implement alongside 2–7. Owner: diagnostics/service integration.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

No whole-goal completion evidence recorded yet. Add actual revision/run/artifact links and distinguish controlled tests from customer/native proof.

## Next action

Validate [[Bugs/Studio Staging Diagnostics]] through its real controller, native route, MCP result, shared message details and existing reporter/outbox. Keep all acceptance boxes open until actual checks pass. Remote service configuration and authenticated customer reproduction remain separate requirements.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]

Current work adds finite staging phase/reason details and preserves unknown/no-retry results. Existing generation diagnostics remain intact. Source implementation and controlled fixtures do not prove a configured central server or whole-goal completion.

## Scoped connection evidence verified

- [x] Exact host-owned Claude/Credits terminal failures have a one-shot nonblocking route into the existing encrypted outbox, correlated to the original turn UUID. Controlled verification passes194 cases across provider hosts, asset lifetimes, diagnostic storage and main composition, with strict649-source compilation and zero skips. The original two regression cases first demonstrated missing reports. Intentional Stop/closed/interrupted/consent/steps outcomes and unmatched provider text remain excluded. Original ownership is rechecked across account reads; stale same-path project replacement stores nothing. OS keychain, hosted collector and authenticated customer acceptance remain separate.

- [x] Original transport frame-limit failures retain finite direction, byte-bound observation, pending-method mask and actual connect phase without payload content.
- [x] Actual SQLite terminal action commit precedes optional reporting; replay and reporting failures do not resend the native operation or alter its recorded outcome.
- [x] The finite event survives encrypted local reload and strict authenticated gateway validation within the existing byte bound.
- [ ] Configure and verify a real central endpoint and authenticated customer reproduction.

Evidence: functional code `87188b7`, compiled locally with 642-source inventory; 294 focused passes/one browser skip, plus nine outbox and nine gateway cases. These scoped checks do not complete every failure family or the whole goal. See [[Operations/Evidence Ledger]].
