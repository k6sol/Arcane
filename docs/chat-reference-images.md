# PNG references in human Send

Use the composer's attachment picker to select PNG references alongside supported
text files. Each reference shows a removable thumbnail. The first Send from a new
draft carries the selected images through that draft's owned native chat setup.
Changing the draft, clearing attachments, stopping, or changing project during
setup prevents the captured message from being sent.

The picker accepts up to four files in total. PNG references must be nonanimated
8-bit RGB or RGBA, total at most 512 KiB and 8,000,000 pixels, and measure at most
4,096 pixels on either side. Text attachments retain their separate 64 KiB limit;
the prepared caption and quoted text together must fit 128 KiB. JSON escaping and
the complete native envelope also count toward request limits. A message that is
too large is refused before creating a chat, retaining the caption and selected
files. Arcane does not resize or silently omit a reference. Export a smaller PNG
when a limit is reached. JPEG and other image formats are not supported here.

References enter only the initial human `turn/start` as inline PNG data URLs.
They cannot provide local paths, remote URLs, uploaded file IDs, tool permissions,
or new images on automatic repair. The existing private repair continuation is
text-only and stays bound to its original task. The actual fresh native client's
reported model catalogue must allow image input. Older catalogues without
`inputModalities` use the documented text/image compatibility default; this is
not a claim that inference or a model entitlement was verified.

Arcane keeps selected image bytes and blob previews in memory and disposes of
previews when references are removed, cleared, invalidated, or sent. Its action
journal stores only reference names, byte counts, dimensions and SHA-256 hashes,
plus the existing request hash. It does not stage images on disk or put data URLs
in transcript text or public native event/history projections. The native Codex
client owns any persistence of the submitted image in its own conversation
history. Arcane's text history marks non-text content as an omission rather than
claiming that the image has been reconstructed or deleted from native history.
Lifecycle resume requests metadata with the supported `excludeTurns: true`, so
accumulated image history does not fill its native frame. Active status without
an exact active-turn identity remains unknown and cannot authorize another Send.
Explicit history loading uses a separate bounded process; an oversized response
is refused without killing the live task client. Such a refusal does not provide
a complete text or image history. The existing frame/read limits are unchanged.
An exact, durably recorded terminal `FRAME_LIMIT` rejection of the outgoing
history read can allow explicit navigation to another owned conversation after
fresh scope and all ordinary navigation blockers are checked again. Arcane keeps
the previous recording and unsent draft and displays a history-limit notice;
it does not label that read successful. Pending, unknown, lost, stale or other
rejected reads still block navigation. This exception applies only to the
outgoing history read; connection and other lifecycle actions still require
acknowledgement. Background task ownership remains with its original client.

The dedicated human-only reference route preserves Host, Origin and control-token
checks before reading its bounded body. Ordinary text action requests keep their
existing body limit. The native JSONL frame remains bounded at 1 MiB, including
text escaping and base64. Image metadata in the response must match the original
submitted bytes, dimensions and order; a mismatched acknowledgement remains
uncertain and is never retried automatically.

Protocol support is grounded in the installed Codex version
`0.162.0-alpha.17.2`: its
[actual app-server test](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/app-server/tests/suite/v2/turn_start.rs)
submits an inline `data:image/png;base64,` image and verifies the same image reaches
the mock model request. The
[V2 input conversion](https://github.com/openai/codex/blob/740e5af33c71225640e0c1c1555c514c2c93ab74/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)
maps that URL directly into the image input. The official
[app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes image input and the missing-modality compatibility default.

Offline integration uses synthetic valid PNGs, actual bounded Node JSONL peers,
the production service and HTTP route, and the compiled browser composer. It does
not exercise installed providers, model inference, Studio import, reconstruction,
or native image acceptance.
