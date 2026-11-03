---
type: bug
project: Arcane
tags: [arcane, assets, import]
---
# Cutout alpha factors

Textured glTF MASK materials with a fractional baseColorFactor alpha were refused throughout host decode and plugin source/material admission. The direct map helper instead ignored that factor. This prevented a supported exact cutout bake for foliage and similar assets.

Textured MASK now multiplies source texel alpha by the original factor before the inclusive alphaCutoff comparison. It does not round that intermediate value to a byte. The resulting ColorMap remains binary0/255; normal, roughness and metalness maps stay opaque. Fractional factors are recorded in baked-map identity and independently checked against the original source and privately admitted plugin image bundle. Changed, missing or mismatched factors are refused. Existing alpha-one map bytes and identities retain their three-factor representation. BLEND and scalar fractional transparency remain explicitly unsupported; no approximation or new engine authority is introduced.

The implementation follows the [Khronos glTF alpha-coverage specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#alpha-coverage).

## Verification

Strict compilation covers660 product sources. Frozen host import, texture and transfer checks pass68 enabled cases; two existing native-report cases are unconfigured locally. Original standalone Luau0.742/compiler suites pass84 cases before adding the full packet fixture. The final affected texture suite passes all8 cases, including actual host-produced GLB/manifest/packets through production seal/source checks, plugin reconstruction, image creation doubles and exact pixel hashes. This also checks the preserved fractional source factor and Transparency alpha mode. The first expanded plugin run passes84 and fails the new fixture because its child inherited Node's parent test-runner context; removing that inherited context gives the fixture its own runner and resolves the failure. Original logs are retained privately.

The modular plugin builds and its canonical output check passes in an isolated directory. These are controlled host and standalone-plugin acceptance results. No Studio operation, upload, Asset Manager registration, customer update or native render is claimed. Installed409 remains unchanged; full release checks remain required.

[[Delivery/G06 Connected Import]] - [[Delivery/G05 Blender Quality]] - [[Operations/Next Session]]

## Canonical bundle follow-up

All six component jobs on6c07b74 pass, but original packaged-startup job125648325395 refuses preflight with TRACKED_SOURCE_NOT_CLEAN. Its retained failure receipt identifies exactly the three generated plugin/build files: the source change had only been verified in an isolated output directory, while checked-in canonical artifacts were stale. The canonical modular bundle and manifest are now regenerated from the verified source, and build --check passes. No clean-source guard, digest requirement or startup proof is bypassed. The isolated plugin installer and tool-doc release checks pass15 cases; actual Studio plugin installation remains untouched. Fresh hosted packaged acceptance is still required.
