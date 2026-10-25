import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/me'
const SWITCHES = `${HOME}/.claude/mods/switches.json`
const ASK = `${HOME}/.claude/mods/.open-source-control-sid-1`

// A machine with a Switchboard file, an open request or neither, and a git that answers "no repository".
const machine = (on: On, files: Record<string, string>) => {
  const seen = { opened: [] as string[], closed: [] as string[], removed: [] as string[] }
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'sid-1' }) as never)
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [] }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path in files }) as never)
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }) as never)
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'rm') {
      seen.removed.push(String(argv[argv.length - 1]))
      delete files[String(argv[argv.length - 1])]
    }
    return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return seen
}

const start = ($: any) => $.session.start({ source: 'startup', cwd: '/work', surface: 'terminal', isInteractive: true } as never)

test('switched off: /scm says so and opens nothing', async ($, on) => {
  const seen = machine(on, { [SWITCHES]: JSON.stringify({ 'source-control': false }) })
  await start($)
  const r = await $.command.run({ command: 'scm', args: '' } as never)
  expect(JSON.stringify(r)).toMatch(/Source Control is off/)
  expect(seen.opened).toEqual([])
})

test('hidden: /scm shows it again for everyone and opens the pane', async ($, on) => {
  const files: Record<string, string> = { [SWITCHES]: JSON.stringify({ 'source-control:hidden': true, other: false }) }
  const seen = machine(on, files)
  await start($)
  await $.command.run({ command: 'scm', args: '' } as never)
  expect(seen.opened).toContain('source-control')
  expect(JSON.parse(files[SWITCHES] ?? '{}'), 'only its own key goes').toEqual({ other: false })
})

test('an open request from the Switchboard opens the pane once and is used up', async ($, on) => {
  const files: Record<string, string> = { [ASK]: '' }
  const seen = machine(on, files)
  await start($)
  expect(seen.opened).toContain('source-control')
  expect(seen.removed).toEqual([ASK])
  expect(ASK in files).toBe(false)
})

test('an open request is used up but not obeyed while the mod is off', async ($, on) => {
  const files: Record<string, string> = { [ASK]: '', [SWITCHES]: JSON.stringify({ 'source-control': false }) }
  const seen = machine(on, files)
  await start($)
  expect(seen.opened).toEqual([])
  expect(ASK in files).toBe(false)
})
