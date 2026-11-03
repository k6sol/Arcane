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

## Session transition diagnostics

The current retained local journal has an unrevoked session receiving heartbeats. It does not establish which mode the customer was in or reproduce the reported disconnect; historical revocation records alone cannot answer that question.

The host now stores a sparse studio_continuity_changed event after validating a continuity observation. The event records previous/current mode and play epoch, plus connected/continuity-supported flags. Ordinary unchanged heartbeats remain silent. It includes no place name, marker name, bearer or model/source data. Events share the existing transaction, so invalid identity/mode/epoch observations cannot publish an accepted transition. Existing proof expiry, pairing and write fences are unchanged.

Strict compilation verifies660 sources. The focused SQLite proof-clock, store, reservation and test-service run passes69 cases without skips against frozen source/compiled inputs. Cases cover exact six-second proof lifetime under changing clocks, Edit/Play/Edit without revocation, marker loss/recovery, quiet repeated polls, private-field exclusion and rejected observation rollback. This provides future diagnostic evidence; it does not itself fix or accept native Play-mode disconnection.

Original hosted component run41558970298 for579addc passes all seven jobs, including packaged startup. Installed customer code remains409ef4b; source publication is not installation.
