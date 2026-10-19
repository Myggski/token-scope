**Download** `TokenScope-Setup-1.0.6.exe` below and run it. It updates TokenScope in place, and your data stays.

Windows shows a warning for apps it doesn't recognise yet, which is normal for small personal projects like this. Click **More info** and then **Run anyway**.

**Fixed**
- **Your AI couldn't connect to TokenScope** (`MCP error -32000: Connection closed`) in 1.0.4 and 1.0.5. A file was missing from the copy TokenScope makes for your AI tools. Every file is now included.
- The MCP program measures real costs again. In 1.0.4 and 1.0.5 it left that to the app.
- The OpenCode setup steps mention `opencode.jsonc` too.

After updating, open TokenScope once, then restart your AI tools so they start the fixed version.
