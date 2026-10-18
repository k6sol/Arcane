# Claude chat preferences

The desktop app retains Claude tab drafts, the active tab, and each tab's model and reasoning choice in a separate encrypted local record. A new chat starts with the last selected choice. Opening a saved tab does not send a message or grant tool access.

Drafts are saved through the native Windows vault, scoped to the current project. The record is separate from ChatGPT preferences. Raw draft text is not written to browser storage, and there is no unencrypted fallback. Existing browser preferences can still supply tab identifiers and model hints.

Update preparation waits for an exact native save acknowledgement. A failed save keeps the text in the current window and blocks the restart; retry after the storage problem is resolved. Attachments and running turns must still be handled before updating. Automatic recovery after a stopped local service is a separate lifecycle concern.

A fresh renderer restores drafts before accepting input. If an incoming provider handoff or a failed-read retry encounters newer text, both drafts are retained. A previously selected model or reasoning choice that is no longer reported remains explicit; choose an available option before sending.

Validation covers encrypted host records, frame/project ownership, independent provider saves, serial save races, late reads, failed acknowledgements and real Edge rendering with fresh browser contexts. Browser tests use explicit native and provider doubles and start no inference. Full installed-provider and customer workflow acceptance remains separate.
