---
type: bug
project: Arcane
tags: [arcane, materials, import, verification]
---
# PBR staging boundary

Status: exact Windows failure retained; readiness and phase evidence correction in progress.
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
