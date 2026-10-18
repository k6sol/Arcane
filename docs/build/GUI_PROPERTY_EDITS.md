# Editing observed GUI properties

Arcane can inspect and edit the managed properties of its GUI classes through `scene_inspect` and `scene_update`. The connected plugin must advertise `scene.gui` and `scene.gui.edit`; flex classes and list properties also require `scene.gui.flex`. A plugin without editing support returns `PLUGIN_UPDATE_REQUIRED` before a GUI property command is queued. Existing name-only edits remain available.

1. Inspect a real reference returned by the paired session.
2. Copy the exact observed values for the properties being changed into `expected`.
3. For either Font or FontFace, include **both** observed Font and FontFace values. For either minimum or maximum constraint, include **both** observed bounds. Include no other baseline keys.
4. Put only the intended changes in `properties`. New values use the same class/property allowlist and limits as GUI creation. References, root grants, edit mode and task authorization remain required.
5. Retain the command receipt. On an ambiguous result, check receipt status before continuing; do not resend the write.

Dimensions use tagged `UDim` or `UDim2` values. Vectors, colors and gradient sequences retain their type tags and exact native components. Enum names, strings, numbers and booleans remain plain JSON. An observed Font contains its full native family URI, weight and style. Requested FontFace values use Arcane's built-in family names. Observation does not round values or apply new-write bounds; an existing value beyond those bounds can be compared and restored from its own retained receipt.

The plugin compares the observed baseline before opening the undo record and checks the retained managed state again before assignment. It verifies the values read back after assignment. Font receipts retain both native aliases and restore through FontFace, including a previous custom family. Size and text-size constraint receipts retain both bounds and use valid intermediate bounds when assigning mixed changes.

The daemon validates the exact before-values, intended after-values and receipt key set before retaining a successful GUI mutation. A receipt cannot introduce extra properties or change an unrequested companion constraint. Restoration uses the daemon's retained receipt and the plugin's immutable local receipt. A later edit to a retained property returns `CONFLICT`; unrelated properties remain intact.

If assignment fails or is coerced beyond the verification tolerance, the plugin attempts to restore the captured values. It cancels that undo record only after the complete retained managed state matches. A failed verification of the revert returns `PARTIAL` with reconciliation evidence. This covers the managed property set, attributes and tags; it does not claim to observe every engine property.

Verification uses the actual MCP SDK, core policy, SQLite receipt storage and the pinned standalone Luau VM. Native values, Instances and linked engine behavior in VM tests are explicit doubles. Native Studio rendering, editor concurrency, font loading and the full customer workflow remain separate acceptance gates.
