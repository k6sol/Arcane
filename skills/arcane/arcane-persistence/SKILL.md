---
name: arcane-persistence
description: "Implement or diagnose Roblox save/load, session ownership and schema migration with explicit failure handling and protected test data."
license: MIT
---

# Player data and migrations

## Define safe ownership
Inspect existing storage and session-lock conventions before selecting a library. Document schema version, defaults, migration direction, write ownership and durable versus ephemeral fields. Keep live player data separate from disposable tests.

A failed load is not permission to overwrite an existing profile with defaults. Model loading, ready, failed/retrying and closing states explicitly. Make rewards and saves reconcile through durable state where a replay could duplicate value. Never rely on a last-minute shutdown call as the only persistence path.

Check current service budgets and failure semantics before designing retries. Use bounded retry/backoff and monitor unresolved saves; do not retry blindly forever. Yielding/storage calls do not belong inside deterministic update callbacks. Multi-key economic operations need a recovery protocol, not a false atomicity claim.

## Migrations
Migrate a copy/fixture first, preserve required fields and prevent accidental version downgrade. Retain backups and explain rollback limitations. Respect an established tested profile library rather than replacing it gratuitously.

## Verification
Test load failure, concurrent session/rejoin, repeated reward, write failure, shutdown and old-schema data. Verify no false saved badge and no regression to defaults. Production resets require a distinct request and scope.
