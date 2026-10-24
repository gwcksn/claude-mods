// Everything about git that needs no engine: argv builders and parsers. The caller
// passes the one function that runs a process, so the same code runs under the
// engine (`$.process.run`) and in a plain script against a real repository.

export type RunInit = { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: string[], init?: RunInit) => Promise<RunResult>

/** What a git call came to: `out` and `err` are trimmed text, `ok` is exit code 0. */
export type Git = { ok: boolean; code: number; out: string; err: string }
export type GitFn = (args: string[], opts?: { stdin?: string; timeoutMs?: number; raw?: boolean; okCodes?: number[] }) => Promise<Git>

// No prompts (a missing credential fails at once instead of waiting for a person
// who cannot answer), plain English output, and no index lock taken by reads.
const ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' }

export const NETWORK_MS = 120_000

/** `git -C repo ...args` through `run`. A process that cannot start comes back as code -1. */
export const makeGit =
  (run: Run, repo: string): GitFn =>
  async (args, opts = {}) => {
    try {
      const r = await run(['git', '-C', repo, ...args], { env: ENV, stdin: opts.stdin, timeoutMs: opts.timeoutMs })
      const ok = r.exitCode === 0 || (opts.okCodes ?? []).includes(r.exitCode)
      return { ok, code: r.exitCode, out: opts.raw ? r.stdout : r.stdout.trim(), err: r.stderr.trim() }
    } catch (err) {
      return { ok: false, code: -1, out: '', err: String(err instanceof Error ? err.message : err) }
    }
  }

// ---------------------------------------------------------------------------
// Status

/** M modified, A added, D deleted, R renamed, C copied, T type changed, U untracked, ! conflict. */
export type Change = { path: string; orig?: string; code: string; isUntracked?: boolean }
export type Branch = { name: string; isDetached: boolean; oid: string; upstream: string; ahead: number; behind: number }
export type Status = {
  branch: Branch
  /** False on a repository with no commit yet. */
  hasHead: boolean
  staged: Change[]
  unstaged: Change[]
  conflicts: Change[]
}

/** The rest of `s` after skipping `n` space-separated fields (a path may hold spaces). */
const after = (s: string, n: number): string => {
  let at = 0
  for (let i = 0; i < n; i++) {
    at = s.indexOf(' ', at)
    if (at < 0) return ''
    at += 1
  }
  return s.slice(at)
}

export const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '-b', '-z', '--untracked-files=all']

/** `git status --porcelain=v2 -b -z` as groups of changes plus the branch line. */
export const parseStatus = (text: string): Status => {
  const branch: Branch = { name: '', isDetached: false, oid: '', upstream: '', ahead: 0, behind: 0 }
  const staged: Change[] = []
  const unstaged: Change[] = []
  const conflicts: Change[] = []
  const records = text.split('\0')
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? ''
    if (!r) continue
    if (r.startsWith('# branch.oid ')) branch.oid = r.slice(13)
    else if (r.startsWith('# branch.head ')) {
      const head = r.slice(14)
      branch.isDetached = head === '(detached)'
      branch.name = branch.isDetached ? '' : head
    } else if (r.startsWith('# branch.upstream ')) branch.upstream = r.slice(18)
    else if (r.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(r)
      branch.ahead = Number(m?.[1] ?? 0)
      branch.behind = Number(m?.[2] ?? 0)
    } else if (r.startsWith('? ')) unstaged.push({ path: r.slice(2), code: 'U', isUntracked: true })
    else if (r.startsWith('1 ') || r.startsWith('2 ')) {
      const isRename = r.startsWith('2 ')
      const xy = r.slice(2, 4)
      // "1 XY sub mH mI mW hH hI path" has 8 fields before the path, "2 ..." 9.
      const path = after(r, isRename ? 9 : 8)
      const orig = isRename ? records[++i] : undefined
      const [x = '.', y = '.'] = xy
      if (x !== '.') staged.push({ path, ...(orig ? { orig } : {}), code: x })
      if (y !== '.') unstaged.push({ path, ...(orig ? { orig } : {}), code: y })
    } else if (r.startsWith('u ')) conflicts.push({ path: after(r, 10), code: '!' })
  }
  return { branch, hasHead: branch.oid !== '(initial)', staged, unstaged, conflicts }
}

// ---------------------------------------------------------------------------
// Diffs

