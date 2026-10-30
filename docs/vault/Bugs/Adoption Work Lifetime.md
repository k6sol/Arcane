---
type: bug
project: Arcane
tags: [arcane, assets, lifetimes]
---
# Adoption work lifetime

Status: implementation prepared for validation; customer/native acceptance unverified.
Related goals: [[Delivery/G04 Task Lifetimes]], [[Delivery/G06 Connected Import]].

## Problem

Project GLB adoption did not acquire the original native work lease. Task retirement could therefore lose track of file reads, publication, attribution or final persistence still in progress.

## Implementation

The conversation host acquires the lease before calling the service. The service checks the genuine issuing lease and exact operation signal before reading or creating files. Original file, publication and commit tails stay within the same lease.

A failed copy with exact attribution and successfully persisted failure records can close normally. Unknown publication, lost creation acknowledgement, changed ownership or failed persistence remains unresolved, with no automatic replay. Original thrown admission errors, including `undefined`, remain distinct from uncertain creation.

## Acceptance

- [x] Original host/service lease registration and identity checks implemented.
- [x] Existing test declarations retained; focused held-I/O and error scenarios authored.
- [ ] Hosted type checking and actual controlled fixtures pass.
- [ ] Review Stop after registry shutdown, lost publication ACK and sticky persistence failure results.
- [ ] Trace a packaged customer import separately from controlled file/SQLite fixtures.

No worker is invented for file adoption; no native Blender, provider or Studio acceptance is implied. Normal task retirement and archival completion remain separate work.
