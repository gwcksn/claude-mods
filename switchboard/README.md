# Switchboard

One pane (`/switchboard`) with a row per mod: an icon, its name, what it does, its slash command, and

- a green **On / Off** switch that holds in every chat,
- an **eye** (`◉` shown, `◌` hidden) for mods that draw something,
- **Open** for mods with a side pane.

Mods are found by themselves: `CLAUDE_CODE_PLUGIN_DIRS`, `~/.claude/mods`, marketplace installs and mods built in this chat. Changes apply within 3 seconds.

## How a mod follows it

The pane writes `~/.claude/mods/switches.json`; a mod reads it (every 3 s):

```json
{ "source-control": false, "savvy-progress:hidden": true }
```

- `"<mod>": false` is off. `"<mod>:hidden": true` is hidden. A missing key is on and shown.
- **Open** (and showing a hidden pane mod again) writes an empty `~/.claude/mods/.open-<mod>-<session id>`; the mod opens its pane and deletes the file.
- A mod whose source never mentions `switches.json` is listed with "Not switchable yet" and no switch.

`savvy-progress`, `chat-inventory` and `source-control` follow it (`hooks/switch.ts` in each: off refuses the mod's slash command and closes its pane; hidden closes the pane and hides the band until the command is run). `token-weather` is Anthropic's sample and does not.

The file format is the same as Ben AI's `mods` plugin, so mods built for that one work here too. `/mods` is not registered, so both can be installed side by side.

## Tests

`claude plugin test ~/mods/switchboard`
