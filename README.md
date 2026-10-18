# TokenScope

**Know what your AI coding costs, and give your AI the data to make it cheaper.**

TokenScope is a Windows app for developers who code with AI in **Claude Code**, **Codex**, **Cursor** or **OpenCode**. It works in three steps:

1. **Plan:** before a task starts, your AI estimates what it will cost on the models you care about.
2. **Measure:** when the task is done, its real cost is measured automatically, and later estimates get more accurate.
3. **Improve:** every conversation's cost is kept, and your AI can read it. Ask it *"Based on my spending, what can we do better?"* and it answers from your own data.

The app shows facts only. The suggestions come from your AI.

## Features

- **Models:** current prices for every model on [OpenRouter](https://openrouter.ai/models), with sorting, filters and favorites.
- **Plans:** what a task will cost before your AI starts it, with a range and a breakdown per phase, next to what it really cost.
- **Spending:** what each AI conversation cost and what made up the cost, like cache that expired or large outputs that got re-read. Filter by tool or by model maker to compare, for example, Claude and GPT, and see what any conversation would have cost on another model.

| | Plans: estimates | Plans: real costs | Spending |
| --- | --- | --- | --- |
| Claude Code | ✓ | ✓ | ✓ |
| Codex (app, editor extension, command line) | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | ✓ |
| Cursor | ✓ | ≈ | ≈ |
| Claude Desktop and other MCP tools | ✓ | | |

≈ means approximate, because Cursor doesn't keep token counts. Using ChatGPT? It can't connect to programs on your computer, but Codex and OpenCode can, and both can sign in with your ChatGPT account. Claude Code, Codex and OpenCode running inside WSL are read too, while WSL is running.

## Privacy

Everything stays on your computer. No accounts and no API keys. TokenScope reads the records your AI tools already keep, and saves only sizes, costs and times, never your code, prompts or the AI's replies. Tracking is off until you switch it on. The only thing sent anywhere is the request for prices to OpenRouter.

## Getting started

1. Install TokenScope from the releases page.
2. Open **Settings & help**. Under **Connect your AI tool**, press **Set up** next to the tool you use your AI in and follow the steps.
3. To see your spending, turn your tools on under **Track AI spending** on the same tab.

Then ask your AI to estimate a task before it starts, for example *"Plan this first, estimate it with TokenScope and wait for my go."* The plan shows up under **Plans**. Some tools also have a shortcut: `/mcp__tokenscope__estimate` in Claude Code, `/estimate` in Cursor.

If you move TokenScope to another folder, set up the connection again under **Connect your AI tool**.

## Development

Requires [Node.js](https://nodejs.org/) 22 or newer.

```
npm install
npm start      # run from source
npm test       # run the tests
npm run dist   # build the Windows installer (on Windows)
```

Where things are:

- `src/mcp.js`, `src/mcp-main.js`: the [MCP](https://modelcontextprotocol.io) server your AI talks to.
- `src/estimate.js`, `src/jobs.js`: the cost math and saved plans (called jobs in the code).
- `src/claudelogs.js`, `src/codexlogs.js`, `src/history.js`: reading Claude Code, Codex, OpenCode and Cursor records, for Spending and real costs.
- `src/archive.js`: saved summaries, so Spending keeps conversations after a tool deletes its own records.
- `src/wsl.js`: finding the tools' records inside WSL.
- `src/cursorhook.js`, `src/cursor-hook.js`: the optional Cursor hook.
- `renderer/`: the interface.

App data is saved in `%APPDATA%\TokenScope`: `tokenscope-data.json` (plans, favorites, settings) and the `history` folder (Cursor records and saved summaries).

The interface uses the [Geist](https://vercel.com/font) fonts (SIL Open Font License, in `renderer/fonts/`) and follows Material Design 3 sizes and spacing.
