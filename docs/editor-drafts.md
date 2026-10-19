# Editor draft records

The desktop `toolDrafts` bridge stores presentation drafts for project memory and replacement script source. Each entry retains exact text, its original baseline and opaque display/target context. Reading a record does not save a project file, resolve a target or execute a command.

Records use Windows safeStorage encryption in a separate per-project `tool-drafts.v1.json` file. The encrypted payload binds the host-selected project identity and the `tools` record type. Chat records cannot be substituted for editor records. The same pinned-path, atomic-write and exact-frame checks used by chat preferences protect reads and saves, including presentation-only access while local services are stopped. Encryption has no plaintext fallback.

A snapshot contains at most 16 entries and 511 KiB of serialized presentation data. Project-memory text and baseline each allow 16 KiB; script text and baseline each allow 100 KiB. IDs and target contexts must be unique. Oversized or malformed records are rejected without truncation or replacement of the previous record. API-key, sign-in and payment fields are not accepted draft kinds.

Renderer integration must preserve a dirty buffer until native storage acknowledges its save. Restoring a draft must retain its original baseline and target context, require an explicit file save or command submission, and preserve the draft when the current target differs. Clearing stored drafts uses an acknowledged empty collection. Native storage coverage does not by itself prove editor restoration or a complete customer recovery workflow.
