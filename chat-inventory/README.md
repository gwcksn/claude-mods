# chat-inventory

A side pane, **In this chat**, listing what this chat used. Written for this machine after the Ben AI `chat-inventory` mod; nothing is copied from it.

- **To-do**: the chat's to-do list (`TodoWrite`, or `TaskCreate` and `TaskUpdate`) with `done of total`; finished steps are struck through. Only the main chat writes it.
- **Connectors**: one row per MCP server with its name, the tool called last, and the number of calls. On the desktop a coloured logo tile; in the terminal a glyph.
- **Context files**: `Files read` and its count, then each file with its folder; memory files loaded at start (CLAUDE.md and the like) are marked `auto`. Claude's own scratch files are left out.
- **Skills**: each skill the chat loaded (the `Skill` tool, or a `SKILL.md` read) and its uses.

Subagents' calls count for the chat. The header arrow of each section folds it; **Hide** closes the pane.

`/inventory` shows or hides the pane. The `autoOpen` setting (`never` by default, or `first-use`) lets it open once by itself.
