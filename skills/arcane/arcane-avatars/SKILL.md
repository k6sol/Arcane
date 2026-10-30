---
name: arcane-avatars
description: "Author and integrate avatar cosmetics or wearable items for the intended body and product type, with verified fit, attachment, lifecycle and publication boundaries."
license: MIT
---

# Wearables that fit the intended player

## Identify the actual product
Separate an in-experience cosmetic from classic clothing, layered clothing, a rigid accessory or marketplace publication. Determine target rig/body range, attachment location, visibility, style, gameplay restrictions and ownership. A decorative NPC prop and a distributable avatar item have different contracts.

Read the current supported format and target pipeline before authoring cages, attachments or a skeleton. Do not infer that static mesh adoption converts a wearable or that a local object is eligible for public sale. Unsupported clothing/rig/publication capability is a named limitation, not permission to omit the required structure.

## Author for fit and use
Create original geometry, UVs, textures and PBR in Blender. Plan front/side/back silhouette and construction around the actual body rather than placing an enlarged shell near it. Keep contact offsets, attachment orientation, interior clearance and thickness deliberate. For layered items, create the required cage/wrap data only through a verified supported route; record its target body and rest pose.

Keep material scale and deformation appropriate to the item. Use trim/atlas reuse where it does not destroy readable detail. Avoid clipping at the neck, shoulders, elbows, waist and knees during relevant movement, and avoid accessory shapes that obstruct the player's camera or critical UI. Custom head/face work needs its actual compatible rig/material contract.

Use user/project-owned resources or express permission for external/free assets; do not invent clothing, accessory or animation IDs. Reference art does not supply distribution rights. Keep source/export hashes, logical item identity, attachment/fit data and licence information with the asset.

## Integrate without changing the player
Use the actual available equip/appearance route and existing gameplay architecture. Preserve character health, tools, attachments and controller state unrelated to the cosmetic. Handle equip, unequip, duplicate request, body replacement, death and respawn without stacking orphan items. The server owns item eligibility and grants; local presentation does not establish inventory ownership.

If animation or observer visibility matters, test the actual runtime rig and remote view. Persist only the requested cosmetic identity through the existing authorized data system; an instance reference or session-only image resource is not durable saved content. Never publish, purchase or certify rights from a skill instruction.

## Acceptance
Inspect representative intended body sizes and neutral, locomotion and extreme relevant poses in the engine, not only a Blender mannequin render. Measure important clearances/attachment offsets and check texture stretch, face/hand obstruction and layering. Exercise equip/unequip, respawn and observer appearance, plus denied ownership where the item is gated.

Record tested bodies/poses, unsupported combinations, actual persistence and publication state. A private-place fit test is not marketplace compliance, moderation or upload acceptance; public publication still requires its explicit scope and current requirements.
