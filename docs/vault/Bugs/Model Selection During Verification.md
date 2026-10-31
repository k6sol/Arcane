---
type: bug
project: Arcane
tags: [arcane, chat, models, tasks]
---
# Model selection during verification

A completed native reply does not mean its Arcane task has finished. The model picker previously treated an idle/completed native turn as safe for immediate selection even when the exact task still awaited verification. Explicit native selection intentionally cancels unfinished tasks and closes their client, so a picker preference could disconnect the conversation.

The desktop now shares one advisory-selection decision between the visible picker and captured picker API. An exact current unfinished task keeps the choice local to the active chat. Original task identity, model, permissions and draft remain unchanged. The native service's deliberate selection/cancellation behavior and later Send handoff are unchanged.

## Verification

The new browser regression reproduces the unwanted original native select on the retained pre-fix compiled controller. A companion verifies that a settled task still permits one explicit native selection. An initial fixture assertion incorrectly used the submit label as a task-ownership proxy; it was replaced with exact task scope, native tab binding and the enabled original task-stop control before reproducing the actual unwanted request. Original failed observations remain retained.

After the fix, strict compilation covers658 sources. All124 focused cases pass without skips, including real Edge picker interactions, exact unfinished-task scope, preserved draft bytes and write/asset preferences, intentional native selection cancellation, provider sign-in, tool rows and public error references. Source and compiled snapshots remain unchanged during that run.

This is controlled UI/service evidence. Authenticated packaged customer model switching, subsequent staged-preference Send schedules and the complete task/test/repair loop remain separate acceptance items. No Studio operation or native provider turn is performed.

[[Delivery/G02 Reliable Chat]] · [[Delivery/G04 Task Lifetimes]] · [[Delivery/G07 Test and Repair]]
