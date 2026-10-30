---
type: goals
project: Arcane
tags: [arcane, delivery]
---
# Goal board

Check a goal off only when its acceptance criteria pass and its evidence is recorded. An implementation or a green unit test alone does not prove the whole customer outcome.

## Urgent release goals

- [ ] [[Delivery/G01 Release Baseline|G01 · Establish one reproducible release baseline]] — in progress
- [ ] [[Delivery/G02 Reliable Chat|G02 · Make chat dependable]]
- [ ] [[Delivery/G03 Persistent Sessions|G03 · Preserve sessions through restart and update]]
- [ ] [[Delivery/G04 Task Lifetimes|G04 · Finish task lifetimes and parallel work]] — in progress
- [ ] [[Delivery/G05 Blender Quality|G05 · Enforce a measurable Blender quality pipeline]] — in progress
- [ ] [[Delivery/G06 Connected Import|G06 · Complete connected import and scene editing]] — in progress
- [ ] [[Delivery/G07 Test and Repair|G07 · Close the task, test and repair loop]]
- [ ] [[Delivery/G08 Diagnostics|G08 · Make every failure diagnosable]] — in progress
- [ ] [[Delivery/G09 Accounts and Billing|G09 · Finish accounts, administration and billing]]
- [ ] [[Delivery/G10 Customer Release|G10 · Ship and prove the customer release]] — in progress

## Execution

Start with G01. Work in parallel on chat/session reliability, asset/plugin integration and task/runtime correctness once the baseline is clear. Diagnostics accompanies all three. Accounts and billing are a public-launch requirement, not a reason to delay usable local development.

## Goal lifecycle

`Queued → In progress → Verification → Done`

Use `Blocked` when an actual dependency prevents further work; record the dependency and the next action. Every completed goal needs an evidence link and a dated result. Reopen a goal when a regression contradicts its acceptance.

## Completed knowledge foundation · 2026-10-29

- [x] Create 37 linked knowledge notes and a Canvas map.
- [x] Give all ten delivery goals explicit acceptance records and next actions.
- [x] Add six Arcane development skills and validate their skill format.
- [x] Catalog the 62 existing registered product skills without changing approvals.
- [x] Verify that sync preserves personal notes/settings and refuses every write on a conflict.

Evidence: all internal knowledge links resolve; the skill-creator validator passed all six development skills; isolated sync checks passed for initial projection, managed updates, conflict refusal, removed-file retention, personal notes and Obsidian settings. These completed setup tasks do not check off the ten product release goals above.
