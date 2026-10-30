---
type: bug
project: Arcane
tags: [arcane, verification, import]
---
# Converted import timeout

Status: correction prepared; hosted verification pending.
Related goals: [[Delivery/G01 Release Baseline]], [[Delivery/G06 Connected Import]].

## Observed failure

[Run 40975403615](https://github.com/k6sol/Arcane/actions/runs/40975403615), Windows unit shard 2, cancelled `retiring the current actor while its observation ACK is held cannot arm application` at 30884 ms against an outer deadline of 30000 ms. The shard reported 2459 passing tests, zero failed assertions and one cancellation. This does not prove the intended held-ACK behavior passed.

## Source findings

`tests/unit/converted-studio-import-baseline-host.test.ts` constructs actual stores, compiles a converted graph, stages and reconstructs an initial model and a revision before reaching the held observation. Other multi-stage tests in this fixture already allow 90 seconds. The production staging path rechecks the original actor around fresh observation and before application.

## Targeted correction

Give this composed fixture the same 90-second outer budget, retain all production operation limits, record elapsed fixture/initial/revision stages, and assert exactly one observation was delivered with its ACK withheld before the expected original-authority refusal. Preserve the existing assertions that no application command was sent and no revision was armed.

The new assertion strengthens the intended schedule. A repeated timeout or stage diagnostic must be investigated, not automatically rerun or given a larger deadline.

## Evidence still needed

- [x] Corrected Windows controlled fixture passes on the published revision.
- [ ] Relevant component inventory remains green.
- [ ] Distinguish these controlled receipts from actual native Studio/customer acceptance.

30 October evidence: Windows unit shard 2 of [run 40983762974](https://github.com/k6sol/Arcane/actions/runs/40983762974/job/123829786015), source `98ae294`, passed the strengthened case in 3579 ms. Its stage diagnostics recorded fixture setup at 167 ms, initial placement at 900 ms and revision reconstruction at 3107 ms. The full run is not green: a different task test cancelled in Windows shard 1. That unchanged task test passed on the descendant adoption candidate; keep the outcomes separate.
