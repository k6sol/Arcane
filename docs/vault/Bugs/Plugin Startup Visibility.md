---
type: bug
project: Arcane
tags: [arcane, plugin, playtest]
---
# Plugin startup visibility and playtest pairing

The customer reports that the plugin disconnects on entering a test session and opens its panel every Studio startup/playtest. The forced popup is reproduced in source: Main constructs the widget with both initial-enabled and override-saved-state set true. Tests previously asserted this forced opening.

Main now uses false for both values, preserving the existing stable widget identity and Studio's saved visibility. First use starts closed, and toolbar actions remain the explicit open/close controls. Pairing and its background worker do not depend on panel visibility. This follows the [official widget-state contract](https://create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo); no key or pairing setting is removed.

The canonical modular artifacts are regenerated and build --check passes. All246 package/standalone Luau0.742/compiler runtime cases pass without skips. The new case, in both modular and generated formats, retains the exact original live pair through Edit/Play/Edit with no extra status/handshake, no key loss and a closed panel. Existing Play-time loss and return-to-Edit recovery cases remain. Edit-only mutation fences, exact identity, unknown receipts and revoked-key behavior are unchanged.

The reported native disconnection is still unaccepted: these controlled engine doubles do not establish actual Studio lifecycle behavior. Do not claim the popup correction proves that separate issue fixed. Further investigation needs exact original transition/poll/session diagnostics. No Studio operation, actual plugin installation/reload or credential read was performed.

[[Delivery/G03 Persistent Sessions]] - [[Delivery/G07 Test and Repair]] - [[Bugs/Preview Composer Layout]] - [[Operations/Next Session]]
