import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/me'
const SWITCHES = `${HOME}/.claude/mods/switches.json`
const ASK = `${HOME}/.claude/mods/.open-savvy-progress-sid-1`

// A machine with a Switchboard file, an open request or neither.
const machine = (on: On, files: Record<string, string>) => {
  const seen = { opened: [] as string[], removed: [] as string[] }
  mock.clock(on)
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.id', () => ({ value: 'sid-1' }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('session.usage', () => ({ value: { context: {} } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }) as never)
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
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return seen
}

const start = ($: any) => $.session.start({ source: 'startup', cwd: '/work', surface: 'terminal', isInteractive: true } as never)

test('switched off: /agents-info says so and opens nothing', async ($, on) => {
  const seen = machine(on, { [SWITCHES]: JSON.stringify({ 'savvy-progress': false }) })
  await start($)
  const r = await $.command.run({ command: 'agents-info', args: '' } as never)
  expect(JSON.stringify(r)).toMatch(/Agents is off/)
  expect(seen.opened).toEqual([])
})

test('hidden: /agents-info shows it again for everyone and opens the pane', async ($, on) => {
  const files: Record<string, string> = { [SWITCHES]: JSON.stringify({ 'savvy-progress:hidden': true, other: false }) }
  const seen = machine(on, files)
  await start($)
  await $.command.run({ command: 'agents-info', args: '' } as never)
  expect(seen.opened).toContain('savvy-agents')
  expect(JSON.parse(files[SWITCHES] ?? '{}'), 'only its own key goes').toEqual({ other: false })
})

test('an open request from the Switchboard opens the pane once and is used up', async ($, on) => {
  const files: Record<string, string> = { [ASK]: '' }
  const seen = machine(on, files)
  await start($)
  expect(seen.opened).toContain('savvy-agents')
  expect(seen.removed).toEqual([ASK])
})

test('an open request is used up but not obeyed while the mod is off', async ($, on) => {
  const files: Record<string, string> = { [ASK]: '', [SWITCHES]: JSON.stringify({ 'savvy-progress': false }) }
  const seen = machine(on, files)
  await start($)
  expect(seen.opened).toEqual([])
  expect(ASK in files).toBe(false)
})
