---
name: arcane-onboarding
description: "Build Roblox onboarding that teaches through the real core loop, with clear first action, recovery and optional guidance."
license: MIT
---

# Teach the actual game through meaningful play

Identify the first worthwhile decision and the smallest knowledge the player needs to make it. A racing start teaches steer/brake and where to go; a builder teaches claim/place and why production matters; a mystery teaches observe/interact and how clues change a goal. Do not replace these with an unrelated tutorial minigame or a long slideshow. A complete-game brief needs a coherent first session, while a prompt-text repair should stay a repair.

## Design the first route

Map arrival -> orientation -> first action -> understandable feedback -> first success/failure -> next choice. Put the actual destination and relevant control in view; use landmarks, animation, interaction cues and concise GUI together. Teach one new dependency before combining it with another. The right cadence follows audience, mechanic and reading needs, not a universal completion timer.

Give players a safe way to try, fail and recover without hiding the eventual rules. Avoid a tutorial-only checkpoint, free reward or invulnerability that silently teaches the wrong game. If a demonstration uses temporary assistance, label and retire it before the normal loop. Test where a new player looks and moves rather than assuming a top-corner instruction was read.

## Helpful state, never a trap

Track actual learned-action milestones separately from screen impressions. A prompt being shown is not proof of understanding; a client flag cannot authorize a server reward or unlock. Persist only requested progress using the existing profile flow, preserving failed-load safety and old tutorial versions. Interrupted onboarding, returning players and a late join into a live round each need an intentional path.

Offer contextual help, skip or replay guidance when appropriate. Experienced players should not be forced through repeated popups, and skipping instructions should not leave required inventory/state uninitialized. Prompts must match current device bindings and respect changed controls. Use readable text, focusable buttons, subtitles and non-color cues; dismissing help returns focus/control to the original action. Never lock movement behind inaccessible hover-only UI.

## Connect the first session to the real content

After initial success, expose the next meaningful decision: a new route, upgrade trade-off, role responsibility, encounter or discovery. Explain useful rewards and actual consequences, not just an XP toast. A full game should let the player find settings, resume after death, inspect objectives and understand an unavailable action without developer narration. Do not turn onboarding into an unrequested purchase funnel or pressure unfamiliar players into spending.

## Acceptance

Observe a new participant completing the actual loop without coaching. Record first action, confusion, accidental exits, failures, help usage and recovery; completion time alone is weak evidence. Exercise skip/replay, changed device, death during a lesson, disconnect/rejoin and a returning profile. Verify actual milestone state, GUI visibility/focus and world interaction agree. Authorized scenario checks can prove a specific prompt/action sequence; they do not establish player comprehension, retention or every supported device. Keep unsupported actions and pending human playtest review explicit.
