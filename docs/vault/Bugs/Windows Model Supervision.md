---
type: bug
project: Arcane
tags: [arcane, blender, windows, diagnostics]
---
# Windows model supervision

The real current-boulder fixture in [native run 41025696581](https://github.com/k6sol/Arcane/actions/runs/41025696581), source `0e1744b`, passed on Linux and failed on Windows. Windows reached probe, generation, geometry validation, texture authoring and review-render events, then returned `SUPERVISION_UNRECORDED`. A terminal progress event does not override this failed result. Cleanup observed original worker closure and removed its owned temporary data; no successful identity capture or completed model export is inferred.

The original supervisor produces that code when its spawned-worker decision stops the child. The subsequent original call-through observations in [native run 41031570968](https://github.com/k6sol/Arcane/actions/runs/41031570968), source `6f8f3ea`, identify the immediate failure: the probe, Python probe and generation identity queries each timed out after about five seconds with no stdout/stderr bytes. Each original child was observed closed, no identity was captured, and owned temporary data was removed. The reason the CIM query exceeded its deadline remains unproved; this is query-timeout evidence, not evidence that Blender failed to start or that cleanup was lost. The failing Windows artifact contained no review images.

The focused fixture update observes the original capture Promise and exact original process-query callback/handle without replacing a host, runner or result, issuing another query, replaying capture or changing limits. It records only bounded role/outcome/callback categories and a sanitized final journal before the existing success assertion. Parser reason remains unavailable when not exposed. All original geometry/export/preview/closure/negative gates remain.

- [x] Obtain the actual fixed-category Windows failure evidence on the updated fixture: all three original queries timed out in run 41031570968.
- [ ] Correct the demonstrated cause without bypassing identity or original close proof.
- [ ] Pass the genuine current-model native path on both platforms and inspect both review views.
- [ ] Verify actual reviewed import and appearance in the designated Studio test place separately.

The Linux boulder passed genuine source-to-export/reopen checks with three original worker roles observed closed and both 512px review images retained. Its visual mass and crack pattern still need improvement; protocol/native success is not artistic acceptance.

The replacement query uses the exact owned PID and one retained Windows process handle to read creation time and executable path, without CIM enumeration or increasing the five-second deadline. New native timestamps are versioned separately from saved CIM identities: a legacy precision mismatch remains unknown, never proof that the recorded worker exited. Actual default-query tests and the original Blender quality fixture must pass in hosted Windows execution before this implementation is accepted. Source review alone does not establish performance, model quality or Studio import.

The first exact-handle implementation was exercised in [native run 41037253135](https://github.com/k6sol/Arcane/actions/runs/41037253135), source `2cbe9d8`. Linux passed; Windows failed earlier in conversion runtime probing with `RUNTIME_PROCESS_IDENTITY`. Later cases stopped after roughly one second, so the previous five-second query timeouts do not explain this new result. The emitted binding, metadata readback, native calls and observation parsing remain candidate boundaries, not established causes. A focused diagnostic adds only fixed failed-query stage codes to stderr and observes the original default query callback in the owned-child test. Successful JSON, identity/closure checks and the 5,000/7,000/4,096 bounds remain unchanged. No raw exception, process path or output is published.

[Early Windows query run 41039685203](https://github.com/k6sol/Arcane/actions/runs/41039685203), source `820f72c`, observes both original owned-child queries exit with the fixed `type-readback` stage and `query-failed` result, before OpenProcess. This rules out the later process-open/metadata calls for that attempt, but does not yet distinguish type creation from an individual emitted attribute check. The next narrow observation reports only fixed metadata substage and import index while retaining every original library, entrypoint, error-caching, spelling, character-set, calling-convention and PreserveSig requirement. Linux native checks and the Linux release contracts passed on this source; that does not establish Windows success or current catalogue byte totals.

## Local Windows verification after the import correction

The subsequent fixed observation in [native run 41041175344](https://github.com/k6sol/Arcane/actions/runs/41041175344), source `b982aea`, identifies OpenProcess SetLastError=false after library and entrypoint checks passed. Defining the method once through its complete import attribute preserves all required flags. Modern native emitter source corroborates the prior duplicate-map explanation; the actual readback remains authoritative.

- [x] Verify actual local Windows capture, repeated exact creation identity, live attestation, observed original-child close and a Unicode executable path using the unchanged five-second query bound. The tested query code is `6a5d99e`; two real default-adapter cases passed.
- [ ] Pass genuine Windows Blender generation/export/reopen with owned closure.
- [ ] Verify reviewed model import and appearance in the designated Studio place.

The hosted query on source `4511a4f` still timed out with no output; that separate result remains unresolved. Fixed bounded stage progress is now emitted to stderr, while incidental PowerShell progress display is suppressed so it cannot obscure the closed diagnostic grammar. Actual local query traces decode completely and return in about 1.3 seconds. No deadline, output limit, success JSON, native flag check or cleanup proof was relaxed. ConvertTo-Json module loading is a hypothesis for the remaining hosted delay, not an established cause.

## Fixed-shape serialization and actual local Blender run

Run 41046371741 on `c063be4` reaches the final serialization stage in both original Windows queries, then exceeds the unchanged five-second deadline. The corresponding Windows unit shard fails only those two query cases; the other five component lanes and Linux native job pass. This establishes the reached boundary, not an internal module-loader cause.

The correction serializes only the existing version-two observation envelope without PowerShell JSON module discovery. Native flags, same-handle reads, Unicode paths, output/deadline caps and original closure checks remain unchanged. All 642 product sources compile; 22 identity tests pass locally, including actual Windows capture, close and a path containing BMP and supplementary Unicode. Fresh hosted checks remain required.

A separate real local Blender 4.5.3 LTS run completed generation, UV/PBR, both review renders, GLB/FBX export, round-trip and saved-scene reopen. All three original worker roles were observed closed. The model has 5,488 render triangles and 512px original PBR images, with an angle-distortion UV warning. Both actual views were inspected: the rounded mass and uniform crack pattern are not accepted as production art. This is no proof of Studio import or the installed chat journey.
