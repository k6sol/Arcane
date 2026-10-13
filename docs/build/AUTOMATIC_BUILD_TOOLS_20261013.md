# Automatic Arcane build tools — 13 October 2026

## What changed
- Native child profile explicitly enables the reviewed 25-tool Arcane surface, marks the server required, and clears its child-only tool deny list. Global user configuration and managed policies are not edited.
- Thread setup and every turn inspect the exact native thread inventory. A connected read-only bridge is no longer accepted as build-ready. Missing tools fence the unsent task with MCP_CAPABILITIES.
- Native developer instructions and MCP initialization guidance require automatic skill/tool selection, exact paired-place inspection, authorized execution, receipt reconciliation and evidence-based reporting. No workflow/tool picker is required to submit a chat task.
- skills_recommend loads relevant bundled guidance under a byte budget. Experimental guidance is explicitly labelled, not promoted to production approval.
- Plugin 0.1.2 supplies scene_children.parentRef, including an empty Workspace; adds Cylinder/Ball/Block Shape, bounded Orientation, CastShadow, Reflectance, and WedgePart/CornerWedgePart/SpawnLocation creation. It also supports native-verified Grass, Ground, Rock, Cobblestone and Asphalt Part materials. Exact grants, opaque refs, edit-mode guards and restoration conflicts remain enforced.

## Verified
The initial 231 scoped regression tests passed with no failures or skips; the final bridge/store/HTTP and complete plugin inventory is recorded separately in automatic-build-final-20261013.log. Installed Codex metadata reports all 25 effective tools in an ephemeral thread, with inherited servers disabled and no model turn. A separate baseline-profile metadata check also reports 25 tools: configuration filtering is NOT established as the previous failure cause. The weak readiness predicate and actual geometry/discovery gaps are proven defects.

A temporary two-object Model in disposable Place1 verified native Cylinder size/orientation and SpawnLocation's Part inheritance. It was destroyed in the same call and the original Workspace child count restored. This official Studio MCP primitive check is NOT a genuine Arcane HTTP/command/receipt acceptance test.

Installed local plugin SHA-256: 161f5be1aaf727444a0d9942b333bce8071bdadebd51420de25b1de1e7945179. Studio must load the updated local plugin; an already loaded 0.1.0 session is not silently relabelled.

## Remaining limits
The updated native model has not been used for a paid map-building turn. Genuine paired Arcane edit/restore acceptance remains pending. No Hunted edits, uploads, publishing or DataStore operations occurred. This is component verification, not a claim that the entire product or arbitrary tasks are perfect.

Parallel GLB validator and renderer components are fixture-verified but not integrated into the desktop viewer yet. Three.js is MIT licensed; its vendored licence is included in source/deployment packaging.

Evidence: runtime/verification/automatic-build-components-20261013.json and the named logs/native inventory records it references.

## Saved successful connection resume
Plugin 0.1.2 queues one fresh authentication after a previously successful saved connection. Cached connected state never renders green or restores a session token, object reference, command or lease epoch. Failed/uncertain authentication is not automatically replayed; key edits fence queued/in-flight access. The complete 353 scoped tests pass against this source, including 109 plugin tests. The earlier startup test attempts failed on stale no-autoconnect assertions and a fixture nil-status assumption; they are retained, not relabelled as passes.
