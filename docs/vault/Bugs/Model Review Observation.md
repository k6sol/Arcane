---
type: bug
project: Arcane
tags: [arcane, previews, verification]
---
# Model review observation

Status: precise browser-fixture correction prepared; corrected hosted result pending.
Related goals: [[Delivery/G01 Release Baseline]], [[Delivery/G05 Blender Quality]].

Windows job 123860001364 in [run 40993135541](https://github.com/k6sol/Arcane/actions/runs/40993135541/job/123860001364) failed the real manifest-button fixture: its request list contained manifest and artifact reads but had not yet observed review preparation.

The production viewer starts model review independently after its verified canvas is ready. That review can await the conversation-selection witness before sending prepare. The fixture waited only for a renderer and the workbench loading flag, then immediately asserted a list that also required the later prepare request.

Arm the exact same-origin POST response observation before each real manifest click and join it before checking the full request list. Preserve the actual renderer/controller, selected-job/body/bearer assertions, all control and disposal checks, exact request counts, CSP, forbidden-request checks and existing deadlines. This changes only the test's observation boundary; it does not approve a model or make a 503 review service available.

- [x] Retain the actual failed Windows log and trace both asynchronous production lifetimes.
- [x] Author response-based observation for both real manifest clicks, retaining every original assertion.
- [ ] Corrected exact Windows browser inventory passes.
- [ ] Complete candidate checks and package acceptance pass.

This is a controlled Edge fixture with synthetic HTTP and a recording renderer, not authenticated customer or native Studio acceptance.
