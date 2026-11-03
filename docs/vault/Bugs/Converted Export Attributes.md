---
type: bug
project: Arcane
tags: [arcane, blender, import]
---
# Converted export attributes

After correcting Windows paths, all four retained logging-game assets converted but failed the actual offline import decoder with UNSUPPORTED_ATTRIBUTE: attributes.TANGENT is unsupported. Their original sources contain POSITION, NORMAL and TEXCOORD_0; conversion introduced TANGENT. This downstream failure explains why successful conversion alone was insufficient.

The conversion worker now derives its tangent export option from validated source evidence. Source-authored tangents remain exported and fidelity-checked. A source without them no longer gains that unsupported channel. No request override, importer allowlist relaxation, tangent deletion from authored sources, topology simplification or material substitution was added. Existing authored tangent/color and unsupported transform refusals remain explicit.

Fresh isolated conversions of unchanged oak, pine, axe and corrected selling-box sources succeed in 15.6, 15.6, 12.1 and 17.5 seconds. All owned workers close. Their complete retained manifests and byte lineage validate through the production converted-import adapter, manifest authority, payload decoder and packet builder. Packet counts are30,30,48,48. Before/after diagnostics are retained privately; no original job was replayed.

Verification:74 Python fidelity cases and18 frozen converted-payload cases pass without skips. The mandatory native fixture adds a separate rigid no-authored-tangents conversion and real offline import transfer on each OS, while retaining the original nonuniform/shared-mesh and cancellation/refusal cases. Its five cases require three successful conversions plus proved cleanup. Hosted outcomes must be observed after publication. Original3645d98 path-only native run41561129413 passes on both OSes.

These are offline import-data checks with synthetic targets: zero Studio commands, no uploads, no human approval and no Asset Manager registration. They do not establish native rendering, model art quality, collision/gameplay acceptance or completion of the requested game. Native/custom authored tangent representation remains outside the supported payload subset and is never silently approximated.

[[Bugs/Windows Conversion Paths]] - [[Delivery/G06 Connected Import]] - [[Delivery/G05 Blender Quality]]
