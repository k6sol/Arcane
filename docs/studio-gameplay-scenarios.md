# Finite gameplay scenarios

`playtest_request` accepts an optional versioned scenario alongside the existing
paired session, native Studio selection, duration, sampling interval and runtime
error policy. Arcane prepares an immutable permission display. Only the separate
authenticated human approval port can admit its exact digest.

The first scenario vocabulary supports holding an approved movement/interaction
key, clicking an approved GUI button, asserting horizontal displacement, and
asserting a GUI visibility or text result. It permits eight steps, four GUI
targets and three seconds of Client execution. Steps carry data, never Luau,
native tool names, filesystem destinations or URLs. Transition assertions default
to requiring a different initial value, recorded before any input. An already
satisfied result is reported separately from an observed transition.

The production native adapter executes one fixed Client program. It resolves
literal selectors under the original LocalPlayer's PlayerGui once, then retains
the actual player, character, root, GUI, target and ancestor objects across every
yield. Replacement objects do not inherit authority. Mouse hit testing rejects
an intervening interactive recipient; passive decorations have a bounded parent
walk. Supported input requires `UserInputService:CreateVirtualInput()` and its
documented key/mouse methods. There is no alternate injection mechanism.

GUI clicks require a conservative coordinate preflight before any scenario input,
including an earlier keyboard step. Roblox documents GUI absolute positions and
hit testing in the Core UI safe-inset coordinate space, while VirtualInput only
specifies screen-space pixels. Arcane does not infer an inset translation. It
requires `GuiService:GetInsetArea()` for `None`, `CoreUISafeInsets` and
`DeviceSafeInsets` to return identical zero-origin rectangles, zero top-left and
bottom-right GUI insets, and a matching current camera viewport. Dimensions must
be positive, finite and at most 16,384. Missing APIs, nonzero insets or conflicting
areas return `UNSUPPORTED_TOOL` before creating input. This can decline an
ordinary session with a top-bar inset. See the primary contracts for
[GUI coordinates](https://create.roblox.com/docs/reference/engine/classes/GuiBase2d#AbsolutePosition),
[GUI hit testing](https://create.roblox.com/docs/reference/engine/classes/BasePlayerGui#GetGuiObjectsAtPosition),
[safe areas](https://create.roblox.com/docs/reference/engine/classes/GuiService#GetInsetArea),
[viewport units](https://create.roblox.com/docs/reference/engine/classes/Camera#ViewportSize)
and [VirtualInput](https://create.roblox.com/docs/reference/engine/classes/VirtualInput#SendMouseButton).

For an admitted click, the retained service/camera objects and coincident area
values must remain unchanged across yields and before mouse-down. Hit-point bounds
use the matched GUI rectangle. Context changes still attempt one release on the
original input object at the original position, while release evidence remains
unknown. Coincident fixture coordinates do not establish native input delivery.

Each potential press is registered before dispatch. Cleanup attempts a single
release on that same retained input object, including when the press raised after
an effect or the character/GUI changed. Attempting release is distinct from
observing release: context and key/button readback must remain trustworthy to
report `observed_released`. Lost ACKs, failed release and uncertain bindings keep
input evidence unknown. Original Play start/stop ownership remains independent,
so bounded owned stop can still run after the original request settles.

## Source and temporary-change scope

The host computes the subject digest from bounded observations of persisted
script source, ScriptEditorService editor source, observed script identities and
enable state within the pairing's allowed roots. It also binds the retained exact
successful script mutation receipts that existed at preparation. The host checks
this scope before approval, after consent, after durable admission and after
owned stop/restoration. A private exact-origin callback can recheck the same
digest through a fresh read-only connection after the requesting chat turn ends.
This is observed source evidence, not an exhaustive hash of all game assets or an
atomic fence against another Studio action.

Up to four temporary `scene.update` edits use existing opaque InstanceRefs,
closed property validation and expected baselines. The private reservation seals
those exact edits before setup. Restoration derives an inverse only from the
original owner's exact succeeded command receipt. Stop cancels queued setup,
awaits a dispatched setup's original ACK within the cleanup budget, then restores
proven edits in reverse order. An unresolved later edit does not suppress an
earlier proven inverse. The reservation remains held until input, owned stop,
restoration, source checks and the healthy journal permit release. Journal
failure still attempts consented physical compensation and closes the dedicated
SDK connection, while retaining reconciliation fences.

Storage schema v6 preserves setup-bearing reservation/command associations,
cancellation closure and project queue exclusion across restart. Private owner
handles are not reconstructed, and restart does not replay or reconcile effects.
See [reservation storage](studio-test-reservation-storage.md).

## Capture and console evidence

The current native `screen_capture` tool describes edit-time capture and supplies
no Client/datamodel attestation. A Client-focused viewport before and after the
call is only a routing observation. Arcane retains a structurally validated PNG
for human review with `context: "unattested"` and `nativeAcceptance: false`.
Required Client screenshot evidence remains missing; successful runtime steps
with required capture end with `UNSUPPORTED_TOOL`, and cannot authorize automated
verified completion or repair. A measured assertion failure retains its original
rows and can retain the human-review image without changing that failure into a
pass. Console summaries are bounded and their gameplay attribution remains
`ambiguous`.

Images are limited to 2 MiB, 4,096 pixels per dimension and eight million pixels,
with bounded PNG chunks/inflation, exact checksums and immutable storage. Capture
history has 64 slots without automatic deletion. The scoped binary HTTP endpoint
returns only the owning job's bytes; the panel checks the retained SHA-256 and
labels the image's context unverified. All public reports keep native acceptance
false until separate native acceptance has actually been established.

## Offline acceptance

The tests execute the exact production Client source received over the real MCP
SDK in pinned standalone Luau 0.742. Engine objects, physics, input delivery,
native peers and image pixels are explicitly synthetic fixtures. Actual product
classes supply the controller, SDK adapter, service, authenticated SQLite command
queue, fsynced ledger, HTTP/MCP decoders, capture storage and panel.
Successful click fixtures explicitly supply zero insets and matching safe-area
rectangles. Other cases exercise top-bar/cutout offsets, missing or invalid area
APIs, viewport mismatches and area/camera changes during held input.

The test-only [Luau setup helper](../scripts/luau-test-runtime.mjs) verifies official
Windows/Linux archive and interpreter/compiler identities. CI requires this
runtime on both runners. Local tests require explicit verified `ARCANE_LUAU_BIN`
and `ARCANE_LUAU_COMPILE` paths. This tooling is separate from product startup.
Offline execution validates finite control flow and evidence contracts; it does
not establish Roblox engine physics, native input delivery or Client capture
acceptance. No Studio session or model provider is needed for these fixtures.
