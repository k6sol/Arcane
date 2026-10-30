---
type: bug
project: Arcane
tags: [arcane, diagnostics, import]
---
# Studio staging diagnostics

Goal: [[Delivery/G08 Diagnostics]]. Related: [[Bugs/PBR Staging Boundary]], [[Delivery/G06 Connected Import]].

## Customer outcome

A continuity refusal during Studio staging identifies the operation phase and the observed reason. An uncertain response remains unconfirmed and cannot imply a successful import or an automatically retryable operation.

## Implementation

The original staging controller supplies a private branded failure with a closed descriptor: previous-attempt check, target check, admission, packet enqueue, packet receipt or final seal check. Reasons distinguish a missing connection check, changed plugin connection/artifact/edit epoch, non-Edit mode, disconnection, unsupported continuity and an expired connection check. Packet ordinals are bounded and exist only for packet phases.

The actual native route preserves these details only for a genuine controller error. The MCP client retains its unknown outcome, nonterminal/ambiguous state and no-retry policy. The shared Codex/Claude history renderer shows a finite reason and unconfirmed status without success facts. The browser decoder uses type-only shared imports so existing standalone browser surfaces gain no runtime module requests.

After the controller has rejected and completed cleanup, the route also invokes the existing bounded product reporter. Only finite phase/reason/ordinal context reaches the established report schema and encrypted local outbox. Reporter failure cannot replace the original request outcome. No raw exception, model text, credential, native identity or path is added to reports.

## Acceptance

- [ ] Exact published source compiles and the full applicable hosted inventory passes.
- [ ] Actual controller refusal reaches route, MCP unknown result and both providers' loaded message details.
- [ ] Invalid or forged descriptors remain generic and cannot claim a retry or successful import.
- [ ] Reporter and encrypted outbox preserve acknowledgement/failure boundaries and redact private fields.
- [ ] A configured remote collector receives and exposes the report under verified access controls.
- [ ] Authenticated packaged customer reproduction is verified.

Source and fixtures are prepared for publication. No local runtime or Studio execution is implied. The controlled collector tests do not configure a hosted service, account or endpoint. The underlying historical packet-loop timing cause remains unproved; this change makes a future refusal explainable without changing its limits.

[[Operations/Current State]] · [[Operations/Evidence Ledger]]
