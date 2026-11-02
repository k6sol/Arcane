---
type: bug
project: Arcane
tags: [arcane, desktop, branding]
---
# Windows taskbar branding

The customer's loaded2d desktop displays Electron's atom icon in the taskbar. Its installed manifest records executable branding as applied, so the screenshot does not establish that resource editing was skipped. Inspection found that the old host PNG and ICO contained only a gradient square, without the Arcane A. No explicit window taskbar icon path was set. Windows cache/resource selection as the precise fallback cause remains unconfirmed.

The corrected window PNG uses the existing Arcane A silhouette on transparency. A matching single-image256px taskbar ICO is included in the controlled source snapshot and host payload. Windows windows explicitly set AppUserModelID com.arcane.desktop and the packaged ICO through BrowserWindow.setAppDetails. The executable resource editor uses the same new ICO when present. Existing authentication partition, application identity, shortcuts and relaunch behavior are preserved. No Explorer restart, global icon-cache deletion or installed-file patching was attempted.

The legacy stable launcher's embedded ICO is deliberately unchanged in this patch: its recorded source digest is an installation compatibility boundary. The running window/taskbar and new release executable use the corrected icon; changing the stable launcher's icon requires a separately verified launcher migration. Do not imply the shortcut icon has already changed.

The generated PNG was visually inspected. JavaScript syntax and execution of the actual taskbar-property statement confirm Windows receives the existing packaged icon path and other platforms do not invoke the Windows API. All three focused offline packaging cases pass, including exact ICO payload copying, optional-icon compatibility and rejection of an outer-manifest-rehashed icon that differs from the verified product snapshot. The initial packaging run exposed the missing controlled-source inventory entry; that entry was corrected before the passing run. No native app or provider was launched by these fixtures. Actual updated Windows taskbar acceptance requires a verified package and restart; the running2d app remains unchanged and still shows its separate native connection failure.

[[Bugs/Native Discovery Shutdown]] ? [[Operations/Next Session]]
