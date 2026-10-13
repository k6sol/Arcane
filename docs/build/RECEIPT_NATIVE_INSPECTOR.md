# Native receipt inspector: verified read-only optimization

On 13 October 2026 the user authorized this optimization **only after equivalence tests passed**. The initial edit was denied by safety review; it was not applied or bypassed. Comparison evidence was produced before the approved production change.

`runtime/verification/acl-equivalence-qtPS8P/verification.json` records seven real Windows ACL/attribute fingerprints (every ancestor, the private directory and key), and seven paired valid/missing/short/long/directory/reparse cases. All owner, DACL, rule, inheritance/protection, directory/file attributes and lengths matched. Original and candidate returned identical descriptors/refusals. Six sequential warm pairs averaged approximately 781ms for cmdlets versus 647ms for .NET inspection on this machine (~17% lower); this is a measurement, not a guaranteed runtime improvement.

Only `Direct`, `Acl` and their four directory-type operands changed. Both methods use the same fixed Windows PowerShell binary. All allow-list, ancestor dangerous-rights, owner, protected-DACL, inherited/explicit rules, reparse, key-length and file-pin checks remain. Preparation uses the original `Get-ChildItem`, `Set-Acl` and original narrow rules for a **new empty owned child only**. No existing ACL or damaged key is repaired. Native deadline stays 5,000ms; HTTP tests stay 8,000ms. No process-wide or cross-request validation cache is introduced.

For an independent native comparison, run `node scripts/check-receipt-inspector-equivalence.mjs`. It reconstructs only the old inspection helper, roundtrips all other script bytes exactly, prepares one fresh fixture with the original production preparation path, compares read-only native results, and removes only its verified owned test paths. It does not launch providers, Studio, download binaries, change antivirus or modify the production source. Native comparisons are distinct from full workflow regression and real Studio/provider acceptance.

Microsoft references: [Directory.GetAccessControl](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.getaccesscontrol?view=netframework-4.8.1), [File.GetAttributes](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.getattributes?view=netframework-4.8.1).

The original failed broad release remains retained in `runtime/verification/desktop-pipeline-NQ2gPN`: 1,046 checks, 1,037 passed, six failed, one cancelled and two explicit skips. No new package was created by that run. Follow-up and current release results must be recorded separately; this comparison alone does not make that gate green.

## Follow-up

The seven exact failures from that broad run passed in the serial isolated follow-up `runtime/verification/receipt-regression-hwoHgy/verification.json`: 7/7, zero skips, 69,946ms, no source or emitted-test changes. This exercises actual HTTP and Windows receipt storage; native-provider observations remain synthetic. It does not replace the required full current regression/release gate.
