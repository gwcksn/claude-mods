import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'source-control'
const ROOT = '/repo'
const pane = { title: '', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } as const

type Call = { args: string[]; stdin?: string; repo?: string }
type Fake = {
  calls: Call[]
  modelCalls: { model: string; prompt: string; system?: string }[]
  fail: (match: RegExp, stderr: string) => void
  setStatus: (z: string) => void
}

// A tiny git: it answers what the pane asks, from text the test sets, and records every argv.
const STATUS = (rows: string[], branch = '# branch.oid abc1234\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0') => branch + rows.join('\0') + (rows.length ? '\0' : '')
const MODIFIED = '1 .M N... 100644 100644 100644 aaa bbb src/app.ts'
const STAGED = '1 M. N... 100644 100644 100644 aaa bbb lib/util.ts'
const UNTRACKED = '? notes/todo.md'
const DIFF = 'diff --git a/src/app.ts b/src/app.ts\nindex aaa..bbb 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n keep\n-old line\n+new line\n+another\n'

function git(on: On, opts: { reply?: string; stagedDiff?: string } = {}): Fake {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  let status = STATUS([STAGED, MODIFIED, UNTRACKED])
  const fails: [RegExp, string][] = []
  const fake: Fake = {
    calls: [],
    modelCalls: [],
    fail: (match, stderr) => void fails.push([match, stderr]),
    setStatus: z => void (status = z),
  }
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('model.complete', (_$, e) => {
    fake.modelCalls.push({ model: e.model, prompt: String(e.prompt), system: typeof e.system === 'string' ? e.system : undefined })
    return { value: { isAnswered: true, text: opts.reply ?? 'feat(app): add another line\n\nWhy.\n\n- app.ts: new lines', usage: {} } } as never
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const at = argv.indexOf('-C')
    const args = at >= 0 ? argv.slice(at + 2) : argv
    fake.calls.push({ args, stdin: e.init?.stdin, repo: at >= 0 ? argv[at + 1] : undefined })
    const line = args.join(' ')
    const bad = fails.find(([re]) => re.test(line))
    if (bad) return { value: { exitCode: 1, stdout: '', stderr: bad[1], isStdoutTruncated: false, isStderrTruncated: false } }
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'rev-parse') return out(`${ROOT}\n`)
    if (args.includes('status')) return out(status)
    if (args[0] === 'diff' || args.includes('diff')) return out(args.includes('--stat') ? ' src/app.ts | 3 ++-\n' : args.includes('--cached') && opts.stagedDiff ? opts.stagedDiff : DIFF)
    if (args[0] === 'branch') return out('main\t*\torigin/main\nfeature/x\t\t\n')
    if (args[0] === 'remote') return out('origin\n')
    return out('')
  })
  return fake
}

const open = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: pane })

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }): Promise<string> => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

// The first draw starts a read of git; give it a moment on the mocked clock, then draw again.
const ready = async (ui: Awaited<ReturnType<typeof open>>) => {
  await ui.redraw()
  await ui.redraw()
}

