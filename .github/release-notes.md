**Download** `TokenScope-Setup-1.0.2.exe` below and run it. It updates TokenScope in place, and your data stays.

Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Choose **More info**, then **Run anyway**.

**Fixed (Cursor)**
- **Helper agents:** when your AI in Cursor starts a helper, Cursor gives it a conversation of its own. It's now counted as part of the conversation that started it, and of its plan, instead of showing as a separate conversation.
- **Thinking counted twice:** Cursor reports each thinking step twice. It's now counted once, and no longer looks like you writing a new message.
- **Models with an effort level:** names like `gemini-3.7-flash-low` (the model Cursor uses to summarize long conversations) now get a price.
- **Project names:** Cursor conversations show their project folder, also for chats that started before tracking was on.

Your existing Cursor records are read the new way too, so no data is lost.
