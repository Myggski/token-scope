**Download** `TokenScope-Setup-1.0.4.exe` below and run it. It updates TokenScope in place, and your data stays.

Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Choose **More info**, then **Run anyway**.

**Cursor**
- **Chat names:** Spending shows Cursor's own chat names instead of "Cursor conversation".
- **Closer real costs:** TokenScope now uses Cursor's own count of how big each chat was, and counts tool calls Cursor runs together as one request. Against Cursor's usage page, costs came out within about 15% per conversation and 2% in total.
- TokenScope reads only each chat's name and size from Cursor's data on your computer, without changing it.

**Also**
- After an update, an older copy of TokenScope still running inside your AI tool no longer overwrites the newer costs.
- Built on a newer Electron (37).

After updating, restart Cursor once so it uses the new version.
