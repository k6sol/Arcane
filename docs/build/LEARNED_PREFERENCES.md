# Learned preferences

Arcane remembers feedback as local preferences, without changing model weights. Rate a result with the thumbs, review a generated model, or describe what should change in the next chat message. Model reviews and model-card ratings stay tied to the exact generation job. Starting an upload does not count as keeping or approving a model.

Open **Settings → Project memory → What Arcane has learned** to inspect the preferences, choose Prefer or Avoid, remove an item, turn learning off, or forget everything. Explicit tool arguments take precedence over learned defaults.

Preference records live in the owned project and user state directories. They contain parameter evidence rather than message text. A compact preference summary is included in chat context sent to the selected AI provider. The tool server reads bounded defaults for supported scene, lighting and model options and can boost relevant existing skills; it cannot submit feedback or edit preferences with its agent credential.

Claude and Arcane Credits can associate generated-model feedback with procedural tool inputs observed in this window. ChatGPT feedback currently uses successful saved Studio commands joined to exact live Arcane thread, turn and item identities. Its public procedural records do not expose the complete generator arguments, so those records do not teach model preferences. Unknown, conflicting or expired job mappings require a refreshed matching preview rather than falling back to another model.

The feature has per-project and shared preference layers, bounded context, decaying evidence and an off switch. It does not start builds, upload assets or grant tool permissions.