const ran = (f: Fake, line: string) => f.calls.some(c => c.args.join(' ') === line)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the pane lists staged and changed files under the branch`, async ($, on) => {
    git(on)
    const ui = await open($, surface)
    await ready(ui)
    const all = await texts(ui)
    expect(all).toMatch(/main/)
    expect(all).toMatch(/Staged Changes/)
    expect(all).toMatch(/lib\/util\.ts|util\.ts/)
    expect(all).toMatch(/Changes/)
    expect(all).toMatch(/app\.ts/)
    expect(all).toMatch(/todo\.md/)
    expect(await ui.find({ key: 'generate' })).toBeDefined()
    expect(await ui.find({ key: 'hdr-generate' })).toBeDefined()
    expect(await ui.find({ key: 'commit' })).toBeDefined()
  })
}

test('clicking a file shows its changes, and clicking again hides them', async ($, on) => {
  git(on)
  const ui = await open($)
  await ready(ui)
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(0)
  await ui.press({ key: 'open:u:src/app.ts' })
  const code = await ui.findAll({ type: 'Code' })
  expect(code).toHaveLength(1)
  expect(String(code[0]?.props.source)).toContain('+new line')
  expect(code[0]?.props.format).toBe('diff')
  await ui.press({ key: 'open:u:src/app.ts' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(0)
})

test('stage, unstage and stage-all run the right git commands', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.press({ key: 'st:u:src/app.ts' })
  expect(ran(f, 'add -- src/app.ts')).toBe(true)
  await ui.press({ key: 'un:s:lib/util.ts' })
  expect(ran(f, 'reset -q -- lib/util.ts')).toBe(true)
  await ui.press({ key: 'stage-all' })
  expect(ran(f, 'add -A')).toBe(true)
  f.calls.length = 0
  // The button beside Generate and Commit does the same.
  await ui.press({ key: 'stage-all-row' })
  expect(ran(f, 'add -A')).toBe(true)
  await ui.press({ key: 'unstage-all' })
  expect(ran(f, 'reset -q')).toBe(true)
})

test('discarding needs a second press, and cancelling runs nothing', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.press({ key: 'rv:u:src/app.ts' })
  expect(ran(f, 'restore --worktree -- src/app.ts')).toBe(false)
  expect(await texts(ui)).toMatch(/Discard\?/)
  await ui.press({ key: 'no:u:src/app.ts' })
  expect(ran(f, 'restore --worktree -- src/app.ts')).toBe(false)
  await ui.press({ key: 'rv:u:src/app.ts' })
  await ui.press({ key: 'yes:u:src/app.ts' })
  expect(ran(f, 'restore --worktree -- src/app.ts')).toBe(true)
  // An untracked file is cleaned, not restored.
  await ui.press({ key: 'rv:u:notes/todo.md' })
  await ui.press({ key: 'yes:u:notes/todo.md' })
  expect(ran(f, 'clean -fdq -- notes/todo.md')).toBe(true)
})

test('discard all asks first, then restores and cleans', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.press({ key: 'discard-all' })
  expect(ran(f, 'restore --worktree -- .')).toBe(false)
  await ui.press({ key: 'ask-yes' })
  expect(ran(f, 'restore --worktree -- .')).toBe(true)
  expect(ran(f, 'clean -fdq')).toBe(true)
})

test('commit pipes the message on stdin, as typed, and clears the box', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.input({ key: 'scm-message', text: 'fix: handle "quotes" and $HOME\n\n- bullet', kind: 'change' })
  await ui.press({ key: 'commit' })
  const c = f.calls.find(x => x.args[0] === 'commit')
  expect(c?.args).toEqual(['commit', '-F', '-'])
  expect(c?.stdin).toBe('fix: handle "quotes" and $HOME\n\n- bullet\n')
})

test('commit with an empty message does nothing but say why', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.press({ key: 'commit' })
  expect(f.calls.some(x => x.args[0] === 'commit')).toBe(false)
  expect(await texts(ui)).toMatch(/commit message/i)
})

test('with nothing staged, commit offers to stage everything first', async ($, on) => {
  const f = git(on)
  f.setStatus(STATUS([MODIFIED]))
  const ui = await open($)
  await ready(ui)
  await ui.input({ key: 'scm-message', text: 'feat: x', kind: 'change' })
  await ui.press({ key: 'commit' })
  expect(f.calls.some(x => x.args[0] === 'commit')).toBe(false)
  await ui.press({ key: 'ask-yes' })
  const order = f.calls.map(x => x.args[0]).filter(a => a === 'add' || a === 'commit')
  expect(order).toEqual(['add', 'commit'])
})

test('a failed commit keeps the message and shows git\'s reason', async ($, on) => {
  const f = git(on)
  f.fail(/^commit /, 'fatal: unable to auto-detect email address')
  const ui = await open($)
  await ready(ui)
  await ui.input({ key: 'scm-message', text: 'feat: keep me', kind: 'change' })
  await ui.press({ key: 'commit' })
  await ui.redraw()
  expect(await texts(ui)).toMatch(/unable to auto-detect email/)
  expect((await ui.find({ key: 'scm-message' }))?.props.value).toBe('feat: keep me')
})

test('the generate button asks Haiku for a message from the staged diff and fills the box', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.press({ key: 'generate' })
  await ui.redraw()
  expect(f.modelCalls).toHaveLength(1)
  expect(f.modelCalls[0]?.model).toBe('haiku')
  expect(f.modelCalls[0]?.prompt).toMatch(/STAGED/)
  expect(f.modelCalls[0]?.prompt).toMatch(/\+new line/)
  expect(f.modelCalls[0]?.system).toMatch(/Conventional Commits/)
  expect((await ui.find({ key: 'scm-message' }))?.props.value).toMatch(/^feat\(app\): add another line/)
  // Nothing was committed: the person reads and edits it first.
  expect(f.calls.some(x => x.args[0] === 'commit')).toBe(false)
})

test('the header ✨ generates too, and secrets are never in the prompt', async ($, on) => {
  const f = git(on, { stagedDiff: 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-KEY=old\n+KEY=SUPER_SECRET_TOKEN\n' })
  const ui = await open($)
  await ready(ui)
  await ui.press({ key: 'hdr-generate' })
  await ui.redraw()
  expect(f.modelCalls).toHaveLength(1)
  expect(f.modelCalls[0]?.prompt).not.toMatch(/SUPER_SECRET_TOKEN/)
  expect(f.modelCalls[0]?.prompt).toMatch(/contents not sent/)
})

test('push falls back to --set-upstream when the branch has none', async ($, on) => {
  const f = git(on)
  f.setStatus(STATUS([STAGED], '# branch.oid abc\0# branch.head topic\0'))
  f.fail(/^push$/, 'fatal: The current branch topic has no upstream branch.')
  const ui = await open($)
  await ready(ui)
  await ui.input({ key: 'menu', text: 'push' } as never).catch(() => undefined)
  await ui.select({ key: 'menu', value: 'push' })
  expect(ran(f, 'push')).toBe(true)
  expect(ran(f, 'push --set-upstream origin topic')).toBe(true)
})

test('commit & push and sync run commit, pull and push in order', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.select({ key: 'mode', value: 'sync' })
  await ui.input({ key: 'scm-message', text: 'feat: all', kind: 'change' })
  await ui.press({ key: 'commit' })
  const order = f.calls.map(x => x.args[0]).filter(a => a === 'commit' || a === 'pull' || a === 'push')
  expect(order).toEqual(['commit', 'pull', 'push'])
})

test('a pull that stops on conflicts says so and lists them', async ($, on) => {
  const f = git(on)
  f.fail(/^pull$/, 'CONFLICT (content): Merge conflict in a.txt')
  f.setStatus(STATUS(['u UU N... 100644 100644 100644 100644 a b c a.txt']))
  const ui = await open($)
  await ready(ui)
  await ui.select({ key: 'menu', value: 'pull' })
  await ui.redraw()
  expect(await texts(ui)).toMatch(/1 conflict/)
  expect(await texts(ui)).toMatch(/Merge Conflicts/)
})

test('amend commits with --amend', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.select({ key: 'mode', value: 'amend' })
  await ui.input({ key: 'scm-message', text: 'feat: better', kind: 'change' })
  await ui.press({ key: 'commit' })
  expect(f.calls.find(x => x.args[0] === 'commit')?.args).toEqual(['commit', '--amend', '-F', '-'])
})

test('outside a repository the pane says so and offers git init and a path field', async ($, on) => {
  const f = git(on)
  f.fail(/rev-parse/, 'fatal: not a git repository (or any of the parent directories): .git')
  const ui = await open($)
  await ready(ui)
  const all = await texts(ui)
  expect(all).toMatch(/Not a git repository/)
  expect(await ui.find({ key: 'repo-path' })).toBeDefined()
  expect(await ui.find({ key: 'init' })).toBeDefined()
  expect(await ui.find({ key: 'scm-message' })).toBeUndefined()
})

test('opening another repository asks git about that path', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  await ui.select({ key: 'menu', value: 'repo' })
  await ui.input({ key: 'repo-path', text: '/other/place', kind: 'submit' })
  expect(f.calls.some(x => x.args[0] === 'rev-parse' && x.repo === '/other/place')).toBe(true)
})

test('Stage All sits with Generate and Commit, and is not there when nothing is left to stage', async ($, on) => {
  const f = git(on)
  const ui = await open($)
  await ready(ui)
  expect(await ui.find({ key: 'stage-all-row' })).toBeDefined()
  f.setStatus(STATUS([STAGED]))
  await ui.press({ key: 'hdr-refresh' })
  expect(await ui.find({ key: 'stage-all-row' })).toBeUndefined()
  expect(await ui.find({ key: 'generate' })).toBeDefined()
})
