---
name: arcane-open-cloud
description: "Design and integrate Roblox Open Cloud operations with verified endpoint/auth contracts, resource ownership, durable unknown-outcome handling and scoped credentials."
license: MIT
---

# Integrate a specific cloud operation end to end

## Verify the actual operation contract
Identify the user-visible goal, resource/creator, endpoint, credential mode and response lifecycle. Engine services and Open Cloud HTTP APIs are different surfaces. Verify the current official endpoint/schema and supported authorization when execution is available; a remembered API or successful login is not proof of resource access. If lookup/network access is unavailable, leave that dependency explicit rather than inventing an endpoint.

Define typed request/response validation, allowed resource IDs, payload/response bounds, timeout and fixed failure categories. Resolve ownership and permission for the actual universe/place/group before mutation. Use minimum scopes, protected runtime credential storage and explicit expiry/revocation handling. Never place secrets in client scripts, renderer data, logs or a repository.

## Separate reads, mutations and asynchronous work
Read-only discovery may be retried under bounded backoff. Uploads, publication, data changes and billable work need an original operation identity and the platform's actual idempotence/reconciliation semantics. Persist an admitted operation before dispatch where required, then track the returned operation ID and terminal state. A timed-out POST is unknown, not permission to send it again.

Handle throttling and retry guidance without synchronized bursts. Bound polling and preserve a resumable pending state; distinguish request acceptance from the asset/data becoming usable. Validate the actual created resource and its permissions/loadability before reporting completion. Do not label a locally generated file as uploaded or a published place as playable based solely on an HTTP success.

## Keep capability and authority visible
Arcane's paired Studio tools do not automatically provide arbitrary cloud HTTP, asset upload or publishing. Use only an available authorized host route; never hide arbitrary URL fetching in a documentation or asset operation. Creator Store availability and a cloud credential are not interchangeable permissions.

For a player-facing integration, specify unavailable/processing/failed UI and reconciliation after a session ends. Keep the operation's durable state in its trusted owner, not a browser spinner or a client-supplied operation ID. A server restart must not duplicate an unresolved mutation.

## Acceptance on authorized test resources
Cover correct resource, wrong owner, missing scope, expired/revoked credential, malformed response, throttling and interrupted asynchronous work. Confirm the exact returned resource and a usable result where relevant. Distinguish mocked protocol checks from real API acceptance. Do not publish, reset data, purchase or create billable resources merely to validate integration code; those effects need their actual requested scope.
