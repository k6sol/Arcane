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
