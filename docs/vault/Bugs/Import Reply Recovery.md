---
type: bug
project: Arcane
tags: [arcane, import, diagnostics]
---
# Import reply recovery

The file-import controller claimed that nothing changed whenever its native bridge rejected. That claim was unsupported: the desktop host may have already saved the asset before its response was lost.

The failure notice now shows Error421 and explains that the file-import outcome is unconfirmed. It directs the user to Choose an asset before importing the same files again. The controller neither retries the import nor exposes the bridge exception. A stopped controller cannot publish a late notice.

The regression uses actual headless Edge, the production page/import controller, desktop import host and daemon store. It deliberately loses the original reply after the host stores a real textured GLB. The original stored record remains, the notice has the readable number without private exception text, and the next explicit asset-list read finds the same record without another picker/import call. The regression first fails on the old false claim. All three browser import/model/effect journeys then pass without skips.

This is file-library and preview acceptance. It does not prove connected Studio import, Asset Manager upload, authenticated packaged customer behavior or a configured remote collector. No Studio operation or customer file is used.

[[Delivery/G06 Connected Import]] · [[Delivery/G08 Diagnostics]] · [[Architecture/Error References]]
