---
type: goal
project: Arcane
tags: [arcane]
---
# Make chat dependable

Status: **Queued**. Priority and original scope: Make chat dependable — P0, queued.

Deliver: instant local submission feedback, durable prompts/drafts/history/folders, working model selection with remembered model/effort, shared Codex/Claude conversation context through supported adapters, responsive cancellation, and chat remaining accessible after previews.

Done when: send → switch model/provider → cancel → open preview → return → reopen chat → restart preserves each message exactly once, preserves draft and selection, and neither replays an acknowledged request nor flashes the login screen. Test old and new chats. Integrate with the approved design; no separate redesign.

Depends on: 1. Owner: chat functionality.

## Acceptance record

- [ ] Required behavior implemented against current source.
- [ ] Each outcome above verified at its stated scope.
- [ ] Evidence and remaining limitations recorded below.
- [ ] Relevant regression checks passed for the published revision.

## Evidence

Scoped evidence: installed fa7d730 passes all seven hosted checks and one actual native Sol6.1low startup conversation. Saved login recovered automatically after reviewed old connection notice, the original receipt stayed unknown, and one fresh prompt/reply remained visible without tools or old-prompt replay.194 focused chat/sidebar cases and39 diagnostics cases pass at their recorded scopes. See [[Bugs/Restart and Empty Chats]]. Full cancellation/model/provider/preview/restart coverage and first-Send empty-row correlation remain open; no whole-goal completion is claimed.

## Next action

Publish and verify the exact draft-correlation candidate, then complete its installed customer journey. Local compilation,201 focused cases,56 preload/host cases and eleven existing Edge journeys pass, plus a separate first-Send/reload browser fixture. Broader cancellation/model/provider/preview/restart and atomic cross-record crash recovery remain open.

[[Delivery/Goal Board]] · [[Operations/Evidence Ledger]]
