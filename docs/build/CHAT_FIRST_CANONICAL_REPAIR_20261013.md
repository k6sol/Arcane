# Chat-first canonical regression follow-up — 2026-10-13

The current source-derived run is retained at
`runtime/verification/native-ready-regression-Gip8Wd`. Compilation of 168 explicit
sources exited 0. The unit stage has a terminal nonzero receipt: **1415 tests,
1407 passed, 8 failed, zero skipped/cancelled**, in 640,982 ms. No package from
this run is accepted and no process was restarted on an observation timeout.

The eight observed failures have concrete fixture compatibility causes:

1. `codex-history-service`: the v1 migration assertion still expects schema 2,
   while the chat-inventory implementation now migrates to schema 3. A separate
   diagnostic against the exact compiled case confirms `3 !== 2`. Repair must
   create a genuine v1 layout (remove both later native-history and native-thread
   tables), retain action receipts, require empty native inventory/no guessed
   history, assert schema 3, and retain the no-dispatch invariant.
2. `desktop-verification-ui`: controller-only markup fixture still selects the
   old `Refresh setup status` accessible name. The real minimal button is
   `Check status`. The unchanged trusted Enter/Space, zero automatic API actions,
   responsive, focus and draft assertions must remain.
3. Two `studio-key-settings-ui` cases: their full-production-module HTTP map
   omits `task-usage-ui.js`, `task-usage.js`, and `chat-tabs.js`. The new Studio
   entry statically imports the footer and dynamically mounts chat tabs; a
   missing module prevents actual production startup. Serve exact compiled
   bytes, not stubs, and retain secret clearing, trusted input, native key
   validation, revocation, project/lifecycle isolation and zero-console-error
   checks.
4. `workflow-browser`: its isolated copied production-resource fixture has the
   same missing three chat/footer module files. Copy their actual compiled
   modules alongside the existing graph; do not replace the observed workflow
   model evidence, explicit-decision, same-chat, draft or reload checks.
   The current chat controller also needs the fixture's exact acknowledged
   project/thread/session inventory, not only a raw configured snapshot. The
   fixture now supplies that bounded controlled binding, uses the two real
   sidebar tool controls and closes preview. A foreign native thread stays
   unbound and cannot be authorized by text review; the full review-dialog
   assertions remain exercised on a model change inside the same owned chat.
5. Three `workspace-settings-drawer` cases use the removed visible welcome
   control/old toolbar tool switcher. Their owner is adapting to the current
   visible conversation-settings opener and sidebar tool controls, preserving
   focus restoration, responsive scrolling, draft and zero-action invariants.

No pinned source, fixture or compiled output changed while the run was live.
Repairs began only after its terminal receipt. Whole affected files are being
verified before a new canonical gate with new input hashes. No timeout,
permission, regression assertion or production guard is relaxed. Diagnoses
and source patches alone are not passing tests or a completion claim.

## Whole-file repair verification

The final shared compile passed **168 explicit sources**. All five affected
whole files pass together in the real Edge/owned local-service run:
**60/60 tests, zero failures, skips or cancellations**, 45,250 ms. Evidence:
`runtime/verification/plugin-floating-input-20261013/canonical-fixture-repair-focused-3.tap`;
compile: `canonical-fixture-repair-compile-3.log` in the same directory.

The retained preceding follow-ups were 53/55 and 59/60. The first exposed the
old key fixture's assumption that one project's draft should appear inside a
different project and an attempted click on a still-collapsed preview. The
fixture now requires an empty foreign-project composer and exact original
draft recovery on return; preview is opened through its actual visible toggle
before closing. The second exposed the workflow fixture's failure to restore
its full model catalogue after its controlled model-review ACK. Exact pinned
model/catalogue restoration, not a weaker readiness assertion, resolves it.

The drawer owner's additional whole-file private proof passed 5/5 and preserved
its strong queued-close race test. The parent run above verifies that file
again in the shared current compile. No production frontend/permission code was
changed to satisfy these fixtures. No live inference, login, Studio mutation,
upload or installation occurred. This scoped repair is not a green global
regression or an accepted new package; the next canonical gate is required.
