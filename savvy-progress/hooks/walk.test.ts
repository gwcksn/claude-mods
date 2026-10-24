import { expect, mock, test } from 'claude-code/testing'

import { crabFrame } from './register'

const PLUGIN = 'savvy-progress'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

type Ui = { findAll: (q: { type: string; text: RegExp }) => Promise<{ text?: string }[]> }

// The crab's three rows, as the terminal card last drew them.
const crabRows = async (ui: Ui): Promise<string> => (await ui.findAll({ type: 'Text', text: /[▐▜▝]/ })).map(r => r.text).join('|')

test('terminal: a running crab walks from tick to tick, out of step with the next card', () => {
  const frames = Array.from({ length: 8 }, (_, tick) => crabFrame(tick, 0).join('|'))
  expect(new Set(frames).size).toBeGreaterThan(3)
  expect(crabFrame(0, 1).join('|')).not.toBe(crabFrame(0, 0).join('|'))
  // Every frame fits the crab's 11-column slot.
  for (const f of frames) for (const row of f.split('|')) expect([...row].length).toBeLessThanOrEqual(11)
})

test('terminal: a finished crab stands still', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Sitter', subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok' })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const first = await crabRows(ui)
  expect(first).toBe(crabFrame(0).join('|'))
  await clock.advance(1000)
  await ui.redraw()
  expect(await crabRows(ui)).toBe(first)
})
