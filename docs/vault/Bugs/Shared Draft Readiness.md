---
type: bug
project: Arcane
tags: [arcane, chat, persistence]
---
# Shared draft readiness

[[Sessions/2026-10-31 Loaded Update Check]] reproduces a new-chat Send refusal in the verified loaded e813 app. The synthetic 138-byte draft remains in the composer. One original Send attempt was made; no Accepted indicator or reply appeared, and the request was not retried. Customer message delivery remains unverified.

The source guard rejects a missing provider draft source or a project different from the shared library. Codex deliberately withholds its source while native tab preferences are unavailable. Local drafts can still render ready, so the shared pre-dispatch hook can refuse them. Do not fabricate a local ID, fold browser project paths or ignore the persistence error to enable Send.

## Verified source correction

A controlled Windows path inconsistency is independently confirmed: the desktop path policy validates case-insensitively but retains the caller's spelling, while the daemon uses the physical canonical spelling. The startup correction validates and pins the same project and ancestor identities, accepts only the same physical directory, and uses one canonical project string for the environment, session, handoff and preference accessors. Redirection, replaced ancestors and physical spelling changes across validation are refused before allocation/spawn. Existing project key/state-root identity and historical ciphertext remain unchanged.

The shared guard remains exact. Missing or foreign draft state now reports existing Error 423 with a retained-draft explanation instead of asking the user to wait for an unspecified load. Recovery still requires the actual same provider draft source and a confirmed save of its link before the next explicit Send is released. No failed gesture or uncertain native request is replayed.

Strict compilation covers 660 explicit sources. All 110 actual-source host/IPC/encrypted-preference cases pass; all 160 compiled shared-draft/tab/UI cases pass with zero skips/cancellations and unchanged TS/compiled inputs. Real Edge browser fixtures close all 37 fixture native connections. Browser dependency inventories permit only the new pure error-formatter import and retain the existing Node/dynamic-import restrictions.

The initial host selection retained 109 passes and one new-fixture refusal. Its synthetic encrypted plaintext used a noncanonical property order, correctly rejected by the real host. Correcting only that fixture order passes all 110 cases; original failure and a separate sandbox spawn refusal are retained. No production storage/frame/key guard was weakened.

## Actual customer cause remains open

The current app's default project projection shows no apparent case alias; the casing defect is a verified controlled-source bug, not yet the demonstrated cause of this customer's refusal. The native preference record exists and is encrypted. It has not been decrypted or rewritten for this investigation. Diagnose the actual unavailable-preference branch using privacy-safe metadata and preserve original ciphertext, drafts and request evidence. Do not claim the new source resolves customer Send before exact-source delivery and a distinct verified customer attempt.

The app remains open with the unsent synthetic greeting. Saved authentication/history and model-menu interaction work on loaded e813. New browser login, successful customer Send, model/provider/cancel/preview/restart continuity and whole-product acceptance remain open. Studio was not operated.

[[Delivery/G02 Reliable Chat]] · [[Architecture/Error References]] · [[Operations/Current State]] · [[Operations/Next Session]]
