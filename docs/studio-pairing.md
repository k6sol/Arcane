# Studio pairing

Connecting Roblox Studio to Arcane takes three steps: a click in Arcane, the code typed into Studio, and an Approve click back in Arcane. Nothing is copied or pasted except the 6-digit code you can read on screen.

1. In Arcane, click **Connect Studio**. You can do this from the setup checklist, from the Studio plugin card in Settings, or from the Connect Studio step. Installing or updating the plugin also does this. Arcane then shows `Waiting for Studio… In Roblox Studio, type 042 718 into the Arcane plugin and click Connect.`
2. In Studio, open the Arcane plugin, type that code into the field (with or without the space) and click **Connect**. The plugin checks that the Arcane answering it really knows the code, then shows **Approve in Arcane…**.
3. Arcane shows `Roblox Studio place "<name>" (place <id>) wants to connect.` Check that it is your place and that Studio says **Approve in Arcane…**, then click **Approve**. Click **Deny** if it is not. The plugin turns green.

If Arcane is not waiting, the plugin shows `Arcane is not waiting for Studio…`. Click **Connect Studio** in Arcane and try again. If the code is wrong, or another program answered instead of Arcane, the plugin shows `That code does not match the Arcane window that answered…` and sends nothing else.

After the first pairing, the plugin remembers its local key and reconnects automatically when Studio reopens. Opening or closing the toolbar panel does not disconnect it. A fresh installation makes no pairing request until you click **Connect** with a code; an empty field only asks for that code.

When pairing succeeds, Arcane shows the place that connected (`Connected to <place> (place <id>). Not you? Revoke it.`).

The API key flow still works as a fallback. Choose **Use API key** or **Generate API key**, then paste the key into the plugin.

## How it works

| Step | Who | What |
| --- | --- | --- |
| Offer | Arcane UI → daemon `POST /v1/studio/pairing-offer` (control token only) | The daemon creates one offer in memory. It has a 192-bit ticket (`arcane_pair_v1_<port>_<48 hex>`), a 6-digit code shown only in Arcane, and a 10-minute expiry. It is bound to this daemon's loopback port and project. A newer offer cancels the older one. A daemon restart drops it. |
| Discovery | Plugin → `POST http://127.0.0.1:45870/v1/pairing/discover` (after the Connect click, once) | The daemon listens on this fixed port only while an offer is pending and not yet challenged. The reply has the daemon port, the ticket and the expiry. It never contains the code. |
| Arcane proves the code | Plugin → daemon `POST /v1/plugin/pairing/challenge` `{ticket, clientNonce}` | The plugin sends a fresh 128-bit nonce. The daemon answers `HMAC-SHA256(code, "arcane-pair-v2\|arcane\|" + ticket + "\|" + nonce)`. The plugin compares it with its own HMAC of the typed code. On a mismatch it stops and sends nothing else. An offer accepts exactly one challenge. A second challenge burns it, and discovery closes after the first. |
| Plugin proves the code | Plugin → daemon `POST /v1/plugin/pairing/claim` `{ticket, clientNonce, proof, identity, capabilities}` | `proof = HMAC-SHA256(code, "arcane-pair-v2\|plugin\|" + ticket + "\|" + nonce)`. A wrong proof, a missing challenge or an invalid identity burns the offer. The first valid claim records the place and returns `{state: "awaiting-approval"}`. No key exists yet. |
| Approve | Arcane UI → daemon `POST /v1/studio/pairing-offer/decide` `{offerId, approve}` (control token only) | Arcane shows the asking place's name and ID. **Approve** marks the request approved. **Deny** cancels the offer. |
| Issue | Plugin repeats the same claim every 2 seconds | While the user decides, the identical claim (same nonce, proof and pinned identity) gets `awaiting-approval` back. A changed identity burns the offer. After Approve, the next claim burns the ticket, issues a normal long-lived Arcane key for the offer's grants and opens a session. Both go back to the plugin once. |
| Persist | Plugin | The key is saved in the plugin's own `Arcane_LocalApiKey_v2` setting, exactly like a pasted key. Writes are checked by reading them back, with bounded retries on the existing worker. The typed code is cleared from the field at once and never saved. |

Pairing survives restarts because it reuses the existing key recovery:

