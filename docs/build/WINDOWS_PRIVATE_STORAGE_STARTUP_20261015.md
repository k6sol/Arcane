# Windows private storage startup — 15 October 2026

The Windows PR job in [run 38725806782](https://github.com/k6sol/Arcane/actions/runs/38725806782/job/116391239139) failed its first native receipt-storage preparation at the existing five-second process deadline. Both the production call and its independent diagnostic trace reported `ETIMEDOUT`; the HTTP boundary correctly refused storage rather than granting an unverified descriptor.

The preparation branch still used `Get-ChildItem`, `New-Object`, `Set-Acl` and `ConvertTo-Json`. It now uses direct .NET enumeration, typed constructors and ACL writes, plus a fixed descriptor serializer. Module autoloading is disabled inside the checker. The trusted executable, five-second deadline, fresh identity capture, ancestor inspection, exact-user private-directory ownership and key/ACL refusal rules are retained. Existing directories are still inspected without permission repair or key replacement.

The complete native owner/refusal matrix passes locally: 36 tests, zero failures and zero skips. This includes real owner permissions through the HTTP boundary, hardlink and borrowed-project rejection, foreign Read rejection, all 25 policy scenarios, and the two historical default-owner refusals. The old policy is retained as a hash-pinned text fixture so later performance changes cannot silently rewrite its evidence.

GitHub verification of the corrected commit is a separate pending check. This change performs no Studio or provider operations.

The next PR attempt passed the production permission cases and then exposed the same cold-start issue in the separate read-only metadata tracer. Its JSON handling and the policy fixture metadata now use the framework serializer directly, with module autoloading disabled and the existing byte/depth/process bounds retained. The exact failing metadata test passes, and the combined native owner/diagnostic/policy suite passes 34/34 with no skips. Diagnostic results remain evidence only and cannot grant a production receipt descriptor.
