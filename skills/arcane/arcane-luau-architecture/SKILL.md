---
name: arcane-luau-architecture
description: "Implement typed, maintainable Roblox modules within existing project conventions; use for feature code or dependency-aware refactors."
license: MIT
---

# Luau architecture and refactoring

## Work with the existing system
Inspect entrypoints, initialization order, dependency direction and cleanup ownership. Preserve the project's framework, strictness and public interfaces unless migration is requested. A small feature should not acquire a service framework merely to look sophisticated.

Assign ownership explicitly: authoritative gameplay/data on the server, local input/camera/presentation on clients, genuinely shared definitions in shared modules. Keep secrets and exploitable decisions out of replicated code. Avoid require cycles and initialization that silently depends on arbitrary load timing.

Use types at module interfaces and state transitions. Validate external data at runtime; Luau annotations are not a network validator. Use lifecycle APIs suited to the project, with idempotent start/stop where repeatable rounds or UI reopens require them.

## Refactor without hidden damage
Inventory callers, serialized fields and remote contracts before changing an interface. Migrate deliberately and preserve compatibility where needed. Do not put expensive side effects in a module just because require caches its return value.

## Verification
Run type/static checks supported by the toolchain, then exercise actual feature behavior. Include repeated initialization/cleanup and dependency callers. Report absent live testing instead of inferring correctness from compilation.
