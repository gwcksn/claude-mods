# mods

A collection of [Claude Code mods](https://docs.claude.com/en/docs/claude-code): small plugins that change Claude Code's own interface, such as side panes, a band above the prompt, slash commands and hooks on tool calls. Each folder is a self-contained plugin with its own `README.md`, `.claude-plugin/plugin.json` and `hooks/`.

## Mods

| Mod | What it does |
| --- | --- |
| [`savvy-progress`](savvy-progress) | Progress bar above the prompt for `/savvy-flow`, plus the `/agents-info` panel of running, finished and planned subagents (model, context, cost, time). |
| [`chat-inventory`](chat-inventory) | "In this chat" side pane: to-dos, MCP connectors used, files read and skills loaded. |
| [`source-control`](source-control) | VS Code-style Source Control pane (`/scm`): stage, discard, diff, commit, push and AI-written commit messages. |
| [`delegate-monitor`](delegate-monitor) | Sidebar (`/delegates`) tracking tasks handed off to `opencode` and `codex` through the Bash tool. |
| [`switchboard`](switchboard) | One pane (`/switchboard`) to switch each mod on or off and show or hide it. |
| [`token-weather`](token-weather) | A live "forecast" of the context window in the band above the prompt. |

## Usage

Load a mod by pointing Claude Code at its folder (for example as a local plugin); see each mod's README for its slash commands and options. Tests (`*.test.ts(x)`) sit next to the hooks they cover.

## Credits

- **[Ben AI](https://github.com/ben-ai)'s `mods` plugin**: the mod format and the `chat-inventory` idea. `chat-inventory` was written for this machine after that mod (nothing copied), and `switchboard` reads the same file format, so mods built for one work with the other.
- **[johnnyvizz](https://github.com/johnnyvizz)**: author of `savvy-progress` ([claude-kit](https://github.com/johnnyvizz/claude-kit), MIT), kept here with local changes.
- **Claude Code DevRel**: author of `token-weather`, from [claude-code-playground](https://github.com/anthropics/claude-code-playground). Shared as-is; not an official Anthropic product.

`source-control`, `delegate-monitor` and `switchboard` were written locally with Claude Code.
