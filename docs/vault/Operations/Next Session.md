---
type: handoff
project: Arcane
tags: [arcane]
---
# Next session

## Read first

1. [[Home]] and [[Operations/Current State]].
2. [[Delivery/Goal Board]] and the single active goal.
3. Relevant [[Skills/Development Skills]] and architecture notes.

## Resume the actual work

- Re-read remote main and the installed-version metadata. The old validation revision `2531c06` is superseded; do not run an observer pinned to it or restart old jobs.
- Preserve the shared checkout's existing modifications. Use the current authoritative source and a narrow change, with isolated Git plumbing/checkouts if necessary.
- Compare pending adoption/cancellation drafts against current main; reuse only actual missing improvements.
- Choose the first reproducible customer blocker, implement it and verify the same failing path.
- Update the goal's acceptance checklist and evidence, then publish a concise SSH-signed commit.

## Keep context small

Record the exact revision, changed behavior, verification scope, unresolved failure and next action. Store large logs and machine-private receipts outside the shared vault; reference a public run or safe summary here. Read references only when relevant.

Current user constraints: Arcane only. Do not work on ArchLiquid. Do not operate Roblox Studio. Do not close/restart the user's running app to install an update without an applicable instruction.
