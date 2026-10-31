---
type: architecture
project: Arcane
tags: [arcane, diagnostics, chat]
---
# Error references

Arcane error numbers identify a failure category across jobs and conversations. They are product references, not HTTP status codes. The source catalogue is `apps/desktop/src/user-errors.ts`.

Show the number and a plain explanation first. Keep original request IDs, native codes and recorded outcomes in Technical details so support can correlate the report without making an ID the explanation. Never infer a successful result from an error number or retry an unconfirmed operation automatically.

| Error | Meaning | Next step |
|---|---|---|
| 411 | A local ChatGPT connection message exceeded its size limit | Check the original recorded outcome; do not resend automatically |
| 412 | Earlier tasks have unconfirmed outcomes | Inspect their recovery records; signing in again does not settle them |
| 413 | A usable provider account is not confirmed | Complete provider sign-in |
| 414 | Sign-in completion was not confirmed | Check status before starting another login |
| 415 | The required connection is unavailable | Check the selected provider and connection |
| 416 | The workspace or connection changed | Return to the intended current workspace |
| 421 | A request outcome is unconfirmed | Review the original request before resending |
| 422 | An operation timed out | Check outcome and cleanup before retrying |
| 423 | Required local records could not be saved or verified | Keep unsent work open and check storage |
| 431 | Model generation failed | Read the actual failing stage and reason |
| 432 | Mesh validation failed | Inspect and correct failed geometry checks |
| 433 | Material validation failed | Inspect the shader, links and PBR checks |
| 434 | Texture generation failed | Read the texture-stage report |
| 435 | Export or round-trip verification failed | Inspect the export before importing |
| 436 | Studio import is unconfirmed | Check the recorded import phase; placement does not prove upload |
| 437 | Preview could not be opened or verified | Inspect the model export and validation report |
| 438 | A required permission is missing | Review permission for the exact task |
| 499 | No more specific verified failure category is available | Read the actual operation details and recorded outcome |

Browser sign-in and native workspace connection are separate outcomes. Connect Codex must invoke the supported provider login directly, reuse verified saved authentication when available, and never fall back to Settings. A verified account must not be called signed out because an older task prevents workspace connection.

Global recovery notices belong outside the scrolling page layout. Expanding their explanations must leave the sign-in controls in place. Login status uses a reserved scrollable area so a longer failure message does not move the action.

[[Delivery/G02 Reliable Chat]] · [[Delivery/G08 Diagnostics]] · [[Operations/Current State]]
