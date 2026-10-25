import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fingerprintOf, iconRows, parseLaunch, parseNotification } from './register'

const PLUGIN = 'delegate-monitor'
const PANE = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('parses the opencode commands Claude has been running', () => {
  const a = parseLaunch(
    `cd /home/gilang/Codes/gmt && opencode run --auto -m commandcode/MiniMaxAI/MiniMax-M3 --title "Scaffold user service" "Read PLAN.md and build it" 2>&1 | tail -50`,
  )
  expect(a).toEqual({ agent: 'opencode', title: 'Scaffold user service', model: 'MiniMax-M3', prompt: 'Read PLAN.md and build it', cwd: '/home/gilang/Codes/gmt' })

  const b = parseLaunch(`opencode run --standalone 'fix the failing tests in api/'`, '')
  expect(b?.title).toBe('fix the failing tests in api/')
  expect(b?.model).toBe('')
  expect(parseLaunch(`opencode run --auto -m kilo/kilo-auto/free --title "R" "x"`)?.model).toBe('kilo-auto/free')

  const c = parseLaunch(`opencode run --auto "$(cat /tmp/brief.md)"`, 'Delegate refactor to opencode')
  expect(c?.title).toBe('Delegate refactor to opencode')
})

test('parses codex exec and leaves other commands alone', () => {
  const c = parseLaunch(`codex exec -m gpt-5.5-codex --full-auto "add pagination to the list endpoint"`)
  expect(c?.agent).toBe('codex')
  expect(c?.model).toBe('gpt-5.5-codex')
  expect(c?.title).toBe('add pagination to the list endpoint')
  expect(parseLaunch('opencode --help')).toBeNull()
  expect(parseLaunch('opencode run --help 2>&1 | head -30')).not.toBeNull()
  expect(parseLaunch('ls ~/codex')).toBeNull()
  expect(parseLaunch('grep -r "opencode" .')).toBeNull()
})

test('fingerprint is a plain piece of the title or prompt', () => {
  const l = parseLaunch(`opencode run --title "Fix: login bug (#12)" "go"`)!
  expect(fingerprintOf(l, true)).toBe('login bug')
})

test('reads how a background task ended', () => {
  const done = `<task-notification><task-id>b7x</task-id><status>completed</status><summary>Background command "opencode run" completed (exit code 0)</summary></task-notification>`
  expect(parseNotification(done)).toEqual({ taskId: 'b7x', status: 'done' })
  expect(parseNotification(done.replace('exit code 0', 'exit code 1'))?.status).toBe('failed')
  expect(parseNotification(done.replace('completed</status>', 'killed</status>'))?.status).toBe('killed')
  expect(parseNotification('hello')).toBeNull()
})

test('a running icon hops and a finished one stands still', () => {
  const flat = (rows: { text: string; color?: string; bg?: string }[][]) => JSON.stringify(rows)
  const still = [0, 1, 2, 3].map(t => flat(iconRows('opencode', t)))
  expect(new Set(still).size).toBe(1)
  const hops = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(t => flat(iconRows('codex', t, 0)))
  expect(new Set(hops).size).toBeGreaterThan(3)
  for (let t = 0; t < 10; t++) {
    const rows = iconRows('codex', t, 1)
    expect(rows).toHaveLength(6)
    for (const row of rows) expect(row.map(g => g.text).join('')).toHaveLength(9)
  }
})

// The engine beneath: Bash answers in the foreground or moves to the background.
async function engine($: Engine, on: On, events: string[] = []) {
  mock.clock(on)
  on('ui.open', (_$, e) => {
    events.push(`open ${e.id}`)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    events.push(`close ${e.id}`)
    return {} as never
  })
  on('ui.panes', () => ({ value: [] }) as never)
  on('tool.call', (_$, e) => {
    const cmd = String((e as { command?: string }).command ?? '')
    const background = cmd.includes('codex')
    return { result: { stdout: 'ok', stderr: '', interrupted: false, ...(background ? { backgroundTaskId: 'bg1' } : {}) } } as never
  })
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('terminal: runs show under Running and Finished, the pane opens itself, Clear keeps running ones', async ($, on) => {
  const events: string[] = []
  await engine($, on, events)
  await $.tool.call({ tool: 'Bash', command: 'opencode run --title "Write docs" "write the docs"' } as never)
  await $.tool.call({ tool: 'Bash', command: 'codex exec "port the tests"', run_in_background: true } as never)
  expect(events).toContain('open delegates')

  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'delegates', props: PANE })
  const all = await texts(pane)
  expect(all).toMatch(/Running · 1/)
  expect(all).toMatch(/Finished · 1/)
  expect(all).toMatch(/Write docs/)
  expect(all).toMatch(/port the tests/)

  await pane.press({ key: 'clear' })
  await pane.redraw()
  const after = await texts(pane)
  expect(after).not.toMatch(/Write docs/)
  expect(after).toMatch(/port the tests/)
  expect(await pane.find({ key: 'clear' })).toBeUndefined()
})
