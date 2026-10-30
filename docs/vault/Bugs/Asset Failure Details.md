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

## Measured Blender material failures

Generation now classifies exclusively measured material audit failures as node setup, invalid shader link, disconnected surface output or invalid/missing PBR. Classification requires the actual per-mesh errors to match the complete global audit error list; mixed categories, geometry/UV defects, budget failures and unknown errors retain the general mesh-audit reason. Post-texture auditing explicitly reports mesh-validation. Existing reason text remains unchanged for old saved journals.

New wire codes require the written audit reference, exact stage/type and complete consistent finite counters. They survive pipeline recovery, active/archived MCP history and central reporter acknowledgement without copying mesh names, raw errors, paths or exception content. The central service still requires deployment/configuration; a successful pipe write is not a stored server report.

Verification:645 sources compile;22 affected TypeScript cases and6 Python classifier cases pass. Actual Blender4.5 audit of a controlled generated mesh with an empty slot produces the expected node reason; adding a global budget defect preserves the general reason. Both existing union/fallback material cases still pass. Pinned hosted and installed-app acceptance for these new diagnostics remain separate.
