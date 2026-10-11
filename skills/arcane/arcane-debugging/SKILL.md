---
name: arcane-debugging
description: "Diagnose Roblox errors and behavioral failures with scoped hypotheses, minimal patches and repeatable evidence."
license: MIT
---

# Repro-driven debugging

## Establish the failure
Read the actual Output trace, source revision, execution context and reproduction steps. Reduce the failing interaction without changing its essential condition. When reproduction is unavailable, identify the evidence gap and keep a proposed fix unverified.

Choose a small set of plausible causes proportional to the issue; an obvious syntax mistake does not need an elaborate theory document. Use targeted logs/assertions or measured state to distinguish causes. Instrumentation must be bounded and removed or disabled after diagnosis.

Patch the cause within scope rather than rewriting the system to hide it. Inspect callers and adjacent states affected by the change. Preserve the first failure evidence and do not change the test's success condition to obtain a green result.

## Verification
Rerun the original reproducer and relevant regression cases at the changed revision. Include cleanup, respawn or repeated use when the failure involves lifecycle. Stop a repair loop when the same attempt repeats without new evidence; return what was inspected, changed and still unknown.
