**Download** `TokenScope-Setup-1.0.1.exe` below and run it. It updates TokenScope in place, and your data stays.

Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Choose **More info**, then **Run anyway**.

**Fixed**
- **Cursor tracking:** when Cursor ran TokenScope's hook, nothing was saved, and no error showed. The hook no longer waits for Cursor to close its input, reads every text encoding Cursor may use, and writes down what went wrong instead of hiding it. If something still goes wrong, Track AI spending shows it under Cursor.

After updating, open TokenScope once and turn Cursor off and on under Track AI spending.
