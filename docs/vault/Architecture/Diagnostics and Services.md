---
type: reference
project: Arcane
tags: [arcane]
---
# Diagnostics and services

Every failure should identify component, stage, error category, relevant safe identifiers and the next repair action. Correlate message details, job events and bounded reports. Preserve original causes instead of replacing them with job IDs or a secondary logging fault.

The central-report service needs a configured endpoint, authorization, redaction and idempotent offline retry. Prepared code is not a deployed service. Accounts, admin and billing need server-side authorization and genuine provider configuration, separate from local development tools.

[[Delivery/G08 Diagnostics]] · [[Delivery/G09 Accounts and Billing]]
