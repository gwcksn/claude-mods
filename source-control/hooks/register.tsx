import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, CommitMode, DiffView, Repo, View } from '../types'
import * as G from './git'
import { RULES, buildPrompt, cleanMessage, splitDiff, trimDiff } from './message'
import { clearHidden, readSwitch, takeOpenRequest } from './switch'

const PANE = 'source-control'
const TITLE = 'Source Control'
const MAX_ROWS = 60
const MAX_OPEN_DIFFS = 4
const MAX_RECENT = 6

const RED = '#f85149'
const GREEN = '#3fb950'
const YELLOW = '#d29922'
const BLUE = '#58a6ff'
const ACCENT = '#d97757'

const NO_REPO: Repo = { root: '', status: null, branches: [], commits: [], stashCount: 0, remote: '', problem: '' }
const NO_VIEW: View = {
  message: '',
  mode: 'commit',
  expanded: [],
  folded: ['commits'],
  diffs: {},
  busy: '',
  isGenerating: false,
  notice: null,
  confirm: '',
  drawer: '',
  field: '',
}
const repoAtom = atom({ plugin: 'source-control', key: 'repo' } as const, NO_REPO)
const viewAtom = atom({ plugin: 'source-control', key: 'view' } as const, NO_VIEW)

// Module variables start over on a reload; everything shown lives in $.state.
let isOpen = false
let isRefreshing = false
let isBusy = false
let hasAutoOpened = false
// What the Switchboard says: off closes the pane and refuses /scm, hidden closes it until /scm or Open.
let isOff = false
let isHidden = false
let recent: string[] = []
let stop: AbortController | null = null

const STATUS_COLOR: Record<string, string> = { M: YELLOW, T: YELLOW, A: GREEN, U: GREEN, R: GREEN, C: BLUE, D: RED, '!': RED }
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const keyOf = (group: 's' | 'u' | 'k', path: string): string => `${group}:${path}`
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const firstLine = (s: string): string => s.split('\n').find(l => l.trim()) ?? s

// ---------------------------------------------------------------------------
// Talking to git

const gitOf = ($: EngineInterface, root: string): G.GitFn => G.makeGit((argv, init) => $.process.run(argv, init), root)

const setView = ($: EngineInterface, patch: Partial<View> | ((v: View) => Partial<View>)) =>
  update($, viewAtom, v => ({ ...v, ...(typeof patch === 'function' ? patch(v) : patch) }))

const notify = ($: EngineInterface, kind: 'error' | 'info', text: string) => setView($, { notice: { kind, text: text.trim().slice(0, 600) } })

async function loadRecent($: EngineInterface): Promise<void> {
  try {
    const got = await $.store.get('recent')
    recent = Array.isArray(got) ? got.filter((p): p is string => typeof p === 'string') : []
  } catch {
    recent = []
  }
}

async function remember($: EngineInterface, root: string): Promise<void> {
  recent = [root, ...recent.filter(p => p !== root)].slice(0, MAX_RECENT)
  await $.store.set('recent', recent).catch(() => undefined)
}

/** The root of the repository holding `path`, or why there is none. */
async function rootOf($: EngineInterface, path: string): Promise<{ root: string; problem: string }> {
  const r = await gitOf($, path)(G.toplevel)
  if (r.ok && r.out) return { root: r.out, problem: '' }
  return { root: '', problem: /not a git repository/i.test(r.err) ? 'Not a git repository' : firstLine(r.err) || 'git could not run here' }
}