- **Arcane restarts:** each project keeps its saved port, so the key stays valid. The plugin's status-first recovery reconnects after the daemon revokes old sessions at startup.
- **Studio restarts:** the plugin reads the saved key and reconnects automatically.

Existing keys migrate from the older dotted setting names to underscore names.
An empty current key is a deliberate removal and cannot restore an older key.
Temporary settings read failures get bounded retries before migration; storage
failures show an amber notice. These checks retain the original session identity
and command fences. See [plugin key recovery](build/PLUGIN_KEY_RECOVERY.md).

## Threat model

**Protected assets.** The long-lived Arcane key and the session bearer. Together they let a holder act as the Studio plugin: it receives queued commands and returns receipts. In the other direction, the plugin's trust in "Arcane": whoever the plugin pairs with can send it Studio commands.

**Threats addressed**

- **Discovery-port squatting (impersonating Arcane).** Another local process can bind `127.0.0.1:45870` before Arcane does, or while Arcane is not waiting, and answer discovery with its own port and ticket. It cannot pass the challenge. The code is shown only in Arcane's window and is never served by discovery or any route, and the plugin reveals nothing derived from the code until the daemon has proved it. A squatter therefore has one blind guess per attempt (1 in 1,000,000), and the plugin refuses it visibly. If the real Arcane cannot bind the port, it reports `unavailable` and suggests the API key.
- **Claim racing (impersonating the plugin).** A process that reads discovery while an offer is pending gets the ticket, but not the code.
  - It cannot claim without first challenging.
  - If it challenges first, it gets an HMAC it could brute-force offline (6 digits). Its challenge also uses up the offer's only challenge, so the real plugin's challenge fails and burns the offer. Any later claim then fails.
  - If it challenges after the plugin, the offer is burned.
  - In every case, no key is issued until a human clicks **Approve** in Arcane, which names the asking place. Studio's own **Approve in Arcane…** must be showing at the same time.
- **Human intent in Arcane.** Only the launcher control token can create, read, cancel or decide an offer. Agent (MCP) bearers get `403`. Without a click in Arcane there is no offer, and the discovery port is closed.
- **Short-lived, single use.** The offer lasts 10 minutes, and an approval never outlives it. The ticket is cleared on issue, cancel, Deny, expiry, replacement, any wrong proof or a second challenge. Replays fail.
- **Bound scope.** The ticket embeds the daemon port. Challenge and claim must reach that port and match the offer's project. They share the plugin pairing rate limit of 30 per minute.
- **Loopback and non-browser only.** Both listeners bind `127.0.0.1` and check the peer address. Discovery refuses requests that:
  - carry any `Origin` header (browsers always send one on a cross-origin POST);
  - use a `Host` other than `127.0.0.1:45870` (blocks DNS rebinding);
  - use anything other than a `POST` with `application/json`, which forces a CORS preflight that is never approved.

  The challenge and claim routes also refuse a foreign `Origin`.
- **Secrets stay out of the UI and logs.** The renderer sees only the code, the asking place, and after the issue the place name and ID plus the key ID. Event records carry no code, ticket, proof or key. The installer treats ticket-shaped text as a credential and never writes one into a plugin file.
- **User presence in Studio.** The plugin never polls discovery. Each **Connect** click with a code makes at most one discovery read and one challenge, then repeats only the same claim until it is approved, denied or expired. A saved key can recover its own connection automatically; the toolbar does not initiate pairing.
- **After-the-fact check.** Arcane shows which place connected and offers **Revoke**. Revoking the key also revokes its sessions.

**Residual risk.**

- The approval UI is part of the workspace renderer, which holds the same control token. Authority-granting desktop prompts, such as tool consent, plugin install and enabling auto-approve, use the separate trusted Arcane window instead (`apps/desktop/electron/trusted-dialog.cjs`).
- A process that wins the challenge race can learn the code offline. It still needs the user's **Approve** for a place it names, while the user's own Studio shows a failure rather than **Approve in Arcane…**.
- A process running as the same Windows user can already read Arcane's local state, so it is out of scope, as it is for the API key flow.

**Fallbacks.**

- Another Arcane project may already hold the discovery port, or another app may be using it. In that case the offer reports `unavailable` and Arcane suggests the API key.
- If a saved key's daemon is unreachable, the plugin keeps its existing saved-key recovery and does not look for offers. To pair again, type a fresh code and click **Connect**.
