---
type: evidence
project: Arcane
tags: [arcane]
---
# Evidence ledger

## Recorded baseline

| Claim | Evidence | What it proves |
|---|---|---|
| Main is signed | [Commit 7e52f67](https://github.com/k6sol/Arcane/commit/7e52f67546fb5409c41dd9f2bc9376fc33c15e9c) | GitHub-verified SSH source commit |
| Seven jobs passed | [Run 40621420963](https://github.com/k6sol/Arcane/actions/runs/40621420963) | Windows/Linux components and isolated Windows packaged startup |
| Same revision passed earlier | [Run 40618732969](https://github.com/k6sol/Arcane/actions/runs/40618732969) | Additional hosted validation; not additional product scope |

## Still missing

30 October update: [run 40975403615](https://github.com/k6sol/Arcane/actions/runs/40975403615) on the knowledge commit has one Windows test cancellation, not an assertion failure. [[Bugs/Converted Import Timeout]] records the exact fixture and proposed correction. Installed release fingerprints are now inspected in [[Operations/Current State]], but exact source attribution and customer execution remain outstanding.

- Installed app/plugin revision matching the intended release.
- Authenticated customer send/reopen/update and complete production workflow.
- Native Studio rendering, upload, placement and gameplay acceptance; this agent must not operate Studio.
- Configured and verified commercial hosting/auth/payment services.

## Evidence levels

`Proposed → Implemented → Controlled test → Packaged smoke → Authenticated customer → Native engine acceptance`

Record the level explicitly. These levels describe different claims; a later-looking label cannot substitute for missing evidence. Use [[Templates/Evidence]] and [[Playbooks/Release Verification]].
