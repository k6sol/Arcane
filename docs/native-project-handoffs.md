# Native project handoffs

Claude also runs directly in Arcane's chat, in the same conversation surface as ChatGPT. The terminal handoff described here is an optional extra for people who want Claude Code's own terminal.

Arcane can open Claude Code in a native Windows terminal with its project tools configured. Claude Code owns authentication, model access, billing and permission prompts. The desktop conversation continues to use its selected connection.

In General settings, select Claude Code and check sign-in status. Arcane reads the installed CLI's version, authentication status and help metadata. In Connections, choose a model and effort under **Claude Code project tools**, then select **Open with Arcane tools**. Both choices start empty. The native confirmation shows the selected CLI version, model, effort and project.

Help metadata describes CLI aliases; the native terminal confirms account access to a model. Trusted choices expire after 60 seconds. Check status again to read fresh choices. Arcane does not renew them automatically.

The handoff config contains one Arcane MCP server. A temporary project credential reaches the terminal through its launch environment. The config file contains environment placeholders. The terminal can read its credential; the desktop renderer receives only status metadata. The credential expires after 30 minutes and permits work coordination and Studio commands within existing grants. Human review, pairing, keys, provider controls and asset-worker administration remain human operations.

**Terminal opened** records the launcher's acknowledgement and the daemon's seal receipt. Check the native terminal to confirm its Arcane tools connected. An uncertain launch or seal acknowledgement is recorded as unknown. Arcane attempts revocation of a known handoff and keeps the outcome explicit; it never repeats a begin or launch to recover an acknowledgement.

Use **Check handoffs** to read this project's recorded handoffs. **Revoke** retires the selected credential and removes configuration that Arcane still owns unchanged. Modified files are retained. Project switches and desktop shutdown retire the old project's authority. Open terminals remain under the user's control.

The current verification covers real local HTTP and project stores, the broker and file preparer, executed main-process boundaries, browser controls and synthetic launch-environment inheritance. Native CLI connection, installed-provider inference and Studio delivery require their own acceptance evidence. Portable executable checks run with provider setup disabled.
