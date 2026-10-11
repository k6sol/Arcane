---
name: arcane-release
description: "Prepare Roblox releases with tested migrations, permissions, rollback boundaries and explicit publication authorization."
license: MIT
---

# Safe release and deployment

## Release a verified revision
Identify target place/universe, creator, audience and exact source/assets. Separate a local save, staging release and production publication. Existing Studio access is not blanket permission to publish all places.

Run relevant feature/regression tests and review data/asset compatibility. Version flags and migrations explicitly. Make rollback boundaries truthful: restoring source may not reverse player transactions or already-migrated data. Keep prior release artifacts and a concrete recovery path.

Review runtime asset permissions, secrets, required policies, loading/error states and device readiness. Preserve user/manual changes in Git. Do not build marketing or monetization claims on untested features.

## Verification
Use an authorized staging environment for start/join/rejoin/upgrade scenarios. Check feature flags, late-loading assets and migration compatibility. Record what was tested, what was published and by which authorization. A CI build passing does not alone prove the live experience works.