// The prefixes are set here, so a user's diff.noprefix or diff.mnemonicPrefix cannot change the headers.
export const DIFF = ['--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

/** The command that shows one file's changes, and the exit codes that mean "there is a diff". */
export const diffCmd = (c: Change, isStaged: boolean): { args: string[]; okCodes: number[] } => {
  if (c.isUntracked) return { args: [...DIFF, '--no-index', '--', '/dev/null', c.path], okCodes: [1] }
  const paths = c.orig ? [c.orig, c.path] : [c.path]
  return { args: isStaged ? [...DIFF, '--cached', '-M', '--', ...paths] : [...DIFF, '--', ...paths], okCodes: [] }
}

export type DiffView = { text: string; note: string }
export const MAX_DIFF_CHARS = 20_000

/** A diff ready for a `Code format="diff"` block, or a one-line note when it cannot be drawn. */
export const prepareDiff = (raw: string): DiffView => {
  if (!raw.trim()) return { text: '', note: 'No changes to show.' }
  if (/^Binary files .* differ$/m.test(raw) && !/^@@ /m.test(raw)) return { text: '', note: 'Binary file.' }
  const lines = raw.split('\n')
  const at = lines.findIndex(l => l.startsWith('@@ '))
  if (at < 0) return { text: '', note: lines.filter(l => /^(new|deleted|old|similarity|rename|index)/.test(l)).join(' · ') || 'No textual changes.' }
  const text = lines.slice(at).join('\n')
  if (text.length <= MAX_DIFF_CHARS) return { text, note: '' }
  // Cut at a hunk boundary, so the drawing still parses.
  let out = ''
  for (const h of text.split(/\n(?=@@ )/)) {
    if (out && out.length + h.length + 1 > MAX_DIFF_CHARS) break
    if (!out && h.length > MAX_DIFF_CHARS) {
      out = h.split('\n').slice(0, 200).join('\n')
      break
    }
    out += (out ? '\n' : '') + h
  }
  return { text: out, note: `Large diff: showing the first ${out.split('\n').length} lines.` }
}

// ---------------------------------------------------------------------------
// Commands (argv after `git -C repo`)

export const toplevel = ['rev-parse', '--show-toplevel']
export const init = ['init']
export const stage = (paths: string[]) => ['add', '--', ...paths]
export const stageAll = ['add', '-A']
export const unstage = (paths: string[]) => ['reset', '-q', '--', ...paths]
export const unstageAll = ['reset', '-q']
export const restore = (paths: string[]) => ['restore', '--worktree', '--', ...paths]
export const clean = (paths: string[]) => ['clean', '-fdq', '--', ...paths]
export const restoreAll = ['restore', '--worktree', '--', '.']
export const cleanAll = ['clean', '-fdq']
export const commit = (isAmend: boolean) => ['commit', ...(isAmend ? ['--amend'] : []), '-F', '-']
export const push = ['push']
export const pushUpstream = (remote: string, branch: string) => ['push', '--set-upstream', remote, branch]
export const pull = ['pull']
export const fetchAll = ['fetch', '--all', '--prune']
export const remotes = ['remote']
export const branches = ['branch', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)']
export const switchTo = (name: string) => ['switch', name]
export const createBranch = (name: string) => ['switch', '-c', name]
export const stashPush = (message: string) => ['stash', 'push', '-u', '-m', message]
export const stashPop = ['stash', 'pop']
export const stashList = ['stash', 'list']
export const undoCommit = ['reset', '--soft', 'HEAD~1']
export const showStat = (hash: string) => ['show', '--stat', '--format=%B', '--no-color', hash]
export const LOG_ARGS = ['log', '-n', '10', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar']
export const unpushed = ['rev-list', '@{u}..HEAD']

/** git says a branch has no upstream with this text, and the push needs `--set-upstream`. */
export const needsUpstream = (err: string): boolean => /no upstream branch|has no upstream/i.test(err)

export type LocalBranch = { name: string; isCurrent: boolean; upstream: string }
export const parseBranches = (text: string): LocalBranch[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [name = '', head = '', upstream = ''] = l.split('\t')
      return { name, isCurrent: head === '*', upstream }
    })
    // "(HEAD detached at abc)" is not a branch a person can switch to.
    .filter(b => b.name && !b.name.startsWith('('))

export type Commit = { hash: string; short: string; subject: string; author: string; when: string; isUnpushed?: boolean }
export const parseLog = (text: string, unpushedHashes: ReadonlySet<string> = new Set()): Commit[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [hash = '', short = '', subject = '', author = '', when = ''] = l.split('\x1f')
      return { hash, short, subject, author, when, isUnpushed: unpushedHashes.has(hash) }
    })

/** The name when git could accept it, else ''. Git checks again; this only spares a round trip. */
export const cleanBranchName = (s: string): string => {
  const name = s.trim()
  return !name || /[\s~^:?*[\\]|\.\.|^[-/]|[/.]$|\.lock$|@\{/.test(name) ? '' : name
}