/** Reads status (and, when `isFull`, branches, log, stash, remote) into the pane's state. */
async function refresh($: EngineInterface, isFull = false): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    let repo = await read($, repoAtom)
    if (!repo.root) {
      // Nothing chosen yet: the chat's folder if it is in a repository, else the one used last.
      const cwd = await $.session.cwd()
      let found = await rootOf($, cwd)
      if (!found.root && recent[0]) found = await rootOf($, recent[0])
      if (!found.root) {
        await update($, repoAtom, r => (r.problem === found.problem ? r : { ...NO_REPO, problem: found.problem }))
        return
      }
      await remember($, found.root)
      repo = { ...NO_REPO, root: found.root }
      await update($, repoAtom, () => repo)
      isFull = true
    }
    const git = gitOf($, repo.root)
    const s = await git(G.STATUS_ARGS, { raw: true })
    if (!s.ok) {
      await update($, repoAtom, r => ({ ...r, status: null, problem: firstLine(s.err) || 'git status failed' }))
      return
    }
    const status = G.parseStatus(s.out)
    let extra: Partial<Repo> = {}
    if (isFull || !same(repo.status?.branch, status.branch)) {
      const [br, lg, up, st, rm] = await Promise.all([
        git(G.branches),
        status.hasHead ? git(G.LOG_ARGS) : Promise.resolve({ ok: true, code: 0, out: '', err: '' }),
        status.branch.upstream && status.hasHead ? git(G.unpushed) : Promise.resolve({ ok: true, code: 0, out: '', err: '' }),
        git(G.stashList),
        git(G.remotes),
      ])
      const unpushed = new Set(up.out.split('\n').filter(Boolean))
      extra = {
        branches: br.ok ? G.parseBranches(br.out) : [],
        commits: lg.ok ? G.parseLog(lg.out, unpushed) : [],
        stashCount: st.out ? st.out.split('\n').length : 0,
        remote: rm.out.split('\n')[0] ?? '',
      }
    }
    const changed = !same(repo.status, status)
    await update($, repoAtom, r => ({ ...r, ...extra, status, problem: '' }))
    if (changed) await reloadDiffs($)
  } catch {
    // A failed check leaves what is shown; the next one tries again.
  } finally {
    isRefreshing = false
  }
}

// ---------------------------------------------------------------------------
// Diffs of the rows the person opened

const findChange = (repo: Repo, key: string): { change: Change; isStaged: boolean } | null => {
  const path = key.slice(2)
  const s = repo.status
  if (!s) return null
  if (key.startsWith('s:')) {
    const c = s.staged.find(x => x.path === path)
    return c ? { change: c, isStaged: true } : null
  }
  const c = [...s.unstaged, ...s.conflicts].find(x => x.path === path)
  return c ? { change: c, isStaged: false } : null
}

async function loadDiff($: EngineInterface, key: string): Promise<void> {
  const repo = await read($, repoAtom)
  if (!repo.root) return
  const git = gitOf($, repo.root)
  let view: DiffView
  if (key.startsWith('c:')) {
    const r = await git(G.showStat(key.slice(2)))
    view = { text: '', note: r.out || r.err || 'No details.' }
  } else {
    const found = findChange(repo, key)
    if (!found) return
    const cmd = G.diffCmd(found.change, found.isStaged)
    const r = await git(cmd.args, { okCodes: cmd.okCodes, raw: true })
    view = r.ok ? G.prepareDiff(r.out) : { text: '', note: firstLine(r.err) || 'git could not show this file.' }
  }
  await setView($, v => (v.expanded.includes(key) ? { diffs: { ...v.diffs, [key]: view } } : {}))
}

async function reloadDiffs($: EngineInterface): Promise<void> {
  const v = await read($, viewAtom)
  const repo = await read($, repoAtom)
  // A row whose file is no longer in that group closes.
  const gone = v.expanded.filter(k => !k.startsWith('c:') && !findChange(repo, k))
  if (gone.length) await setView($, cur => ({ expanded: cur.expanded.filter(k => !gone.includes(k)), diffs: Object.fromEntries(Object.entries(cur.diffs).filter(([k]) => !gone.includes(k))) }))
  for (const k of v.expanded.filter(k => !gone.includes(k) && !k.startsWith('c:'))) await loadDiff($, k)
}

async function toggleRow($: EngineInterface, key: string): Promise<void> {
  const v = await read($, viewAtom)
  if (v.expanded.includes(key)) {
    await setView($, cur => ({ expanded: cur.expanded.filter(k => k !== key) }))
    return
  }
  // Few at once: the drawing holds a bounded amount of text.
  await setView($, cur => ({ expanded: [...cur.expanded, key].slice(-MAX_OPEN_DIFFS) }))
  await loadDiff($, key)
}

// ---------------------------------------------------------------------------
// Actions: one at a time, each ending in a refresh and a notice

/** Runs one action behind the busy lock; `fn` returns an info line, or throws with the reason. */
async function act($: EngineInterface, busy: string, fn: (git: G.GitFn, repo: Repo) => Promise<string | void>): Promise<boolean> {
  if (isBusy) {
    await notify($, 'info', 'Wait for the current action to finish.')
    return false
  }
  const repo = await read($, repoAtom)
  if (!repo.root) {
    await notify($, 'error', repo.problem || 'No repository.')
    return false
  }
  isBusy = true
  let ok = true
  await setView($, { busy, notice: null, confirm: '' })
  try {
    const info = await fn(gitOf($, repo.root), repo)
    if (info) await notify($, 'info', info)
  } catch (err) {
    ok = false
    await notify($, 'error', String(err instanceof Error ? err.message : err))
  } finally {
    isBusy = false
    await setView($, { busy: '' })
  }
  isRefreshing = false
  await refresh($, true)
  return ok
}

