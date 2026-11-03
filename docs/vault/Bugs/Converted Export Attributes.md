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

## Native fixture correction

Original33d7e0a native run41563019693 fails on both OSes in its added offline import case: conversion and the source-absent tangent assertion pass, then the importer correctly refuses the fixture's tiled UV coordinate1.25. The original tiled/nonuniform fidelity cases still pass, as do cancellation and planar-hull refusal. The final three-success aggregate also fails because that added case did not complete; no full native acceptance is claimed.

Only the separate import fixture now uses a unit-UV leaf chart. The default original fixture retains its exact tiled chart and nonuniform transforms; no runtime UV validation or geometry fidelity limit changes. An isolated diagnostic using the corrected native source/parent constructors and installed Blender4.5 completes conversion and the production offline import transfer (40 packets), with all workers closed and no Studio operations. Initial diagnostic setup failures before process creation are retained privately. This is not hosted5.2 acceptance; observe the new original correction run.
