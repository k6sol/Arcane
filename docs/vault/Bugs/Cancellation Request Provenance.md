---
type: bug
project: Arcane
tags: [arcane, chat, cancellation]
---
# Cancellation request provenance

Status: controlled regressions passed on Windows and Linux.
Related goals: [[Delivery/G02 Reliable Chat]], [[Delivery/G04 Task Lifetimes]].

Stop closes the original client while a repair request may be pending. That request rejects as disconnected even when the client closes successfully. Joining it as a cleanup failure made an otherwise clean Stop appear unsuccessful.

The transport now privately recognizes only the exact pending request errors it creates during deliberate close. The session preserves that provenance across its own preflight projection. The original task owner classifies through its captured client; a revoked repair ignores only that exact deliberate-close rejection.

Actual physical-close failures remain independently joined. Earlier remote/protocol/timeout failures, ordinary disconnects, copied errors and another client's errors remain genuine failures. Matching a code, message or cancelled flag grants no provenance.

## Acceptance

- [x] Original-object provenance wired through transport, session, host and coordinator.
- [x] Regression sources cover actual owned Node peers and the real service/coordinator/session chain.
- [x] Hosted compilation and controlled regressions pass.
- [x] Held repair ACK and preflight Stop complete without a false cleanup error.
- [x] Genuine failures remain exact cached failures; copied/foreign objects are refused.

Fourteen authored cases supplement existing tests without replacing their bodies or deadlines. Controlled provider peers do not prove real subscription inference or native Studio acceptance.

Verified 30 October on `9a69619` in [run 40988115669](https://github.com/k6sol/Arcane/actions/runs/40988115669). See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]] for scope and remaining acceptance.
