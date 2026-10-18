# Responsive GUI layouts

Arcane can create `UIFlexItem` modifiers and configure wrapping, flex distribution and cross-axis alignment on `UIListLayout`. These work in direct GUI creation, batch GUI items, reusable prototypes and per-stamp overrides.

| Class | Properties | Arcane validation |
| --- | --- | --- |
| `UIListLayout` | `Wraps` | Boolean |
| `UIListLayout` | `HorizontalFlex`, `VerticalFlex` | `None`, `Fill`, `SpaceAround`, `SpaceBetween`, `SpaceEvenly` |
| Both | `ItemLineAlignment` | `Automatic`, `Start`, `Center`, `End`, `Stretch` |
| `UIFlexItem` | `FlexMode` | `None`, `Grow`, `Shrink`, `Fill`, `Custom` |
| `UIFlexItem` | `GrowRatio`, `ShrinkRatio` | Finite numbers from 0 to 100 |

`UIFlexItem` belongs inside a GuiObject, such as a Frame or TextButton. The list layout belongs in its container. The existing GUI host rules, property limits and exact paired-session/root/write grants still apply. The ratio bounds above are Arcane's intake limits. Property and enum names follow the [UIFlexItem reference](https://create.roblox.com/docs/reference/engine/classes/UIFlexItem) and [UIListLayout reference](https://create.roblox.com/docs/reference/engine/classes/UIListLayout).

The connected plugin must advertise `scene.gui.flex` as well as `scene.gui`. A loaded plugin with only the original GUI capability can continue basic GUI work. Flex classes or properties, including prototype children and stamp overrides, return `PLUGIN_UPDATE_REQUIRED` before a command is queued. Update the plugin through Arcane, load the updated plugin and reconnect before requesting flex layouts.

Use `ui` properties in `scene_build`. For example, a Frame can contain a horizontal UIListLayout with `Wraps: true` and `HorizontalFlex: "Fill"`; its TextButtons can each contain a UIFlexItem with `FlexMode: "Custom"`, `GrowRatio: 1` and `ShrinkRatio: 1`. Pass the real observed parent reference and retain the returned build receipt.

Restoration retains exact engine readbacks of the managed GUI/effect properties, attributes and tag set. A later change to these values returns `CONFLICT` and leaves the created element or build in place. Structurally equal immutable values, such as an unchanged NumberSequence, remain restorable. This guard covers the declared managed property set; it does not claim to observe every property in the engine.

`scene_inspect` returns the managed GUI properties using exact native readbacks: tagged UDim/UDim2, vectors, colours and sequences; plain enum names, booleans, strings and numbers; and Font values with their full native family path, weight and style. Existing values are reported as observed even when they exceed new-write intake bounds. These observations are read-only and do not enable GUI writes.

This feature covers creation and batch construction. Existing GUI property editing through `scene_update` requires a separate canonical snapshot, baseline and restoration implementation; it is not enabled by the flex capability.

Verification includes strict compilation, complete TypeScript/Luau property-table parity, real SQLite queue admission, batch/prototype/stamp compatibility and the actual plugin modules in the pinned standalone Luau VM. Engine values and Instances in those VM checks are explicit test doubles. Native Studio rendering, layout, editor concurrency and restoration remain acceptance gates; no Studio operation or provider inference was used for this verification.
