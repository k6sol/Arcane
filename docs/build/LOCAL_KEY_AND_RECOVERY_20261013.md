# User key handoff and plugin recovery

The human-requested API key was issued by the real local product daemon on
`http://127.0.0.1:45871`, not fabricated. A separate authenticated metadata read
confirmed the active key record. The key is read-only for `Workspace`; it grants
no publishing, uploads or edits. Its plaintext was delivered privately to the
requesting user, not saved in this document or a repository file. The retained
handoff at `runtime/user-key-session-20261013/handoff.json` contains metadata only.
The owned workbench process remains running for this connection. This browser
session is not the Electron encrypted vault; it cannot recover an externally
issued key's plaintext from the daemon's hash-only records.

The wrong-key fix is documented in [PLUGIN_KEY_RECOVERY.md](PLUGIN_KEY_RECOVERY.md).
Its focused regression passed 80/80 tests without skips, with 428 core logic
checks in both source and generated Luau VM fixtures. Official compilation and
generated artifact verification passed. These fixtures use labelled engine,
HTTP and GUI doubles; they do not assert that a human typed a wrong key in Studio.

The installed plugin checksum is
`cf48e479d3aa37f64be3062fe1cf957442e256db4262915293b53f22482f2b59`.
The preceding artifact was backed up at
`runtime/plugin-backups/41ef8353-c6ca-41b0-86f1-2d990dd310cd.rbxm`.
Only the explicitly authorized disposable Studio process was reloaded.
Native inventory subsequently reports that exact fixture in Edit under
`f9906dd3-f097-44a4-872f-e50f6506096f` and lists the installed local Arcane widget.
No native plugin pairing or edit/restore acceptance is claimed.

The initial read-only undo probe returned false; the later probe returned true.
That later observation was not used to veto the reload, so this run does **not**
establish preservation of arbitrary unsaved edits. Future reloads must inspect
the fresh observation before acting, rather than bundling the observation and
restart blindly. Hunted was not targeted. The post-reload GUI capture was
occluded by another foreground application and is not accepted as plugin UI proof.

Platform presentation is also simpler: Current key leads General, selector and
metadata sit in Key details, and technical controls stay in other Settings
sections. Key option labels are readable while internal UUID authority remains
unchanged. Chat chrome is quieter; one draft, model selection, keyboard focus,
explicit approvals and warnings remain. The actual browser was refreshed only
after confirming an empty draft and disconnected, disabled Send state.

This work does not certify a complete product or update the previous accepted
Windows executable. The broader source regression and new executable acceptance
remain separate gates. No additional paid model turn was run.
