# Material image preparation

PNG images in prepared static imports are decoded and checked before preparation succeeds. Validation covers chunk CRCs/order, compressed-stream completion, scanline filters, exact dimensions and allocation limits. The decoder accepts non-interlaced 8-bit greyscale, greyscale-alpha, RGB and RGBA images. Palette and 16-bit PNGs require baking to a supported format. JPEG preparation still validates metadata rather than decoded pixels.

Decoded samples retain straight alpha and their encoded channel values. Pixel storage stays private to an in-process handle; each channel read returns a separate copy. Packed glTF roughness (green) and metalness (blue) can each be expanded into RGB with opaque alpha for red-channel PBR sampling.

This is preparation support. Payload version 1 still refuses texture images, and the current procedural generator emits flat PBR colours. The decoder does not grant upload or Studio authority and does not establish textured native reconstruction, persistence or visual fidelity. Those require the remaining transfer/engine integration and actual Studio acceptance.

Roblox documents editable-image maps for [AssetService.CreateSurfaceAppearanceAsync](https://create.roblox.com/docs/reference/engine/classes/AssetService#CreateSurfaceAppearanceAsync). Native integration must preserve map channels, material factors and UV sampling, handle memory refusal, and verify the created surface before reporting success.

## Scalar PBR placement

Reconstructed render meshes use their authored opaque base colour, double-sided flag and roughness/metalness factors during placement. The plugin creates bounded 1x1 RGBA8 roughness and metalness maps through AssetMaterials; it no longer chooses Wood/Grass/Slate/Marble from mesh names. Collision meshes receive no surface. Materials are cached privately per retained reconstruction, shared through cloned surfaces, and released on continuity retirement. Failed placement does not discard the source meshes; unsafe cleanup fences the owner.

This scalar path is not source-texture import. The existing opaque/zero-emission restrictions remain. Keep this mesh saves geometry; editable-image PBR maps still belong to the Studio session. Engine rendering, colour-space behavior and image persistence require actual Studio acceptance.
