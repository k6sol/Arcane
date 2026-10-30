---
type: bug
project: Arcane
tags: [arcane, materials, import, verification]
---
# PBR staging boundary

Status: exact Windows failure retained; one-file readiness and bounded phase-evidence correction implemented for hosted validation.
Related goals: [[Delivery/G06 Connected Import]], [[Delivery/G01 Release Baseline]].

[Run 40994353231](https://github.com/k6sol/Arcane/actions/runs/40994353231/job/123863895192) failed the full-resolution 20 MiB PBR staging case after about 42.6 seconds with `STUDIO_STAGE_CONTINUITY`. This is not an over-budget error or the unchanged 120-second total test timeout.

The independently verified portable build retains the actual compiled controller from a source/compiler/lock-identical baseline. Its failing line is the continuity check inside the packet receipt loop, immediately before reading the actual command. It may be the first check after enqueue or a later receipt iteration; the old log does not identify its ordinal.

The fixture publishes its initial six-second Studio proof before expensive texture generation, decoding and transfer preparation, then starts its timer pump afterward. That setup ordering needs an actual first successful pump witness. It does not by itself explain the later-loop historical expiry. Synchronous durable enqueue/review work, timer progress and pump failures need bounded phase evidence before claiming a runtime cause.

- [x] Retain exact failure and bind its emitted line through authenticated compiled artifact data without executing downloaded code.
- [x] Trace full map setup, real StudioStore proof expiry and packet-loop continuity boundaries.
- [ ] Join the owned pump readiness and record bounded real phase evidence, preserving original failures.
- [ ] Keep genuinely expired/missing proof refused before commands or claims.
- [ ] Full-resolution staging/reconstruction and exact byte/receipt budgets pass on both platforms.

Keep original maps, packet/raw/envelope limits, continuity freshness, no-replay rules and all deadlines. No heartbeat may be manufactured by a fake inspector. The fixture uses controlled plugin acknowledgements and does not establish actual native Studio import or upload.

## Connected fixture correction

Wait for the owned timer pump's first real successful paired poll after expensive texture/transfer preparation. Keep the actual default clock and six-second proof lifetime. Delegate unchanged Store methods while recording bounded enqueue, poll, result and continuity-read durations, last packet ordinal, poll silence and finite failure taxonomy. Preserve and rethrow the original failure object; diagnostics cannot replace it.

A separate full-resolution countercase holds the real pump until the actual proof expires, then requires the unchanged continuity refusal with no queued command, durable stage or consumed claim. All five original cases, 20 MiB of RGBA maps, packet/raw/envelope limits, production code and deadlines remain unchanged. The candidate uses ordinary ES2023 Promise construction; no compiler target/library is widened.

- [x] Prepare and independently review the connected one-file correction and real-expiry countercase.
- [ ] Execute all six cases in the unchanged hosted platform suites and inspect their phase evidence.

Readiness repair is not proof that the historical later-loop expiry is fixed. A repeated refusal must still fail and identify its actual phase. No product performance or native Studio acceptance is claimed by fixture instrumentation.
