---
type: bug
project: Arcane
tags: [arcane, blender, windows, diagnostics]
---
# Windows model supervision

The real current-boulder fixture in [native run 41025696581](https://github.com/k6sol/Arcane/actions/runs/41025696581), source `0e1744b`, passed on Linux and failed on Windows. Windows reached probe, generation, geometry validation, texture authoring and review-render events, then returned `SUPERVISION_UNRECORDED`. A terminal progress event does not override this failed result. Cleanup observed original worker closure and removed its owned temporary data; no successful identity capture or completed model export is inferred.

The original supervisor produces that code when its spawned-worker decision stops the child. Current durable output does not retain the precise capture/query reason. Do not infer timeout, inaccessible metadata, malformed output or persistence failure from duration alone. The failing Windows artifact contained no review images.

The focused fixture update observes the original capture Promise and exact original process-query callback/handle without replacing a host, runner or result, issuing another query, replaying capture or changing limits. It records only bounded role/outcome/callback categories and a sanitized final journal before the existing success assertion. Parser reason remains unavailable when not exposed. All original geometry/export/preview/closure/negative gates remain.

- [ ] Obtain the actual fixed-category Windows failure evidence on the updated fixture.
- [ ] Correct the demonstrated cause without bypassing identity or original close proof.
- [ ] Pass the genuine current-model native path on both platforms and inspect both review views.
- [ ] Verify actual reviewed import and appearance in the designated Studio test place separately.

The Linux boulder passed genuine source-to-export/reopen checks with three original worker roles observed closed and both 512px review images retained. Its visual mass and crack pattern still need improvement; protocol/native success is not artistic acceptance.
