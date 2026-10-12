# Asset history persistence — current repair

## Observed failure

The retained original HTTP fixture contains `index.json` and one uncommitted temporary index with **identical 1,436-byte content** (SHA256 `869ac24fbf09f1cc21f0ce2ce18c2e2430b579566305f6556a0c96308f0d8b98`). Both are ordinary single-link files and contain five jobs with one observed event each. This proves a redundant index replacement failed after the temporary write completed. The original error did not record an errno; attributing it to antivirus or OneDrive would be an inference, not established fact. Original journals and failed evidence are preserved.

## Implemented changes

- Byte-identical event-index snapshots no longer replace the destination unnecessarily.
- Persistence flushes drain until the queued tail is stable, including newly observed events.
- Cancellation waits for pending history even when the worker has already left the active set.
- All close callers share one cleanup promise; output-root ownership is released only after the owned cancellation/flush settles.
- Both global history and per-job journals use `atomicAssetJson`: exclusive temporary file, explicit file sync, physical ancestor and single-link file checks, then atomic rename.
- Windows-only `EPERM`/`EBUSY` sharing-lock retries are bounded to four attempts and 250ms of scheduled delays. Every attempt revalidates the source, old destination, their complete byte hashes/high-resolution identities, and physical ancestors. Changed files, successful-but-erroring rename, missing source, access denial, disk errors and non-Windows failures never replay a replacement. There is no unlink-old-target fallback or permission/security change.
- First fatal index failure remains latched, stops later replacements, preserves journals and the uncommitted snapshot, and emits only an allowlisted phase/errno. Workers and model turns are never replayed.

These are cooperative filesystem checks, not an OS sandbox against a racing local process. File sync does not promise directory-entry durability across power loss. Journals/manifests remain authority; index contents never supply job paths or success claims.

## Verification

Parent controlled run after the close repair: **27/27** checks (18 service faults/barriers; 9 atomic-writer faults), zero skips. These include actual owned files and injected syscall faults, not actual Blender/Studio/provider execution. The broad regression and fresh executable gates remain separate. Passing fault coverage does not establish the unknown original errno or prove all environmental locking behavior.
