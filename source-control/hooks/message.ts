// The commit-message request: what is sent to the model, and how its reply is cleaned.
// Pure, so it is tested without an engine.

export type FileDiff = { path: string; diff: string }

/** The file a chunk is about, read from the lines git writes whatever prefixes it is configured to use; '' when unclear. */
const pathOf = (chunk: string): string => {
  const rename = /^rename to (.+)$/m.exec(chunk)?.[1]
  if (rename) return rename
  const plus = /^\+\+\+ (?:[^/\n]+\/)?(.+)$/m.exec(chunk)?.[1]
  if (plus && plus !== '/dev/null') return plus
  const minus = /^--- (?:[^/\n]+\/)?(.+)$/m.exec(chunk)?.[1]
  if (minus && minus !== '/dev/null') return minus
  // Binary and mode-only changes have neither line: "diff --git a/x b/x" names the same path twice.
  return /^diff --git [^/\n]+\/(.+) [^/\n]+\/\1$/m.exec(chunk)?.[1] ?? ''
}

/** Splits a unified `git diff` into one chunk per file. A chunk whose file cannot be named has path ''. */
export const splitDiff = (raw: string): FileDiff[] => {
  const out: FileDiff[] = []
  for (const chunk of raw.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue
    out.push({ path: pathOf(chunk), diff: chunk })
  }
  return out
}

// Lockfiles are noise, binaries do not read, and secrets must not leave the machine:
// these are sent as names only, never their contents.
const NAME_ONLY =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock|flake\.lock)$|\.(lock|png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|tar|7z|mp[34]|mov|woff2?|ttf|otf|so|dylib|dll|exe|bin|sqlite3?|db)$|(^|\/)\.env(\..*)?$|\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)(id_rsa|id_ed25519|id_ecdsa|credentials|secrets?\.(json|ya?ml|toml))$/i

// A file git could not name is held back too: unknown means it might be a secret.
export const isNameOnly = (path: string): boolean => !path || NAME_ONLY.test(path)

/** What a model may be sent of the diff, in characters; the rest is cut per file. */
export const MAX_DIFF_CHARS = 60_000
const MIN_PER_FILE = 1_500

/** The diff trimmed to the budget: whole small files, the head of big ones, names for the rest. */
export const trimDiff = (files: FileDiff[], budget = MAX_DIFF_CHARS): string => {
  const readable = files.filter(f => !isNameOnly(f.path) && !/^Binary files /m.test(f.diff))
  const each = Math.max(MIN_PER_FILE, Math.floor(budget / Math.max(1, readable.length)))
  const parts: string[] = []
  let used = 0
  for (const f of files) {
    if (isNameOnly(f.path) || /^Binary files /m.test(f.diff)) {
      parts.push(`### ${f.path || '(unnamed file)'}\n(contents not sent: lockfile, binary, secret or unnamed file)`)
      continue
    }
    const left = Math.max(0, budget - used)
    if (left < MIN_PER_FILE) {
      parts.push(`### ${f.path}\n(diff omitted: over the size limit)`)
      continue
    }
    const cap = Math.min(each, left)
    let text = f.diff
    // Header lines (index, ---, +++) say little; start at the first hunk.
    const at = text.indexOf('\n@@ ')
    if (at >= 0) text = text.slice(at + 1)
    if (text.length > cap) {
      const cut = text.slice(0, cap)
      const kept = cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cap)
      text = `${kept}\n[... ${text.slice(kept.length).split('\n').length - 1} more lines of this file not shown]`
    }
    used += text.length
    parts.push(`### ${f.path}\n${text}`)
  }
  return parts.join('\n\n')
}

export const RULES = `You write git commit messages. Read the staged changes and write one comprehensive commit message for them.

Format, exactly:
- First line: a Conventional Commits subject, "type(scope): summary". type is one of feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert. scope is optional and short. Imperative mood, lower case after the colon, no trailing period, at most 72 characters.
- A blank line.
- A short paragraph (1 to 4 sentences, wrapped at 72 characters) on why the change was made and what it achieves, not a restatement of the diff.
- A blank line, then a bulleted list ("- ") of the notable changes, grouped by area or file when several areas change. Name real files, functions, options or commands from the diff. One line per bullet, each at most 72 characters wide; wrap a longer one onto an indented continuation line.
- If, and only if, the change breaks existing behaviour or an interface, end with a "BREAKING CHANGE: ..." footer.

Rules:
- Describe only what the diff shows. Never invent behaviour, issue numbers, versions or reasons it does not support; if the reason is not visible, describe the effect instead.
- Files shown as "contents not sent" (lockfiles, binaries, secret files) cannot be read: never guess what changed in them. Mention a lockfile only as one short bullet such as "package-lock.json: update dependencies" when the other changes explain it, and leave out secret files (.env, keys) entirely.
- Match the style and scope names of the recent commits when they follow a convention.
- One commit message only. Plain text: no markdown headings, no code fences, no quotes around it, no "Co-Authored-By" or other trailers, no preamble or closing remark.`

export type PromptInput = {
  branch: string
  recent: string[]
  stat: string
  diff: string
  /** Which changes the diff holds: the staged ones, or (nothing staged) the working tree's. */
  scope: 'staged' | 'unstaged'
  /** New files git does not track yet: listed by name, their contents are not sent. */
  untracked?: string[]
}

export const buildPrompt = (i: PromptInput): string =>
  [
    `Branch: ${i.branch || '(detached HEAD)'}`,
    i.recent.length ? `Recent commit subjects, newest first (for style):\n${i.recent.map(s => `- ${s}`).join('\n')}` : 'Recent commit subjects: none yet (first commit).',
    i.scope === 'staged' ? 'The changes below are STAGED and will be committed.' : 'Nothing is staged; the changes below are the working tree\'s and will be committed once staged.',
    i.stat ? `Summary of files:\n${i.stat}` : '',
    i.untracked?.length ? `New untracked files (contents not shown):\n${i.untracked.map(p => `- ${p}`).join('\n')}` : '',
    `Diff:\n${i.diff || '(no textual diff)'}`,
    'Write the commit message now.',
  ]
    .filter(Boolean)
    .join('\n\n')

const WIDTH = 72

/** A line cut at spaces to `WIDTH`; a bullet's continuation lines are indented under its text. */
const wrapLine = (line: string): string[] => {
  if (line.length <= WIDTH) return [line]
  const indent = /^(\s*(?:[-*]|\d+[.)])\s+|\s*)/.exec(line)?.[1] ?? ''
  const pad = ' '.repeat(indent.length)
  const out: string[] = []
  let cur = ''
  for (const word of line.slice(indent.length).trim().split(/\s+/)) {
    const prefix = out.length ? pad : indent
    if (cur && (prefix + cur).length + 1 + word.length > WIDTH) {
      out.push(prefix + cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  out.push((out.length ? pad : indent) + cur)
  return out
}

/** The model's reply as a message to commit: fences, quotes and trailers removed, lines trimmed and wrapped. */
export const cleanMessage = (reply: string): string => {
  let text = reply.replace(/\r\n/g, '\n').trim()
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text)
  if (fenced?.[1]) text = fenced[1]
  text = text.replace(/^["'“]([\s\S]*)["'”]$/, '$1')
  const lines = text
    .split('\n')
    .filter(l => !/^\s*(co-authored-by|generated with|🤖)/i.test(l))
    .map(l => l.replace(/\s+$/, ''))
  // The subject stays on one line however long; the body is wrapped.
  const wrapped = lines.flatMap((l, i) => (i === 0 ? [l] : wrapLine(l)))
  return wrapped.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
