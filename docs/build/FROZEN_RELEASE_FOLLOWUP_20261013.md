# Current release-stage follow-up — 2026-10-13

The fresh canonical run `native-ready-regression-NjZ3JW` compiled 168 sources
and passed **1415/1415** unit/browser tests, zero skipped/cancelled. Plugin
build also passed. The complete offline gate reached a genuine terminal result:
**459 tests, 458 passed, one failed**, zero skipped/cancelled, 280,016 ms.
No package from that failed pipeline was accepted.

The sole failure was the local-release synthetic compiler fixture's old exact
seven-file inventory. Its real fixture now includes eleven source modules,
including chat tabs, key settings and task usage. The assertion now lists all
eleven independently and still checks exact arguments/config/CWD, compiler-child
memory defaults/overrides, config-file cleanup and refusal of extra flags. No
production code, timeout or permission changed for this repair.

To avoid repeating unchanged unit tests, the explicit manual follow-up runner
`runtime/verification/complete-frozen-release-20261013.mjs` checks the actual
successful compile/unit terminal receipts and full unit log, exact current
source inventory/hashes, frontend hashes, and all **336** current emitted JS/map
files. Each map's inline source matches its pinned input; file modification/change
times must predate the successful unit stage. It refuses changed/added sources
or post-test emissions and requires a fresh canonical run instead. Only the
inspected release fixture may differ from the original offline manifest.

Verified input evidence is in
`runtime/verification/frozen-release-followup-w8e7Ut/input-proof.json`. The
follow-up reruns the **entire** current offline release/skills/plugin gate,
then checks all frozen bytes again before packaging and actual EXE verification.
This is an explicitly scoped combination of unchanged previously proven units
and freshly tested release inputs—not a second unit invocation or concealed
retry. Earlier failed logs remain unchanged. No inference, login, install,
Studio edit/upload, machine policy change or foreign-process shutdown is used.

The current actual production Electron host additionally passed **25 checks**
in `runtime/verification/chat-first-native-host-EhZx8n/verification.json`.
That includes separate local drafts, a stable composer, no native lifecycle
started by local chat intents, and hidden metrics without a task. It uses
the actual main/preload/renderer/daemon, but is not yet packaged-EXE proof.
Its smoke profile deliberately disables preferences/provider operations, so
it does not prove encrypted restart persistence, user login or native typing.

Full product verification remains false. Native Studio typing/pairing and
genuine edit/restore acceptance remain independent outstanding gates.
