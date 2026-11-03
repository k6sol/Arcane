---
type: bug
project: Arcane
tags: [arcane, blender, conversion]
---
# Windows conversion paths

The retained logging-game models failed before import. An isolated conversion of the original oak reproduced the export failure on installed Blender 4.5.3 in 8.1 seconds. The optional operator observer reported CONVERSION_OPERATOR_OBSERVER_VERSION; that diagnostic did not establish that this Blender version was unsupported.

The conversion worker passed Windows extended paths directly to Blender, while generation already adapted those paths. Conversion now applies the same existing adapter at import, export, render, save and reopen. Short native spellings retain the identical owned directory; longer paths require an existing verified directory alias. No alias is created, custody checks are retained and unsupported paths fail explicitly.

With unchanged source bytes, the oak completed export, scene reopen, roundtrip fidelity, review rendering and host validation in 14.2 seconds. Separate retained pine, axe and corrected selling-box inputs succeeded in 14.6, 12.7 and 14.5 seconds. All workers closed. These were fresh isolated diagnostic conversions, with original failures retained, 128px review renders and no original-job replay, Studio operation, upload or approval.

Both generation and conversion adapters have the same six boundary cases; the separate failure-report case makes 13 passing Python cases without skips. The native conversion workflow runs these cases on both operating systems before acquiring Blender. Actual hosted results must be observed separately.

This restores conversion of these inputs. It does not accept model art quality, production review renders, native Studio import, Figma GUI approval or the completed chopping game. The retained source and original errors remain private.

[[Delivery/G05 Blender Quality]] - [[Bugs/Plugin Startup Visibility]] - [[Operations/Next Session]]
