---
type: requirements
project: Arcane
tags: [arcane, context, delivery]
---
# Requirements ledger

This is the durable customer brief. New priorities add to it; they do not erase earlier requirements. Use [[Delivery/Goal Board]] for the ten release goals and their acceptance records. Mark a requirement complete only with attributable evidence; preserve implementation, controlled tests, packaged checks and actual customer/native acceptance as distinct states.

## Output and complete games

- [ ] Revise all 62 product skills substantially, with specific methods and real integration/acceptance criteria: [[Skills/Production Upgrade]].
- [ ] A request for a full game produces a complete playable experience: core loop, appropriate depth/content variety, functioning systems, onboarding, failure/retry/end states, GUI, polished models and scenes, animation and relevant VFX/SFX. A starter room, track or single asset is not the finished game.
- [ ] Racing is an example, not the universal design. Match content breadth and systems to the actual genre and brief; keep small edits scoped.
- [ ] Generate original models in Blender with deliberate geometry, UVs, materials, textures and PBR, then perform actual verified import. No silent substitution with primitive/stock scene kits or Toolbox models; external models need an explicit request.
- [ ] Improve trees, connected leaf/branch structure, bark, rocks, architecture and variation. Avoid repeating the same staircase/world by default. Do not add a scale person beside trees.
- [ ] Finish natural scenes as scenes: terrain/ground treatment, grass and ground cover, paths, undergrowth/clutter, landmarks, composition and lighting, according to the requested scale and style.
- [ ] Plan dependent work and run independent modeling, systems and placement tasks concurrently when actual capabilities support it; retain one owner for conflicting Studio writes.
- [ ] Verify spatial transforms, scale, pivots, bounds, collisions and placement rather than relying on a render or intended coordinates.

## Chat, sessions and organization

- [ ] Codex and Claude share a conversation/history while retaining accurate provider/model/effort details.
- [ ] Preserve login, plugin connection and the last chosen model/effort through startup, new chats, cancellation, model changes and updates; use Sol 6.1 low for platform prompt tests.
- [ ] Send promptly, retain submitted prompts and drafts, preserve old chats and avoid redundant whole-history replay, misleading token totals and irrelevant context-free suggestions.
- [ ] Keep the intended conversation visible and usable through preview, settings, model selection and failed/cancelled turns.
- [ ] Implement accessible folder CRUD and drag/drop without losing chats, drafts or selection: [[Design/Interface Reference]].
- [ ] Show the tutorial/onboarding only when appropriate, respecting saved completion/dismissal.
- [ ] Make API-key Show/Copy work under the supported secure-storage recovery path without leaking the key.

## Desktop, plugin and task reliability

- [ ] Maintain the desktop shortcut and stable supported update path; show the real local update banner and a working Restart to update action that preserves drafts and sessions.
- [ ] Preserve plugin pairing through Studio reload/reconnect and report actual loaded plugin/version/capability state.
- [ ] Expose the required actual tools; do not claim a tool is unavailable before supported discovery or blame the user for an unverified internal approval failure.
- [ ] Support authorized scene changes and deletion, including a requested full cleanup, with appropriate scope and protection for unrelated manual work.
- [ ] Complete original work joins, cancellation, normal completion, restart recovery, human acceptance and bounded archival without leaking capacity or treating unknown work as closed.
- [ ] Complete the actual task/playtest/repair loop, preserving truthful failures and original limits.

## Evidence, previews and diagnostics

- [ ] Show interactive 3D model previews that can be inspected before approval; preserve a usable chat when opening/closing preview.
- [ ] Imported models must be genuinely present in the intended Roblox workflow; distinguish session-only reconstruction from persistent uploaded assets/Asset Manager visibility and explicit Keep approval.
- [ ] Failed generation/import/tool work reports its stage, reason and useful details rather than only an ID. Do not display a complete-success heading over an incomplete build.
- [ ] Use the prepared central diagnostic service and redacted bounded local outbox; configure and verify the real endpoint before claiming remote collection.
- [ ] Message details show real operation inputs/results where safely available, provider/model/effort, timing and errors; do not invent facts from identity-only events.
- [ ] Test real prompts in the user's designated baseplate through the open Arcane app, inspect the result and keep existing user content intact. The latest permission permits this scoped app/Studio testing; it does not authorize work in unrelated places.

## Accounts, distribution and development

- [ ] Complete email accounts, Google/Apple login where configured, optional two-step verification, owner administration and payments. Verify configured services and access controls; do not promise absolute security.
- [ ] Preserve an original, independently usable VFX skill deliverable and its licensing without copying unlicensed source or hiding required attribution.
- [ ] Keep repository updates concise, feature-focused and SSH-signed/Verified. Commit directly when appropriate; if a PR is used, include a useful description and merge only after required checks.
- [ ] Keep checks green, preserve other contributors' work, and avoid unnecessary branches, builds or permission questions.
- [ ] Collaborate through the team mailbox, with explicit STARTED/FINISHED acknowledgements and clear ownership. An unanswered assignment is not acknowledgement.
- [ ] Keep this vault, source skills, decisions, goals, acceptance evidence and next-session handoff current. Never store credentials, private keys or raw personal conversations here.
- [ ] Work on Arcane only. Never work on ArchLiquid.

## Current regression to fix

[[Bugs/Forest Blender Workflow]] records the small forest/well/building result shown on 30 October. The active app used scene-building steps, had failed skill selection and viewport capture, showed primitive vegetation over the bare baseplate, and had no newly placed session-only Blender mesh in its asset panel. This is incomplete output, not an accepted quality baseline.

[[Operations/Current State]] · [[Operations/Next Session]] · [[Delivery/Goal Board]]
