import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'savvy-progress'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const
const PANE = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// Two general-purpose subagents and no flow: the band still counts them. `events` collects the pane's opens and closes.
async function crew($: Engine, on: On, events: string[] = []) {
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
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  for (const [i, description] of ['Research', 'Script'].entries()) {
    await $.agent.spawn({ tool_use_id: `t${i}`, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  }
}

const finish = ($: Engine, agentId: string) =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId, reason: 'answer', answer: 'ok' })

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: with no flow the band counts running subagents and says what runs now`, async ($, on) => {
    await crew($, on)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect((await texts(ui)).join('\n')).toMatch(/Now: Research, Script/)
    expect((await ui.find({ key: 'savvy-agents' }))?.props.label).toBe('Show sidebar')
    await ui.unmount()
  })
}

test('terminal: the band shows a sidebar button that opens and closes the pane', async ($, on) => {
  const events: string[] = []
  await crew($, on, events)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  await ui.press({ key: 'savvy-agents' })
  expect(events).toContain('open savvy-agents')
  await ui.unmount()
})

test('terminal: the sidebar offers Clear subagents only once nothing runs, and it clears them', async ($, on) => {
  await crew($, on)
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: PANE })
  expect(await pane.find({ key: 'clear' })).toBeUndefined()

  await finish($, 'a1')
  await pane.redraw()
  expect(await pane.find({ key: 'clear' })).toBeUndefined()

  await finish($, 'a2')
  await pane.redraw()
  expect(await pane.find({ key: 'clear' })).toBeDefined()

  await pane.press({ key: 'clear' })
  await pane.redraw()
  expect(await pane.find({ key: 'clear' })).toBeUndefined()
  expect((await texts(pane)).join('\n')).toMatch(/No subagents yet/)
})

test('terminal: closing the band with the cross hides it until a new subagent starts', async ($, on) => {
  await crew($, on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'savvy-dismiss' })).toBeDefined()
  await ui.press({ key: 'savvy-dismiss' })
  // Hidden, the mod hands the row back to core, which this test does not have.
  await expect(ui.redraw()).rejects.toThrow(/ui\.render/)

  await $.agent.spawn({ tool_use_id: 't9', prompt: 'p', description: 'Late one', subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  await ui.redraw()
  expect(await ui.find({ key: 'savvy-dismiss' })).toBeDefined()
})
