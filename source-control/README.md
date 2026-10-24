# source-control

A **Source Control** pane like the one in VS Code. `/scm` shows or hides it.

- **Changes**: *Merge Conflicts*, *Staged Changes* and *Changes* (untracked files included), each with a count and a fold arrow. Status letters are coloured (M, A, D, U, R, `!`).
- **Click a file** to see its changes right under it (green and red lines with line numbers); click again to hide them. Staged files show the staged diff.
- **Stage and discard**: `+` stages, `−` unstages, `↶` discards. Every discard asks again first (`Discard? Yes / No`), also *discard all*.
- **Commit box**: type a message and press Enter (or the Commit button). The button's menu picks **Commit**, **Commit & Push**, **Commit & Sync** or **Amend last commit**. With nothing staged it offers to stage everything first.
- **✨ Generate** (beside the box, and ✨ in the header) writes a comprehensive commit message with the latest Haiku (`commitModel`, default `haiku`): a Conventional Commits subject, a short *why*, and a bulleted list of the notable changes. It reads the staged diff (or the working tree's, if nothing is staged), the last ten commit subjects for style, and the branch name. The message lands in the box for you to edit; nothing is committed for you.
- **Sync**: `⟳ Sync ↓n↑n` appears when the branch is ahead or behind its upstream; **Publish Branch** when it has none. The `⋯` menu has Pull, Push, Sync, Fetch, Switch branch, Create branch, Stash, Pop stash, Undo last commit and Open repository.
- **Recent commits**: the last ten, `↑` marks unpushed ones; click one for its file stats.
- **Repository**: the chat's folder if it is in a repository, otherwise the one used last. *Open repository…* takes any path and remembers the last few; outside a repository the pane offers `git init`.

The pane refreshes every `refreshSeconds` while it is open, and at once after the chat edits a file or runs a command.

## What goes to the model

Pressing ✨ sends the diff to the model through this session's own API connection, as any chat message would. Lockfiles, images and other binaries, `.env*` files, keys and certificates, and any file git cannot name are sent as **names only**; their contents are never put in the prompt. A diff over about 60,000 characters is cut per file.

## Limits

- **Repository hooks do not run** (pre-commit, commit-msg, pre-push): the engine starts git with hooks off.
- **No prompts**: an ssh passphrase or an HTTPS credential that is not stored makes the action fail with git's message instead of asking.
- Diffs show up to about 20,000 characters per file, at most four open at once.
- No conflict editor and no staging of single hunks or lines yet. Conflicted files are listed; resolve them in the file, then press `+`.
- Never force-pushes.

## Settings

`commitModel` (model alias or id), `refreshSeconds` (2, 3, 5, 10, 30), `autoOpen` (`never`, or `first-change` to open once when the chat first changes a file in a repository).
