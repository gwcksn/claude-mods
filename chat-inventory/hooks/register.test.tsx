import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'chat-inventory'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const

// The tools themselves answer from the test: what the plugin counts is what was called.
const chat = (on: On, events: string[] = []) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  on('ui.close', (_$, e) => {
    events.push(`close ${e.id}`)
    return { value: undefined } as never
  })
}

let n = 0
const call = ($: Engine, tool: string, input: Record<string, unknown> = {}, agentId?: string) =>
  $.tool.call({ tool, tool_use_id: `u${++n}`, ...input, ...(agentId ? { agentId } : {}) } as never)

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }): Promise<string> =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: connectors show the name, the tool called last and the calls`, async ($, on) => {
    chat(on)
    await call($, 'mcp__claude_ai_Google_Calendar__list_events')
    await call($, 'mcp__claude_ai_Google_Calendar__list_events')
    await call($, 'mcp__claude_ai_Gmail__get_thread')
    await call($, 'mcp__plugin_postman_postman__getCollection')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: pane })
    const all = await texts(ui)
    expect(all).toMatch(/Google Calendar/)
    expect(all).toMatch(/list_events/)
    expect(all).toMatch(/2 calls/)
    expect(all).toMatch(/Gmail/)
    expect(all).toMatch(/1 call$/m)
    expect(all).toMatch(/Postman/)
    expect(all).toMatch(/^3$/m)
  })

  test(`${surface}: files read and skills used are listed, scratch files and plumbing are not`, async ($, on) => {
    chat(on)
    await call($, 'Read', { file_path: '/home/me/Sales/brightline.md' })
    await call($, 'Read', { file_path: '/home/me/Sales/brightline.md' })
    await call($, 'Read', { file_path: '/tmp/scratch.txt' })
    await call($, 'Read', { file_path: '/home/me/.claude/skills/call-prep/SKILL.md' })
    await call($, 'Skill', { skill: 'call-prep' })
    await call($, 'mcp__savvy-progress__progress', { title: 'x' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: pane })
    const all = await texts(ui)
    expect(all).toMatch(/brightline\.md/)
    expect(all).not.toMatch(/scratch\.txt/)
    expect(all).toMatch(/Files read/)
    expect(all).toMatch(/call-prep/)
    expect(all).toMatch(/2 uses/)
    expect(all).not.toMatch(/savvy-progress/i)
  })

  test(`${surface}: the to-do list follows TodoWrite and counts the finished steps`, async ($, on) => {
    chat(on)
    await call($, 'TodoWrite', {
      todos: [
        { content: 'Find the call', status: 'completed', activeForm: 'Finding the call' },
        { content: 'Read the thread', status: 'in_progress', activeForm: 'Reading the thread' },
        { content: 'Write the brief', status: 'pending', activeForm: 'Writing the brief' },
      ],
    })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: pane })
    const all = await texts(ui)
    expect(all).toMatch(/1 of 3/)
    expect(all).toMatch(/Find the call/)
    expect(all).toMatch(/Reading the thread/)
    expect(all).toMatch(/Write the brief/)
  })
}

test('the to-do list follows TaskCreate and TaskUpdate, and a subagent cannot rewrite it', async ($, on) => {
  chat(on)
  await call($, 'TaskCreate', { subject: 'One' })
  await call($, 'TaskCreate', { subject: 'Two' })
  await call($, 'TaskUpdate', { taskId: '1', status: 'completed' })
  await call($, 'TodoWrite', { todos: [{ content: 'Worker plan', status: 'pending' }] }, 'a1')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane })
  const all = await texts(ui)
  expect(all).toMatch(/1 of 2/)
  expect(all).not.toMatch(/Worker plan/)
})

test('a subagent\'s connector and file calls count for the chat', async ($, on) => {
  chat(on)
  await call($, 'mcp__claude_ai_Gmail__search_threads', {}, 'a1')
  await call($, 'Read', { file_path: '/home/me/notes.md' }, 'a1')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane })
  const all = await texts(ui)
  expect(all).toMatch(/Gmail/)
  expect(all).toMatch(/notes\.md/)
})

test('a call the tool refused is not counted', async ($, on) => {
  on('tool.call', () => ({ deny: 'no' }) as never)
  await call($, 'mcp__claude_ai_Gmail__search_threads')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane })
  expect(await texts(ui)).not.toMatch(/Gmail/)
})

test('the section header folds its rows, and Hide closes the pane', async ($, on) => {
  const events: string[] = []
  chat(on, events)
  await call($, 'mcp__claude_ai_Gmail__search_threads')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane })
  expect(await texts(ui)).toMatch(/search_threads/)
  await ui.press({ key: 'sec-connectors' })
  await ui.redraw()
  expect(await texts(ui)).not.toMatch(/search_threads/)
  await ui.press({ key: 'hide' })
  expect(events).toContain('close chat-inventory')
})

test('an empty chat says so in every section', async ($, on) => {
  chat(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PLUGIN, props: pane })
  const all = await texts(ui)
  expect(all).toMatch(/No to-do list yet/)
  expect(all.match(/None used yet/g)?.length).toBe(3)
})
