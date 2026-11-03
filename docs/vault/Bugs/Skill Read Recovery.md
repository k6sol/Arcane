---
type: bug
project: Arcane
tags: [arcane, skills, chat, diagnostics]
---
# Skill read recovery

The customer reports repeated skill-selection policy failures and a context-budget refusal while the Blender check succeeds. The old tool descriptions and SDK tests expose a concrete inconsistent default: skills_recommend opts into the owner's experimental guidance policy, but skills_get and skills_list default to approved-only. A recommended experimental skill can therefore be refused by the next omitted-policy read. Exact original codes for the customer's two policy failures are not available from the pasted generic499 description; missing IDs and undeclared references remain distinct possible causes.

All three MCP skill tools now use the same existing owner-enabled guidance policy. Explicit allowExperimental:false still requests approved-only guidance. Registry approval flags, integrity checks, quarantine/deprecation exclusions, read bounds and write permissions are unchanged.

On a context-budget refusal, skills_get returns no oversized or truncated skill bodies. It supplies recovery.nextRequests: independently checked single-skill/reference reads with measured exact byte budgets within the existing128KiB maximum. Every selected skill and reference remains represented. The assistant follows these read-only requests individually; this does not increase the original response budget or replay a write. Tool descriptions explain this path and exact catalogue ID/reference lookup.

Public detail distinguishes Error451 for unavailable ID/policy,452 for an invalid declared reference,453 for an oversized read and454 for bundled skill integrity failure. Unknown codes remain generic; non-skill integrity errors are not mislabelled as skill failures. The agent receives the original bounded error code and recovery calls; the user is not asked to configure internal context budgets.

Strict660 compilation passes. The initial frozen regression selection passes114 and fails four outdated tests that still expect omitted-policy reads to be approved-only. Those cases now explicitly request allowExperimental:false, preserving their policy-refusal assertions; the new complete-budget-recovery and distinct saved-error cases pass in the initial run. The final frozen selection passes all118 cases with zero skips/cancellations, including actual MCP SDK/stdio and relocated-resource bundles, complete returned read plans, explicit approved-only refusal, tampered content, exact reference coverage and saved failure detail. All15 isolated tool-doc/plugin-installer release cases also pass. The generated tool catalogue matches the actual server schemas. This source is newer than installed409; no installed customer or native Studio acceptance is claimed.

[[Skills/Skill Catalog]] - [[Skills/Production Upgrade]] - [[Delivery/G08 Diagnostics]] - [[Operations/Next Session]]
