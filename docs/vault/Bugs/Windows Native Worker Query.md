---
type: bug
project: Arcane
tags: [arcane, windows, workers, custody]
---
# Windows native worker query

Original source2e2fd38 native run41521228872 failed Windows job125537482717 before Blender: the first held-worker identity query timed out at5032ms with no progress marker, stdout or stderr. The later Unicode-path test passed, with one query2680ms and another329ms. This shows the original helper did not reach its first marker in time; it does not prove the precise OS scheduling or startup cause. The original failure is retained and was not rerun. Ubuntu native conversion and all seven original2e component/package jobs subsequently passed; these remain distinct outcomes.

A new first-party5.6KB native Windows helper removes PowerShell startup from the production default identity path. It accepts one host-owned PID through the fixed environment and no arguments. One read-only query/synchronize handle supplies pre/post liveness checks, creation FILETIME and executable path, then must close before bounded UTF-8 JSON is emitted. Access denial or missing/invalid metadata stays unknown. No enumeration, process termination, privilege change or provider/Studio access is introduced.

Production checks exact reviewed executable/receipt hashes and canonical C# source hash, regular single-link files and fixed physical paths before selecting the helper. There is no production fallback to PowerShell on missing or altered helper files. Release collection/verification require the reviewed helper files together when the runtime declares this native path. Source newline normalization supports Git LF/CRLF without changing executable pins. The first explicit compiler attempt stopped before allocation because Windows services its system compiler with two hard links; inspection confirmed the exact system compiler. Only that compiler input accepts servicing hard links; generated outputs remain single-link. The subsequent explicit build succeeded. Source commits and payload integrity do not imply Authenticode signing.

Strict660 compilation and81 frozen worker identity/journal/custody/recovery/browser cases pass with no skips or cancellations. Actual default Windows held-Node and Unicode-path queries complete in91-111ms locally; repeated creation time, executable identity and observation after the original child exits pass. The native path is explicitly asserted. Five release pin/tamper cases pass. A separate isolated copy of the actual compiled runtime also passes five guards: exact input accepted; modified source, executable or receipt refused; hard-linked helper refused. That observer allocates no process and leaves customer files untouched. None of these checks operates Studio or proves native Blender geometry/import or packaged customer startup.

The original release/installer selection completed with two copied-fixture missing-module failures; the fixture now includes the new verifier dependency. Its final198-case release/closure selection passes with no skips/cancellations; original unrelated installer-payload/local-product cases also passed. The original failed outcome remains retained. Query5s/watchdog7s/output4096 and all existing unknown-custody fences are unchanged. Hosted verification of this new source is still required; the earlier failed workflow remains failed.

[[Delivery/G01 Release Baseline]] ? [[Delivery/G04 Task Lifetimes]] ? [[Delivery/G06 Connected Import]] ? [[Bugs/Provider Startup Latency]] ? [[Operations/Next Session]]

The native workflow now watches the helper C# source, reviewed executable/receipt, builder, verifier and pin tests, so helper-only changes cannot bypass native verification. These five new input paths extend the original20-path native provenance closure to25; no operational cap is increased. [[Bugs/Browser Fixture Asset Loading]] records the separate meter-source Windows release navigation failure and its unchanged-deadline fixture fix.
