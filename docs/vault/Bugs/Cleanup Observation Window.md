---
type: bug
project: Arcane
tags: [arcane, playtest, verification]
---
# Cleanup observation window

Status: targeted fixture correction prepared.
Related goals: [[Delivery/G01 Release Baseline]], [[Delivery/G07 Test and Repair]].

[Run 40985175867](https://github.com/k6sol/Arcane/actions/runs/40985175867/job/123834411279) failed the refreshed-heartbeat case in `studio-test-service.test.ts`: its eight-second observation helper expired before the controller reached done and closed its SDK client. This is an assertion failure, distinct from the earlier outer test cancellations.

The case performs a real five-second controlled run and deliberately delays a cleanup witness by 1250 ms. The production service already allows fifteen seconds of cleanup grace. Waiting only eight seconds for run plus cleanup can preempt legitimate completion under I/O delay.

The correction observes the existing five-plus-fifteen-second window and records phase, outcome, error code, cleanup, deadlines, close count and heartbeat count if the observation still fails. The original thirty-second case timeout, production deadlines and every result/effect/fencing assertion remain unchanged. Other fixture waits are unchanged.

- [x] Exact failed wait and original lifecycle limits inspected.
- [x] Targeted observation budget and diagnostic snapshot authored.
- [ ] Both heartbeat cases pass on Windows and Linux for the corrected revision.
- [ ] Current candidate's complete inventory and package acceptance pass.

This is controlled SDK/store/ledger evidence, not native Studio acceptance. Do not rerun or enlarge the budget automatically if the new diagnostic reveals a real lifecycle failure.