const must = (r: G.Git, what: string): G.Git => {
  if (!r.ok) throw new Error(`${what}: ${r.err || r.out || `exit ${r.code}`}`)
  return r
}

const stageOne = ($: EngineInterface, c: Change) => act($, 'Staging…', async git => void must(await git(G.stage([c.path, ...(c.orig ? [c.orig] : [])])), 'git add'))
const stageEverything = ($: EngineInterface) => act($, 'Staging all…', async git => void must(await git(G.stageAll), 'git add'))
const unstageOne = ($: EngineInterface, c: Change, hasHead: boolean) =>
  act($, 'Unstaging…', async git => {
    // Before the first commit there is no HEAD to reset to: take the file out of the index.
    const r = hasHead ? await git(G.unstage([c.path, ...(c.orig ? [c.orig] : [])])) : await git(['rm', '--cached', '-q', '--', c.path])
    must(r, 'git reset')
  })
const unstageEverything = ($: EngineInterface, hasHead: boolean) =>
  act($, 'Unstaging all…', async git => void must(hasHead ? await git(G.unstageAll) : await git(['rm', '-r', '--cached', '-q', '--', '.']), 'git reset'))

const discardOne = ($: EngineInterface, c: Change) =>
  act($, 'Discarding…', async git => void must(c.isUntracked ? await git(G.clean([c.path])) : await git(G.restore([c.path])), 'discard'))
const discardEverything = ($: EngineInterface, status: NonNullable<Repo['status']>) =>
  act($, 'Discarding all…', async git => {
    if (status.unstaged.some(c => !c.isUntracked)) must(await git(G.restoreAll), 'git restore')
    if (status.unstaged.some(c => c.isUntracked)) must(await git(G.cleanAll), 'git clean')
  })

/** Press once to arm, press again to run: a discard is never one click. */
async function confirmed($: EngineInterface, id: string, run: () => Promise<unknown>): Promise<void> {
  const v = await read($, viewAtom)
  if (v.confirm !== id) {
    await setView($, { confirm: id })
    return
  }
  await setView($, { confirm: '' })
  await run()
}

async function pushFlow(git: G.GitFn, repo: Repo): Promise<string> {
  const branch = repo.status?.branch
  if (!branch || branch.isDetached) throw new Error('Push: HEAD is detached; switch to a branch first.')
  let r = await git(G.push, { timeoutMs: G.NETWORK_MS })
  if (!r.ok && G.needsUpstream(r.err)) {
    if (!repo.remote) throw new Error('Push: this repository has no remote. Add one with `git remote add origin <url>`.')
    r = await git(G.pushUpstream(repo.remote, branch.name), { timeoutMs: G.NETWORK_MS })
  }
  must(r, 'Push')
  return `Pushed ${branch.name}.`
}

async function pullFlow(git: G.GitFn): Promise<string> {
  const r = await git(G.pull, { timeoutMs: G.NETWORK_MS })
  if (!r.ok) {
    const s = G.parseStatus((await git(G.STATUS_ARGS, { raw: true })).out)
    if (s.conflicts.length) throw new Error(`Pull stopped on ${plural(s.conflicts.length, 'conflict')}. Resolve them in the files, stage them, then continue the rebase or merge in a terminal.`)
    throw new Error(`Pull: ${r.err || r.out}`)
  }
  return firstLine(r.out) || 'Pulled.'
}

async function commitFlow($: EngineInterface, mode: CommitMode, isStageAll = false): Promise<void> {
  const [repo, v] = [await read($, repoAtom), await read($, viewAtom)]
  const status = repo.status
  if (!status) return
  const message = v.message.trim()
  if (!message) {
    await notify($, 'info', 'Write a commit message first, or press ✨ Generate.')
    return
  }
  const isAmend = mode === 'amend'
  if (!isAmend && !status.staged.length && !isStageAll) {
    if (!status.unstaged.length && !status.conflicts.length) {
      await notify($, 'info', 'Nothing to commit.')
      return
    }
    await setView($, { confirm: 'stage-all-commit' })
    return
  }
  const done = await act($, isAmend ? 'Amending…' : 'Committing…', async git => {
    if (isStageAll) must(await git(G.stageAll), 'git add')
    // Repository hooks do not run: the engine starts git with them off.
    must(await git(G.commit(isAmend), { stdin: `${message}\n` }), 'Commit')
    await setView($, { message: '' })
    if (mode === 'push') return pushFlow(git, repo).then(t => `Committed. ${t}`)
    if (mode === 'sync') {
      const pulled = await pullFlow(git)
      const pushed = await pushFlow(git, repo)
      return `Committed. ${pulled} ${pushed}`
    }
    return isAmend ? 'Amended the last commit.' : 'Committed.'
  })
  if (!done) await setView($, { message })
}

