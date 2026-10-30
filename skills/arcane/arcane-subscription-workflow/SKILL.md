---
name: arcane-subscription-workflow
description: "Use the user-selected supported AI access mode for Arcane work, preserving model choice, honest usage reporting and resumable game-development progress when limits interrupt work."
license: MIT
---

# Preserve the access route and the work

## Identify the actual configured mode
Distinguish external MCP client, supported direct plan connection, personal API and managed inference. Read [subscription architecture](../../../docs/SUBSCRIPTION_WORKFLOW.md) as project context, then revalidate current implementation and eligibility rather than treating a design note as a live entitlement. A consumer subscription is not a generic API key.

External clients retain login, model/effort and their own usage accounting. Arcane provides scoped tools, skills and artifacts; it cannot report hidden quota or control unobserved internal reasoning. Direct integration uses the app's authorized connection and supported provider flow, never credentials scraped from another app. Preserve an explicitly chosen model and effort. A fallback that changes billing or data routing needs the user's choice, not silent activation.

## Spend context on useful game outcomes
For a broad game brief, track the connected feature/content plan and acceptance evidence across turns. Use the relevant specialist skills and task-sized source reads; do not reduce a requested complete game to a starter script because a turn is short. For a narrow task, avoid loading an entire game-production manual.

Checkpoint exact changed artifacts, target/revision, remaining dependencies, known failures and the next meaningful acceptance step. Separate implemented systems from placeholders and untested content. Preserve player-facing integration work such as UI, models, animation and sound dependencies rather than leaving them as undocumented TODOs at handoff.

## Handle interruption honestly
On a limit or revoked connection, stop new inference through that route, reconcile already-started operations and retain their original IDs/outcomes. Unknown acknowledgements must not be replayed as a fresh chargeable job. Offer supported continuation later or another explicitly selected mode. Do not rotate identities, accounts or credentials to evade limits, and do not claim parallel agents multiply allowance.

Model-switch/cancel/resume paths must preserve the chosen access semantics and actual tool grants; a provider conversation continuing does not resurrect a retired native operation. Use fresh host authority for later work and leave historical evidence read-only.

## Acceptance and reporting
Verify the mode label matches the actual authenticated request path and reported usage. Keep provider-reported tokens/cost, byte measurements and unavailable quota separate. Judge efficiency by completed acceptance, regressions, corrections and elapsed work as well as context size. No savings percentage, plan eligibility or universal quality promise follows from installing this skill.
