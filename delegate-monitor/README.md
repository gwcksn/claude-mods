# delegate-monitor

A Claude Code mod: a sidebar of the tasks Claude hands off to **opencode** (`opencode run …`) and **codex** (`codex exec …`) through the Bash tool, styled after `/agents-info`.

- `/delegates` toggles the sidebar; `/delegates open` opens it. It also opens by itself on the first hand-off of a session.
- **Running** and **Finished** sections with one card per run: the agent's icon, title (`--title`, else the Bash description, else the prompt), model (`-m`), folder, elapsed time and status.
- Running icons bounce (terminal: block-glyph frames with a shadow; desktop: SVG with CSS, off under `prefers-reduced-motion`); finished ones stand still and dim.
- **Clear finished** removes finished runs and keeps running ones.
- A one-line band above the prompt counts running runs while any are going.

Foreground runs end when the Bash call returns. Background runs (`run_in_background`) end on the task's notification, on `TaskStop`, or when `ps` no longer shows their process for two polls in a row.

Obeys the Switchboard (`hooks/switch.ts`, the same file as the other mods).
