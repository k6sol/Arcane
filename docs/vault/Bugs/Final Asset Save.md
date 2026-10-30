---
type: bug
project: Arcane
tags: [arcane, assets, persistence]
---
# Final asset save

Status: controlled regressions passed on Windows and Linux; packaged baseline verified.
Related goal: [[Delivery/G04 Task Lifetimes]].

Generation and conversion supervisors previously scheduled their final advisory-index save without joining it. The original task work could finish while that write was still active.

The internal save scheduler now returns a captured outcome for the exact queued save. Each supervisor waits for that outcome. A later producer's queued snapshot remains independently observed without extending the first producer's wait. Failed saves preserve the original private failure and leave original work unresolved; public admission, cancel and close still report the established `PERSISTENCE` error.

Completion of a save tail is not necessarily successful persistence. Successful persistence is not proof that an unverified worker closed. The adoption lifecycle and existing physical-worker checks remain unchanged.

## Acceptance

- [x] Exact final-tail capture and generation/conversion joins implemented.
- [x] Thirteen controlled cases authored for FIFO, original errors, held commits, unrelated later writes and sticky failures.
- [x] Hosted compilation and both platform suites pass.
- [x] Original leases stay held through writes and retain genuine failures without false closure.

Actual atomic-file tests retain the existing `AtomicJsonFailure` wrapper; direct internal-helper tests separately cover falsy callback failures. No native Blender, provider or Studio success is claimed.

Verified 30 October on `9a69619` in [run 40988115669](https://github.com/k6sol/Arcane/actions/runs/40988115669). See [[Sessions/2026-10-30 Verified Desktop Delivery]] and [[Operations/Evidence Ledger]] for scope and remaining acceptance.
