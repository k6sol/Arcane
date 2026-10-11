---
name: arcane-performance
description: "Measure and improve Roblox client/server performance, streaming and resource lifecycle on representative workloads."
license: MIT
---

# Performance, streaming and resource budgets

## Measure the relevant workload
Record device/runtime, scene, player count and a baseline before changing code or geometry. Separate CPU, GPU, network and memory symptoms. Static instance/triangle counts are clues, not proof of a bottleneck or a universal engine limit.

Find hot paths, unbounded loops, fanout, retained connections, repeated allocations and unnecessary work. Reduce measured cost while preserving semantics. Do not replace readable code with obscure micro-optimizations without evidence.

Streaming-aware clients tolerate absent/removed objects, bounded waits and changing dependencies. Server authority cannot depend on a client having every distant model loaded. Define per-asset/scene budgets from target devices and actual imports rather than copying Hunted's quality settings.

## Verification
Repeat the same workload after each meaningful change. Track frame distribution, server work, memory growth and replication where tools support them. Test long sessions, round restarts and high-load scenes. A desktop success or lower triangle count alone does not prove mobile readiness. Keep unsupported profiling claims explicit.
