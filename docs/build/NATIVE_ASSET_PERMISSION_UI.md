# Native chat asset permission UI

The existing native conversation settings contain an “Asset jobs” fieldset
with **Allow asset jobs** and **Revoke asset jobs** buttons and a polite live
status. It uses the current charcoal/red controls, a visible legend, descriptive
text and wrapping 44px buttons. The main conversation is unchanged.

## Host contract

Optional state.nativeAssets is either absent/null (unsupported) or exactly:

    { available: boolean, sealed: boolean, granted: boolean, admissionOpen: boolean }

Unavailable capabilities report all flags false. Granted permission requires both available and sealed; open admission also requires the explicit asset grant.
Unknown members, inherited shapes, getters, hidden/symbol properties and
nonboolean values are rejected without evaluating getters. Null is normalized to an omitted capability in the controller. Existing states
without this capability continue to work.

The only new human action envelopes are:

    { requestId: UUID, connectionId: UUID, action: 'grant-assets', threadId: opaqueID }
    { requestId: UUID, connectionId: UUID, action: 'revoke-assets', threadId: opaqueID }

The controller takes the connection and configured thread from live state,
never from DOM identity fields or a new store. Action fields and receipts are
exact data objects. Asset receipts must match the request UUID, connection,
action and thread. No credential, actor or authority assertions are accepted
in the permission shape, action fields or receipts. UI action and receipt types follow the parent service contract.

The parent service owns authentication, durable journaling, permission policy
and admission changes. These controls use the existing human native action
endpoint. They call no native RPC, Studio grant, asset probe or asset start API.
Allowing permission does not create a job, submit a model turn or clear a draft.

## Activation and scope

Grant requires a fresh supported, available, sealed capability, an idle
configured live thread, and the existing shared normal-action oneflight.
Unsupported/unconfigured/disconnected/closing/connecting, limited displays,
unknown turn state, pending actions and unresolved acknowledgements block it.
Opening settings, polling, starting/resuming the controller and changing
context never grants permission.

Native buttons provide trusted click and Enter/Space activation; scripted
clicks, modified clicks and repeated/modified keyboard activation are refused.
Pointer/keyboard gestures bind the controller generation and exact observed
project/connection/thread/session/configuration. Context changes or reconnect
invalidate that gesture and delayed action replies through the controller's
existing generation fence. Current identity is rechecked before dispatch.

Revoke stays available while ordinary turn actions or a grant are in flight,
provided a fresh supported configured live scope is known. Repeated revoke
is deduplicated in the same pending-action map. Revoke increments the safety
generation, so an older grant/turn acknowledgement cannot restore the previous
permission display. Unknown/lost receipts retain their request IDs and never
retry automatically.

Workspace file writes, Studio access and native asset permission are separate.
The workspace-write confirmation checkbox is not used for asset permission.
Revoking closes asset job admission; it does not claim to cancel, undo or
complete existing jobs. Status reports granted permission and open/closed
admission separately, including granted permission with closed admission.

## Validation and limits

The unit suite uses the real bounded JSON API/parser with a private transport
and an owned fake document. It covers read-only/grant/revoke, both keyboard
activations, malformed/getter/unsupported states, exact envelopes/receipts,
trusted/stale activation, reconnect/context changes, shared oneflight and
safety races, lost acknowledgements, draft preservation and absence of job API
actions. Fake trusted-shaped listener events are explicitly fixtures; real
untrusted Event instances are separately rejected.

Compile into an owned temporary directory with the repository's compiler
options and explicit source files, then run the emitted
tests/unit/codex-asset-permission-ui.test.js (and existing codex-chat-ui.test.js)
using node --test. Set ARCANE_UI_BUILD_DIR to that temporary output for the
existing suite. Do not run the root build or write root dist.

Backend authentication/admission behavior and installed native clients are
outside this UI-only change. No installed Codex, Claude or Studio, AV/ACL/Git
changes or root compile/dist are required. Browser fixture verification, when
used, must use an owned Edge context with fake transport only.