async function syncFlow($: EngineInterface): Promise<void> {
  await act($, 'Syncing…', async (git, repo) => {
    const pulled = await pullFlow(git)
    const ahead = G.parseStatus((await git(G.STATUS_ARGS, { raw: true })).out).branch
    const pushed = ahead.ahead || !ahead.upstream ? await pushFlow(git, repo) : 'Nothing to push.'
    return `${pulled} ${pushed}`
  })
}

async function checkout($: EngineInterface, name: string): Promise<void> {
  await act($, `Switching to ${name}…`, async git => void must(await git(G.switchTo(name)), 'Switch'))
  await setView($, { drawer: '' })
}

async function createBranch($: EngineInterface, raw: string): Promise<void> {
  const name = G.cleanBranchName(raw)
  if (!name) {
    await notify($, 'error', 'That is not a valid branch name (no spaces, "..", leading "-", or a trailing "/" or ".").')
    return
  }
  if (await act($, `Creating ${name}…`, async git => void must(await git(G.createBranch(name)), 'Create branch'))) await setView($, { drawer: '', field: '' })
}

async function openRepo($: EngineInterface, raw: string): Promise<void> {
  const path = raw.trim().replace(/^~(?=\/|$)/, (await $.env.get('HOME')) ?? '~')
  if (!path) return
  const found = await rootOf($, path)
  if (!found.root) {
    await notify($, 'error', `${path}: ${found.problem}`)
    return
  }
  await remember($, found.root)
  await update($, repoAtom, () => ({ ...NO_REPO, root: found.root }))
  await setView($, { ...NO_VIEW, folded: ['commits'] })
  isRefreshing = false
  await refresh($, true)
}

async function initHere($: EngineInterface, raw: string): Promise<void> {
  const path = raw.trim() || (await $.session.cwd())
  const r = await gitOf($, path)(G.init)
  if (!r.ok) {
    await notify($, 'error', r.err || 'git init failed')
    return
  }
  await openRepo($, path)
}

// ---------------------------------------------------------------------------
// The generate button

async function generate($: EngineInterface, model: string): Promise<void> {
  const repo = await read($, repoAtom)
  const status = repo.status
  if (!repo.root || !status) return
  const scope = status.staged.length ? 'staged' : 'unstaged'
  if (!status.staged.length && !status.unstaged.length) {
    await notify($, 'info', 'Nothing to describe. Change or stage a file first.')
    return
  }
  const git = gitOf($, repo.root)
  stop = new AbortController()
  await setView($, { isGenerating: true, notice: null, busy: 'Writing a commit message…' })
  try {
    const base = [...G.DIFF, ...(scope === 'staged' ? ['--cached', '-M'] : [])]
    const [stat, diff, log] = await Promise.all([
      git([...base, '--stat', '--stat-width=100']),
      git([...base], { raw: true }),
      status.hasHead ? git(['log', '-n', '10', '--format=%s']) : Promise.resolve({ ok: true, code: 0, out: '', err: '' }),
    ])
    const prompt = buildPrompt({
      branch: status.branch.name,
      recent: log.out.split('\n').filter(Boolean),
      stat: stat.out,
      diff: trimDiff(splitDiff(diff.out)),
      scope,
      untracked: scope === 'unstaged' ? status.unstaged.filter(c => c.isUntracked).map(c => c.path).slice(0, 40) : [],
    })
    const r = await $.model.complete({ model, system: RULES, prompt, maxTokens: 1500, effort: 'low' }, { signal: stop.signal })
    if (r.isAnswered) {
      const text = cleanMessage(r.text)
      if (text) await setView($, { message: text, notice: scope === 'unstaged' ? { kind: 'info', text: 'Nothing was staged, so this describes your working-tree changes. Stage them before committing.' } : null })
      else await notify($, 'error', 'The model returned an empty message.')
    } else if (r.reason !== 'aborted') {
      await notify($, 'error', `Could not write a message (${r.reason}${'status' in r && r.status ? ` ${r.status}` : ''}).`)
    }
  } catch (err) {
    await notify($, 'error', `Could not write a message: ${String(err instanceof Error ? err.message : err)}`)
  } finally {
    stop = null
    await setView($, { isGenerating: false, busy: '' })
  }
}

