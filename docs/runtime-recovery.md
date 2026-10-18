# Local service recovery

If an adopted local runtime stops, Arcane immediately retires its control credential, tool handoffs and running Claude replies. It never resends a message, tool call, command or upload as part of recovery.

An abnormal exit after at least a minute of operation can trigger one automatic recovery attempt after a short backoff. Other attempts need a separate native confirmation. Choosing **Keep window open** leaves the current document available for reading and copying.

Before starting replacement services, Arcane requests a chat draft checkpoint from the exact current main frame. The request has a unique identifier and a ten-second deadline. Both chat providers must complete their native preference saves before the renderer acknowledges it. Queued Claude text returns to its draft without being sent; attachments still require attention before recovery can proceed. A failed or late checkpoint leaves the document in place.

The retained window can save presentation preferences for its original project after the runtime credential ends. This does not reopen the key vault, provider credentials or network/tool access. Moving between sections in the same document retains draft-saving access after Electron confirms the navigation; earlier asynchronous saves must recheck the updated preference epoch. Closing, loading another document, changing project ownership or replacing the frame retires that presentation scope.

Replacement services reuse the approved project, state directory and saved listener port. Arcane loads a hidden replacement window and retires the previous window only after the replacement loads with a live runtime, initializes chat and confirms its readiness. Failed loading, a staging renderer crash or the thirty-second loading deadline restores the previous window and its clipboard ownership. Closing the retained window honours the user's quit.

Returning to a page restored from browser cache reconnects its recovery controls and reads the current native service status. Earlier status replies, checkpoints, retry results and readiness signals cannot update the resumed page. Reconnecting does not replay a save or start a service; recovery still requires a fresh native checkpoint.

Automated coverage uses lifecycle, IPC, filesystem and provider doubles, plus real Edge rendering. Packaged startup and native runtime acceptance are separate evidence. This checkpoint covers chat drafts and model/tab preferences; unsaved edits in other tools and native customer/Studio workflows retain their own acceptance requirements.
