# Floating Arcane popup and API-key entry

The production plugin now requests a compact floating widget at startup, with
the saved hidden/enabled state overridden. A new stable widget ID migrates the
old docked layout once; the two existing Arcane-owned key/status setting names
are unchanged. Toolbar state is synchronized immediately, and the toolbar can
still close and reopen the popup. Showing the popup performs no pairing, HTTP,
permission change, or automatic reconnection.

The editable, transparent TextBox is now above—not below—the noninteractive
visual mask. It explicitly accepts focus and editing and fills the entire key
entry hit area. Native glyphs remain hidden; the existing fixed mask, raw-input
clearing, rejection recovery and single transport worker are preserved.

Verified: **81/81** package and standalone official Luau fixture tests, zero
skips, plus deterministic build/check. These execute production Main and its
generated bundle against explicit engine/GUI/HTTP doubles. The first new run
exposed the fixture's incorrect zero-argument UDim2 default; that failed evidence
is retained and the double now matches the engine's zero defaults.

Installed Arcane-only artifact:
`C:/Users/alexk/AppData/Local/Roblox/Plugins/ArcaneLocalBridge.lua`

SHA-256: `e7693b4761eae3eddefc6f8c2f84c1d94aac245ff22d413f2c244953be7e465f`

Previous artifact backup:
`runtime/plugin-backups/a264eec6-35cb-4fc7-ad0f-1805aa327af0.rbxm`

Installed bytes were independently hash-checked. Studio must reload its local
plugin to use these bytes; the current owned disposable window still lists the
old V1 widget. Neither current native typing nor genuine key exchange/edit/restore
is claimed by these fixture tests. No Studio window was force-closed for this
change, and no other plugin or game was edited.

Studio controls floating-window placement. The supported constructor exposes
float state and size, not an absolute desktop X/Y or a force-center parameter.
This requests the floating popup without unsupported window manipulation;
exact screen centering on every launch is not guaranteed. Subsequent manually
moved/docked positions remain Studio-owned preferences.

Official API consulted:
https://create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo

Evidence: `runtime/verification/plugin-floating-input-20261013/`.

## Superseding input correction after the user's native report

The user reported that typing still did not work after reloading. Native GUI
inventory confirmed FloatingV2 exists in the newly opened Studio window, while
the older owned disposable window still has V1. A capture of the new widget was
unavailable because it was no longer visible. The earlier 81/81 proof did not
establish successful native typing and must not be presented as resolving that
report.

The custom overlay has now been removed entirely. The entry is an ordinary
native editable TextBox, with visible glyphs and unrestricted visible graphemes,
native placeholder and padding. Only text the user currently types is visible;
saved keys are not prefilled and are represented by a fixed placeholder. Raw
input is still cleared before any exchange or unload, and never copied to
labels, errors or logs. Rejection, superseded intent, saved-key and transport
authority tests are unchanged in scope.

The superseding source/generated-bundle/official compiler fixture run is also
**81/81**, zero skips: `standard-native-input-fixed.tap`. The intermediate
failed run is retained; an assertion incorrectly compared the replacement input
to the previous key and was corrected to require the actual new key.

This supersedes the invisible-glyph masking design above. Native user typing
confirmation remains pending; no source/fixture test is a substitute for it.

The superseding verified bytes were installed with SHA-256
`524fdda174202d3555db8fc1df42b15f69c8266337e098547c2d14a089ae283d`.
Prior bytes are backed up at
`runtime/plugin-backups/ab859406-640e-47f5-b14e-524635930451.rbxm`.