// ---------------------------------------------------------------------------
// The pane

const openPane = ($: EngineInterface): Promise<void> => $.ui.open({ id: PANE, title: TITLE }).then(() => undefined, () => undefined)

async function setPane($: EngineInterface, open: boolean): Promise<void> {
  isOpen = open
  if (open) {
    await openPane($)
    await refresh($, true)
  } else {
    await $.ui.close({ id: PANE })
  }
}

/** Follows the Switchboard: closes the pane when switched off or hidden, opens it when asked to. */
async function follow($: EngineInterface): Promise<void> {
  const s = await readSwitch($, PANE)
  isOff = s.isOff
  isHidden = s.isHidden
  const isAsked = await takeOpenRequest($, PANE)
  if (isOff || isHidden) {
    if (isOpen) await setPane($, false).catch(() => undefined)
  } else if (isAsked && !isOpen) await setPane($, true)
}

export const register: Register = (on, options) => {
  const seconds = Math.max(2, Number(options.refreshSeconds) || 3)
  const model = String(options.commitModel || 'haiku')

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'scm', description: 'Show or hide the Source Control pane: changes, diffs, stage, commit, push, pull', immediate: true })
    await loadRecent($)
    await follow($)
    $.clock.every(3000, () => {
      void follow($).catch(() => undefined)
    })
    // Quiet when the pane is shut: only a shown pane keeps git busy.
    $.clock.every(seconds * 1000, () => {
      if (isOpen && !isBusy) void refresh($)
    })
    return started
  })

  on('command.run', { command: 'scm' }, async $ => {
    if (isOff) return { text: 'Source Control is off. Turn it on with /switchboard.' }
    if (isHidden) {
      await clearHidden($, PANE)
      isHidden = false
    }
    const up = (await $.ui.panes()).some(p => p.id === PANE)
    await setPane($, !up)
    return { text: up ? 'Source Control closed.' : 'Source Control opened.' }
  })

  // The chat's own edits show up at once, without waiting for the timer.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (!isOff && !isHidden && /^(Bash|Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool) && (ran as { deny?: unknown }).deny === undefined) {
        if (isOpen) void refresh($)
        else if (options.autoOpen === 'first-change' && !hasAutoOpened) {
          await refresh($)
          const s = (await read($, repoAtom)).status
          if (s && (s.staged.length || s.unstaged.length)) {
            hasAutoOpened = true
            await setPane($, true)
          }
        }
      }
    } catch {
      // A courtesy: never hold up the tool.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isOpen = true
    const els = $.ui.resolve(e)
    // The phone app draws no text field yet, and a commit box needs one.
    if (!('Input' in els)) return <els.Text>Source Control needs a surface with text fields: use the terminal, the desktop app or the editor.</els.Text>
    const { Box, Text, Button, Input, Select, Code } = els
    const width = Math.max(28, e.props.bodyColumns || 44)
    const inner = width - 4
    const repo = await read($, repoAtom)
    const v = await read($, viewAtom)
    const status = repo.status
    if (!repo.status && !repo.problem && !isRefreshing) void refresh($, true)

    const hasHead = status?.hasHead ?? false
    const staged = status?.staged ?? []
    const changes = status?.unstaged ?? []
    const conflicts = status?.conflicts ?? []
    const branch = status?.branch
    const toggleFold = (id: string) => setView($, cur => ({ folded: cur.folded.includes(id) ? cur.folded.filter(x => x !== id) : [...cur.folded, id] }))
    const name = repo.root.split('/').filter(Boolean).pop() ?? ''

    // ---- header: title, the generate and commit shortcuts, refresh, the overflow menu
    const MENU = [
      { value: '', label: '⋯' },
      { value: 'pull', label: 'Pull' },
      { value: 'push', label: 'Push' },
      { value: 'sync', label: 'Sync (pull, then push)' },
      { value: 'fetch', label: 'Fetch' },
      { value: 'branch', label: 'Switch branch…' },
      { value: 'newbranch', label: 'Create branch…' },
      { value: 'stash', label: 'Stash changes' },
      { value: 'pop', label: `Pop stash${repo.stashCount ? ` (${repo.stashCount})` : ''}` },
      { value: 'undo', label: 'Undo last commit' },
      { value: 'repo', label: 'Open repository…' },
    ]
    const menu = async (value: string) => {
      if (value === 'pull') await act($, 'Pulling…', git => pullFlow(git))
      else if (value === 'push') await act($, 'Pushing…', (git, r) => pushFlow(git, r))
      else if (value === 'sync') await syncFlow($)
      else if (value === 'fetch') await act($, 'Fetching…', async git => void must(await git(G.fetchAll, { timeoutMs: G.NETWORK_MS }), 'Fetch'))
      else if (value === 'branch' || value === 'newbranch' || value === 'repo') await setView($, cur => ({ drawer: cur.drawer === value ? '' : value, field: '' }))
      else if (value === 'stash') await act($, 'Stashing…', async git => void must(await git(G.stashPush(`scm ${branch?.name ?? ''}`.trim())), 'Stash'))
      else if (value === 'pop') await act($, 'Popping stash…', async git => void must(await git(G.stashPop), 'Stash pop'))
      else if (value === 'undo') await setView($, { confirm: 'undo' })
    }
    const generateButton = v.isGenerating ? (
      <Button key="generate" label="✕ Cancel" onPress={() => stop?.abort()} />
    ) : (
      <Button key="generate" label="✨ Generate" onPress={() => void generate($, model)} />
    )

    const header = (
      <Box key="header" flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold>{TITLE}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="hdr-generate" plain label={v.isGenerating ? '…' : '✨'} onPress={() => (v.isGenerating ? stop?.abort() : void generate($, model))} />
          <Button key="hdr-commit" plain label="✓" onPress={() => void commitFlow($, v.mode)} />
          <Button key="hdr-refresh" plain label="⟳" onPress={() => void refresh($, true)} />
          <Select key="menu" options={MENU} value="" onSelect={value => void menu(value)} />
        </Box>
      </Box>
    )

    // ---- the repository, and a drawer under the header for what the person is choosing
    const repoLine = repo.root ? (
      <Text dimColor wrap="truncate-end">
        {name} <Text dimColor>{repo.root}</Text>
      </Text>
    ) : null
    const branchLine = branch ? (
      <Box key="branch" flexDirection="row" justifyContent="space-between" width={width}>
        <Text wrap="truncate-end">
          <Text color={ACCENT}>⎇ </Text>
          <Text bold>{branch.isDetached ? `(detached ${branch.oid.slice(0, 7)})` : branch.name || '(no commits yet)'}</Text>
          {branch.upstream ? <Text dimColor>{`  ${branch.upstream}`}</Text> : null}
        </Text>
        {branch.upstream && (branch.ahead || branch.behind) ? (
          <Button key="sync" label={`⟳ Sync ${branch.behind ? `↓${branch.behind}` : ''}${branch.ahead ? `↑${branch.ahead}` : ''}`} onPress={() => void syncFlow($)} />
        ) : !branch.upstream && hasHead && repo.remote && !branch.isDetached ? (
          <Button key="publish" label="☁ Publish Branch" onPress={() => void act($, 'Publishing…', (git, r) => pushFlow(git, r))} />
        ) : null}
      </Box>
    ) : null

    const drawer =
      v.drawer === 'repo' || !repo.root ? (
        <Box key="drawer-repo" flexDirection="column" width={width}>
          <Input
            key="repo-path"
            label="Repository: "
            placeholder="/path/to/repo (Enter to open)"
            value={v.field}
            onInput={value => void setView($, { field: value })}
            onSubmit={value => void openRepo($, value)}
          />
          {recent.length ? (
            <Select
              key="repo-recent"
              label="Recent: "
              options={[{ value: '', label: '—' }, ...recent.map(p => ({ value: p, label: p.split('/').filter(Boolean).slice(-2).join('/') }))]}
              value=""
              onSelect={value => value && void openRepo($, value)}
            />
          ) : null}
          {!repo.root ? <Button key="init" label="git init here" onPress={() => void initHere($, v.field)} /> : null}
        </Box>
      ) : v.drawer === 'branch' ? (
        <Select
          key="branch-pick"
          label="Switch to: "
          options={repo.branches.map(b => ({ value: b.name, label: `${b.isCurrent ? '● ' : '  '}${b.name}` }))}
          value={branch?.name ?? ''}
          onSelect={value => void checkout($, value)}
        />
      ) : v.drawer === 'newbranch' ? (
        <Input
          key="branch-new"
          label="New branch: "
          placeholder="feature/name (Enter to create and switch)"
          value={v.field}
          onInput={value => void setView($, { field: value })}
          onSubmit={value => void createBranch($, value)}
        />
      ) : null

    // ---- message, generate, commit
    const MODES: { value: CommitMode; label: string }[] = [
      { value: 'commit', label: '✓ Commit' },
      { value: 'push', label: '✓ Commit & Push' },
      { value: 'sync', label: '✓ Commit & Sync' },
      { value: 'amend', label: '✓ Amend last commit' },
    ]
    const modeLabel = MODES.find(m => m.value === v.mode)?.label ?? '✓ Commit'
    const composer = repo.root ? (
      <Box key="composer" flexDirection="column" width={width}>
        <Input
          key="scm-message"
          rows={3}
          placeholder="Message (Enter to commit, ✨ to write it)"
          value={v.message}
          onInput={value => void setView($, { message: value })}
          onSubmit={() => void commitFlow($, v.mode)}
        />
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {changes.length || conflicts.length ? <Button key="stage-all-row" label="+ Stage All" onPress={() => void stageEverything($)} /> : null}
          {generateButton}
          <Button key="commit" variant="primary" label={modeLabel} onPress={() => void commitFlow($, v.mode)} />
          <Select key="mode" options={MODES} value={v.mode} onSelect={value => void setView($, { mode: value as CommitMode })} />
        </Box>
      </Box>
    ) : null

    // ---- confirm rows and the status line
    const askRow = (text: string, yes: () => void) => (
      <Box key="ask" flexDirection="row" gap={1} width={width}>
        <Text color={YELLOW} wrap="truncate-end">
          {text}
        </Text>
        <Button key="ask-yes" label="Yes" onPress={yes} />
        <Button key="ask-no" label="No" onPress={() => void setView($, { confirm: '' })} />
      </Box>
    )
    const ask =
      v.confirm === 'stage-all-commit'
        ? askRow('Nothing staged. Stage all and commit?', () => void commitFlow($, v.mode, true))
        : v.confirm === 'undo'
          ? askRow('Undo the last commit, keeping its changes staged?', () => void confirmed($, 'undo', () => act($, 'Undoing…', async git => void must(await git(G.undoCommit), 'Undo'))))
          : v.confirm === 'discard-all' && status
            ? askRow(`Discard all ${plural(changes.length, 'change')}? This cannot be undone.`, () => void confirmed($, 'discard-all', () => discardEverything($, status)))
            : null
    const statusLine = v.busy ? (
      <Text key="busy" color={ACCENT}>{`⟳ ${v.busy}`}</Text>
    ) : v.notice ? (
      <Box key="notice" flexDirection="row" justifyContent="space-between" width={width} gap={1}>
        <Text color={v.notice.kind === 'error' ? RED : GREEN}>{v.notice.text}</Text>
        <Button key="notice-x" plain label="✕" onPress={() => void setView($, { notice: null })} />
      </Box>
    ) : repo.problem && repo.root ? (
      <Text key="problem" color={RED}>
        {repo.problem}
      </Text>
    ) : null

    // ---- the lists
    const diffBlock = (key: string, path: string) => {
      if (!v.expanded.includes(key)) return null
      const d = v.diffs[key]
      return (
        <Box key={`d:${key}`} flexDirection="column" width={inner} marginBottom={1}>
          {!d ? <Text dimColor>Loading…</Text> : d.text ? <Code source={d.text} format="diff" path={path} /> : <Text dimColor>{d.note}</Text>}
          {d?.text && d.note ? <Text dimColor>{d.note}</Text> : null}
        </Box>
      )
    }
    const fileRow = (group: 's' | 'u' | 'k', c: Change) => {
      const key = keyOf(group, c.path)
      const cut = c.path.lastIndexOf('/')
      const base = c.path.slice(cut + 1)
      const folder = cut > 0 ? c.path.slice(0, cut) : ''
      const isOpenRow = v.expanded.includes(key)
      const arming = v.confirm === `discard:${key}`
      const actions = (
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {group === 's' ? <Button key={`un:${key}`} plain label="−" onPress={() => void unstageOne($, c, hasHead)} /> : null}
          {group !== 's' && arming ? (
            <>
              <Text color={YELLOW}>Discard?</Text>
              <Button key={`yes:${key}`} plain label="Yes" onPress={() => void confirmed($, `discard:${key}`, () => discardOne($, c))} />
              <Button key={`no:${key}`} plain label="No" onPress={() => void setView($, { confirm: '' })} />
            </>
          ) : null}
          {group === 'u' && !arming ? <Button key={`rv:${key}`} plain label="↶" onPress={() => void confirmed($, `discard:${key}`, () => discardOne($, c))} /> : null}
          {group !== 's' && !arming ? <Button key={`st:${key}`} plain label="+" onPress={() => void stageOne($, c)} /> : null}
          <Text color={STATUS_COLOR[c.code] ?? YELLOW} bold>
            {c.code}
          </Text>
        </Box>
      )
      return (
        <Box key={key} flexDirection="column" width={inner}>
          <Box flexDirection="row" justifyContent="space-between" width={inner} gap={1}>
            <Box flexShrink={1} flexGrow={1} overflow="hidden">
              <Button key={`open:${key}`} plain onPress={() => void toggleRow($, key)}>
                <Text dimColor>{isOpenRow ? '▾ ' : '▸ '}</Text>
                <Text bold strikethrough={c.code === 'D'}>
                  {base}
                </Text>
                {folder ? <Text dimColor>{`  ${folder}`}</Text> : null}
              </Button>
            </Box>
            {actions}
          </Box>
          {diffBlock(key, c.path)}
        </Box>
      )
    }
    const capped = (rows: Change[], group: 's' | 'u' | 'k') => [
      ...rows.slice(0, MAX_ROWS).map(c => fileRow(group, c)),
      rows.length > MAX_ROWS ? <Text key={`more:${group}`} dimColor>{`+${rows.length - MAX_ROWS} more`}</Text> : null,
    ]
    const section = (id: string, title: string, rows: Change[], group: 's' | 'u' | 'k', tools: unknown) => {
      if (!rows.length) return null
      const isFolded = v.folded.includes(id)
      return (
        <Box key={id} flexDirection="column" width={width}>
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Button key={`fold:${id}`} plain onPress={() => void toggleFold(id)}>
              <Text dimColor>{isFolded ? '▸ ' : '▾ '}</Text>
              <Text bold>{title}</Text>
              <Text dimColor>{`  ${rows.length}`}</Text>
            </Button>
            <Box flexDirection="row" gap={1}>
              {tools as never}
            </Box>
          </Box>
          {isFolded ? null : capped(rows, group)}
        </Box>
      )
    }

    const commitsBlock = repo.commits.length ? (
      <Box key="commits" flexDirection="column" width={width}>
        <Button key="fold:commits" plain onPress={() => void toggleFold('commits')}>
          <Text dimColor>{v.folded.includes('commits') ? '▸ ' : '▾ '}</Text>
          <Text bold>Recent commits</Text>
        </Button>
        {v.folded.includes('commits')
          ? null
          : repo.commits.map(c => {
              const key = `c:${c.hash}`
              return (
                <Box key={key} flexDirection="column" width={inner}>
                  <Button key={`open:${key}`} plain onPress={() => void toggleRow($, key)}>
                    <Text color={c.isUnpushed ? ACCENT : undefined} dimColor={!c.isUnpushed}>{c.isUnpushed ? '↑ ' : '  '}</Text>
                    <Text dimColor>{`${c.short} `}</Text>
                    <Text>{c.subject}</Text>
                  </Button>
                  {v.expanded.includes(key) ? <Text dimColor>{v.diffs[key]?.note ?? 'Loading…'}</Text> : null}
                </Box>
              )
            })}
      </Box>
    ) : null

    const empty = repo.root && status && !staged.length && !changes.length && !conflicts.length ? <Text dimColor>No changes. The working tree is clean.</Text> : null
    const loading = repo.root && !status && !repo.problem ? <Text dimColor>Reading the repository…</Text> : null
    const noRepo = !repo.root ? <Text color={RED}>{repo.problem || 'Looking for a repository…'}</Text> : null

    return (
      <Box flexDirection="column" width={width} gap={1}>
        {header}
        <Box flexDirection="column" width={width}>
          {repoLine}
          {branchLine}
        </Box>
        {drawer}
        {composer}
        {ask}
        {statusLine}
        {noRepo}
        {loading}
        {section('conflicts', 'Merge Conflicts', conflicts, 'k', <Text dimColor>stage to resolve</Text>)}
        {section('staged', 'Staged Changes', staged, 's', <Button key="unstage-all" plain label="−" onPress={() => void unstageEverything($, hasHead)} />)}
        {section(
          'changes',
          'Changes',
          changes,
          'u',
          <>
            <Button key="discard-all" plain label="↶" onPress={() => void setView($, { confirm: 'discard-all' })} />
            <Button key="stage-all" plain label="+" onPress={() => void stageEverything($)} />
          </>,
        )}
        {empty}
        {commitsBlock}
      </Box>
    )
  })

  // The pane is shut: stop refreshing and drop what a closed pane no longer shows.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))
}
