---
type: bug
project: Arcane
tags: [arcane, assets, diagnostics]
---
# Asset failure details

The public chat failure decoder previously recognized skill, viewport and missing-forest-source errors only. The intentional `studio_asset_generate` refusal returned `BLENDER_REQUIRED`, but live events and saved history reduced it to unavailable Details. The placement tool also returned an error result without an error code when no completed reconstruction existed.

The correction adds finite, tool-bound classifications for Blender-required generation and missing reconstruction, plugin update or unavailable session during placement. Missing reconstruction now carries `STUDIO_RECONSTRUCTION_REQUIRED` in matching text and structured MCP results, before session lookup or scene mutation. UI descriptions identify the required stage without copying provider messages, paths or credentials. Unknown/foreign/conflicting codes remain unavailable; these display summaries grant no authority and trigger no retry.

All 643 product sources compile. Four affected test files passed 195 cases with one browser-only skip, covering the actual MCP placement precondition, real stdio failure events, legacy and paged history, shared UI result decoding, and getter/proxy/foreign-tool controls. The first scoped run caught new descriptions exceeding the existing 96-character presentation bound; descriptions were shortened without relaxing that bound, then all four files passed. Hosted verification remains pending. No actual Studio or customer chat journey follows from those controlled checks.

This does not establish the original forest run's failed skill-selection cause or complete original model authoring. See [[Bugs/Forest Blender Workflow]], [[Bugs/Original Asset Authoring]] and [[Delivery/G08 Diagnostics]].
