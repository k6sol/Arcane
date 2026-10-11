---
name: arcane-open-cloud
description: "Integrate Roblox cloud operations with current endpoint capabilities, minimum scopes, ownership checks and async reconciliation."
license: MIT
---

# Open Cloud services and authorization

## Verify the endpoint contract
Identify operation, creator/resource, credential mode and current supported endpoint. Authentication support can vary by operation; do not assume an OAuth or API-key grant works everywhere. Keep identifiers explicit and use minimum permissions.

Store credentials in the protected runtime, not replicated scripts, renderer or logs. Handle expiry/revocation and resource denial with actionable status. A successful identity connection is not authorization for all group/universe operations.

Respect request limits and async operation IDs. Persist a chargeable/mutating operation before polling and reconcile unknown outcomes before retry. Read requests and uploads/deletions need different risk policies. Avoid arbitrary outbound URL access disguised as a documentation lookup.

## Verification
Use authorized test resources for success, wrong-owner, missing scope, expiry and interrupted operation cases. Check actual returned state and loadability where applicable. Do not publish, reset production data or create billable resources merely because the integration code can.
