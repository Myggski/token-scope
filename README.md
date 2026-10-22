# TokenScope

**Know what your AI coding costs, and give your AI the data to make it cheaper.**

TokenScope is a Windows app for developers who code with AI in **Claude Code**, **Codex**, **Cursor** or **OpenCode**. It works in three steps:

1. **Plan:** before a task starts, your AI estimates what it will cost on the models you care about.
2. **Measure:** when the task is done, its real cost is measured automatically, and later estimates get more accurate.
3. **Improve:** every conversation's cost is kept, and your AI can read it. Ask it *"Based on my spending, what can we do better?"* and it answers from your own data.

The app shows facts only. The suggestions come from your AI.

## Features

- **Models:** current prices for every model on [OpenRouter](https://openrouter.ai/models), with sorting, filters and favorites, and a capability score from [Epoch AI](https://epoch.ai/benchmarks/eci) for the models it has tested.
- **Plans:** what a task will cost before your AI starts it, with a range and a breakdown per phase, next to what it really cost.
- **Spending:** what each AI conversation cost and what made up the cost, like cache that expired or large outputs that got re-read. Search by name, tool, project or model, and see what any conversation would have cost on another model.
- **Comparison:** the cost of a task done by hand next to the cost of doing it with AI, both priced from an estimated monthly cost. It compares cost only, not quality. Hidden at first: turn it on under **Settings & help → Tabs**.

| | Plans: estimates | Plans: real costs | Spending |
| --- | --- | --- | --- |
| Claude Code | ✓ | ✓ | ✓ |
| Codex (app, editor extension, command line) | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | ✓ |
| Zed (its own AI agent) | ✓ | ✓ (whole chat) | ✓ (no breakdown) |
| Cursor | ✓ | ≈ | ≈ |
| Claude Desktop and other MCP tools | ✓ | | |

≈ means approximate, because Cursor doesn't keep token counts. TokenScope works them out from the size of each step, usually within about 15% of Cursor's usage page. Estimates are corrected per tool from your finished plans. Zed saves one exact total per conversation, so a plan made in a Zed chat costs the whole chat, and Spending can't show what drove a Zed conversation's cost. Claude Code, Codex, OpenCode and Zed conversations show up in Spending as far back as those tools keep them, while Cursor conversations show up from when you turn on Cursor tracking. Using ChatGPT? It can't connect to programs on your computer, but Codex and OpenCode can, and both can sign in with your ChatGPT account. Claude Code, Codex and OpenCode running inside WSL are read too, while WSL is running.

## Privacy

Everything stays on your computer. No accounts and no API keys. TokenScope reads the records your AI tools already keep (for Cursor, also each chat's name and size), and saves only sizes, costs and times, never your code, prompts or the AI's replies. Tracking is off until you switch it on. The only things sent anywhere are the requests for prices to OpenRouter and for capability scores to Epoch AI, and the check for a new version on GitHub.

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
- `src/claudelogs.js`, `src/codexlogs.js`, `src/history.js`, `src/zed.js`: reading Claude Code, Codex, OpenCode, Zed and Cursor records, for Spending and real costs.
- `src/comparison.js`: the Comparison tab's math.
- `src/capability.js`: Epoch AI's capability scores, matched to OpenRouter's models.
- `src/archive.js`: saved summaries, so Spending keeps conversations after a tool deletes its own records.
- `src/wsl.js`: finding the tools' records inside WSL.
- `src/cursorhook.js`, `src/cursor-hook.js`: the optional Cursor hook.
- `src/cursordb.js`: reads Cursor chat names and sizes from Cursor's own database, read-only.
- `renderer/`: the interface.

App data is saved in `%APPDATA%\TokenScope`: `tokenscope-data.json` (plans, favorites, settings) and the `history` folder (Cursor records and saved summaries).

## Data sources

- Prices: [OpenRouter](https://openrouter.ai/models).
- Capability scores: the [Epoch Capabilities Index](https://epoch.ai/benchmarks/eci) by [Epoch AI](https://epoch.ai), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). TokenScope downloads the scores, matches them to OpenRouter's models by name and rounds them. It doesn't change them in any other way.

The interface uses the [Geist](https://vercel.com/font) fonts (SIL Open Font License, in `renderer/fonts/`) and follows Material Design 3 sizes and spacing.
