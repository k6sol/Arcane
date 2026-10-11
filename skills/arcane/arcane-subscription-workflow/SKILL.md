---
name: arcane-subscription-workflow
description: "Choose a supported AI client or authorized plan connection for Arcane work while respecting subscription limits and separate API billing."
license: MIT
---

# Subscription-aware agent workflow

## Preserve the user's access choice
Inspect the configured mode: external MCP client, supported direct plan connection, personal API or managed inference. Do not treat a consumer subscription as a generic API key. Use [subscription architecture](../../../docs/SUBSCRIPTION_WORKFLOW.md) for current verified routes and eligibility checks.

External clients retain their own authentication, model selection and subscription usage. Arcane supplies scoped tools, relevant skills and artifacts; it does not claim control over the client's internal reasoning or unreported quota. Supported plan integration uses the app's own authorized connection, never credentials scraped from another app.

Keep personal-API fallback opt-in because it can change the bill. Preserve an explicitly requested model/effort; recommend a different one only with clear trade-offs. Limits are account/provider constraints, not an obstacle to bypass with credential rotation or parallel accounts.

## Verification
A mode label must match the actual authenticated path and reported usage. Pause on limits; preserve task checkpoints and explain continuation options without repeated chargeable retries. Token/byte savings are measured separately from completed-task quality.
