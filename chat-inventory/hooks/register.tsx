import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { ConnectorRow, FileRow, Inventory, PlanStep, SkillRow, View } from '../types'

const PANE = 'chat-inventory'
const TITLE = 'In this chat'
const MAX_ROWS = 30
const MAX_CONNECTORS = 40

const ACCENT = '#d97757'
const INFO = '#2563eb'
const GOOD = '#16a34a'

const inv = atom({ plugin: 'chat-inventory', key: 'inv' } as const, { connectors: [], files: [], skills: [] } as Inventory)
const plan = atom({ plugin: 'chat-inventory', key: 'plan' } as const, [] as PlanStep[])
const view = atom({ plugin: 'chat-inventory', key: 'view' } as const, { folded: [] } as View)

// Module variables start over on a reload; the lists live in $.state.
let seq = 0
let home = ''
let hasAutoOpened = false
const seen = new Set<string>()

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
// Tools of this and the sibling mods: plumbing, not a connector the person connected.
const INTERNAL = new Set(['savvy-progress', 'plugin-authoring'])
// Spill files and scratch copies are Claude's own, not context the person gave it.
const SCRATCH = /\/tool-results\/|^\/tmp\/|^\/private\/tmp\/|\/\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\//

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const newest = <T extends { seq: number }>(rows: T[]): T[] => [...rows].sort((a, b) => b.seq - a.seq)
const tilde = (p: string): string => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)

// ---------------------------------------------------------------------------
// What a tool call adds to the lists.

const titleCase = (s: string): string =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

// "claude_ai_Google_Calendar" is Google Calendar, "plugin_postman_postman" is Postman.
const NAMED: Record<string, string> = { 'claude-in-chrome': 'Chrome', 'cua-driver': 'Cua Driver' }
const serverName = (server: string): string => {
  const name = server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/i, '')
  return NAMED[name.toLowerCase()] ?? titleCase(name || server)
}

// mcp__<server>__<tool>
const splitMcp = (tool: string): { server: string; name: string } | null => {
  if (!tool.startsWith('mcp__')) return null
  const [, server = '', ...rest] = tool.split('__')
  return server && rest.length ? { server, name: rest.join('__') } : null
}

type Hit = { kind: 'connector'; server: string; tool: string } | { kind: 'file'; path: string } | { kind: 'skill'; name: string }

const hitsOf = (tool: string, input: Record<string, unknown>): Hit[] => {
  const mcp = splitMcp(tool)
  if (mcp) return INTERNAL.has(mcp.server) ? [] : [{ kind: 'connector', server: mcp.server, tool: mcp.name }]
  if (tool === 'Skill' && str(input.skill)) return [{ kind: 'skill', name: str(input.skill).replace(/^\//, '') }]
  if (tool === 'Read' && str(input.file_path)) {
    const path = str(input.file_path)
    // A skill file read on purpose is a skill, named for its folder.
    const skill = /\/([^/]+)\/SKILL\.md$/.exec(path)
    if (skill?.[1]) return [{ kind: 'skill', name: skill[1] }]
    return SCRATCH.test(path) ? [] : [{ kind: 'file', path }]
  }
  return []
}

const apply = (list: Inventory, hits: Hit[]): Inventory => {
  let { connectors, files, skills } = list
  for (const hit of hits) {
    seq += 1
    if (hit.kind === 'connector') {
      const old = connectors.find(c => c.key === hit.server)
      const row: ConnectorRow = { key: hit.server, name: serverName(hit.server), tool: hit.tool, count: (old?.count ?? 0) + 1, seq }
      connectors = [...connectors.filter(c => c.key !== hit.server), row].slice(-MAX_CONNECTORS)
    } else if (hit.kind === 'skill') {
      const old = skills.find(s => s.name === hit.name)
      skills = [...skills.filter(s => s.name !== hit.name), { name: hit.name, count: (old?.count ?? 0) + 1, seq }]
    } else {
      const old = files.find(f => f.path === hit.path)
      files = [...files.filter(f => f.path !== hit.path), { path: hit.path, auto: old?.auto ?? false, seq }]
    }
  }
  return { connectors, files, skills }
}

// ---------------------------------------------------------------------------
// The to-do list: TodoWrite, or TaskCreate and TaskUpdate, in the main chat.

const STATUSES = new Set(['pending', 'in_progress', 'completed'])
const statusOf = (v: unknown): PlanStep['status'] => (typeof v === 'string' && STATUSES.has(v) ? (v as PlanStep['status']) : 'pending')

const planAfter = (cur: PlanStep[], tool: string, input: Record<string, unknown>, result: unknown): PlanStep[] | null => {
  if (tool === 'TodoWrite') {
    if (!Array.isArray(input.todos)) return null
    return input.todos.flatMap((t: unknown): PlanStep[] => {
      const o = (t ?? {}) as Record<string, unknown>
      const text = str(o.content)
      return text ? [{ text, status: statusOf(o.status), ...(str(o.activeForm) ? { active: str(o.activeForm) } : {}) }] : []
    })
  }
  if (tool === 'TaskCreate') {
    const text = str(input.subject)
    if (!text) return null
    const made = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    const id = typeof made === 'string' || typeof made === 'number' ? String(made) : String(cur.length + 1)
    return [...cur, { text, status: 'pending', id, ...(str(input.activeForm) ? { active: str(input.activeForm) } : {}) }]
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId) || (typeof input.taskId === 'number' ? String(input.taskId) : '')
    let at = cur.findIndex(s => s.id === id)
    if (at < 0 && /^\d+$/.test(id) && !cur.some(s => s.id)) at = Number(id) - 1
    const old = cur[at]
    if (!old) return null
    if (input.status === 'deleted') return cur.filter((_, i) => i !== at)
    return cur.map((s, i) =>
      i === at
        ? { ...s, text: str(input.subject) || s.text, status: input.status === undefined ? s.status : statusOf(input.status), ...(str(input.activeForm) ? { active: str(input.activeForm) } : {}) }
        : s,
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Recording, seeding and the pane itself.

async function record($: EngineInterface, id: string, tool: string, input: Record<string, unknown>, result: unknown, isMain: boolean): Promise<boolean> {
  if (id) {
    if (seen.has(id)) return false
    seen.add(id)
  }
  let changed = false
  const hits = hitsOf(tool, input)
  if (hits.length) {
    await update($, inv, list => apply(list, hits))
    changed = true
  }
  if (isMain && PLAN_TOOLS.has(tool)) {
    await update($, plan, cur => {
      const next = planAfter(cur, tool, input, result)
      if (!next) return cur
      changed = true
      return next
    })
  }
  return changed
}

// A chat already under way: replay its tool calls, the main one's and every subagent's.
async function seed($: EngineInterface): Promise<void> {
  const main = await $.session.messages()
  const all: { m: SessionMessage; isMain: boolean }[] = main.map(m => ({ m, isMain: true }))
  for (const m of main) {
    for (const u of m.toolUses) {
      if (!u.agentId) continue
      const child = await $.session.messages({ agentId: u.agentId })
      if (Array.isArray(child)) all.push(...child.map(c => ({ m: c, isMain: false })))
    }
  }
  let changed = false
  for (const { m, isMain } of all) {
    for (const u of m.toolUses) if (await record($, u.tool_use_id, u.tool, u.input, u.result, isMain && !u.agentId)) changed = true
  }
  // A chat reloaded after it used things does not pop the pane open again.
  if (changed) hasAutoOpened = true
}

// Memory files the chat loaded at start (CLAUDE.md and the like): rows marked auto.
async function loadMemoryFiles($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const paths = (usage.context.breakdown?.memoryFiles ?? []).map(f => f.path).filter(Boolean)
  if (!paths.length) return
  await update($, inv, list => {
    const have = new Set(list.files.map(f => f.path))
    const added: FileRow[] = paths.filter(p => !have.has(p)).map((path, i) => ({ path, auto: true, seq: -1000 + i }))
    return { ...list, files: [...list.files.map(f => (paths.includes(f.path) ? { ...f, auto: true } : f)), ...added] }
  })
}

const isOpen = async ($: EngineInterface): Promise<boolean> => (await $.ui.panes()).some(p => p.id === PANE)

// A drawing aid: if the pane cannot open, the chat goes on without it.
const openPane = ($: EngineInterface): Promise<void> => $.ui.open({ id: PANE, title: TITLE }).then(() => undefined, () => undefined)

const logoSvg = (name: string, key: string): string => {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360
  const letter = (name[0] ?? '?').toUpperCase().replace(/[&<>"]/g, '?')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" rx="8" fill="hsl(${h},55%,48%)"/><text x="16" y="21.5" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="16" font-weight="700" fill="#ffffff">${letter}</text></svg>`
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get('HOME')) ?? ''
    await $.command.register({ name: 'inventory', description: 'Show or hide the pane of what this chat used: to-do, connectors, files, skills', immediate: true })
    void seed($)
      .then(() => loadMemoryFiles($))
      .catch(() => undefined)
    return started
  })

  on('command.run', { command: 'inventory' }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'In this chat pane closed.' }
    }
    await openPane($)
    void loadMemoryFiles($).catch(() => undefined)
    return { text: 'In this chat pane opened.' }
  })

  // Every tool call, the main chat's and the subagents': the call runs first, then it is counted.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((ran as { deny?: unknown }).deny !== undefined) return ran
    try {
      const call = e as unknown as Record<string, unknown> & { tool: string; tool_use_id: string; agentId?: string }
      const changed = await record($, call.tool_use_id, call.tool, call, (ran as { result?: unknown }).result, !call.agentId)
      if (changed && options.autoOpen === 'first-use' && !hasAutoOpened) {
        hasAutoOpened = true
        void openPane($)
      }
    } catch {
      // Counting is a courtesy: never hold up the tool.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const width = Math.max(24, e.props.bodyColumns || 40)
    const inner = width - 4
    const list = await read($, inv)
    const steps = await read($, plan)
    const { folded } = await read($, view)

    const toggle = (id: string) => update($, view, v => ({ ...v, folded: v.folded.includes(id) ? v.folded.filter(x => x !== id) : [...v.folded, id] }))
    const none = (text: string) => <Text dimColor>{text}</Text>
    const section = (id: string, glyph: string, title: string, right: string, body: unknown) => {
      const isFolded = folded.includes(id)
      return (
        <Box key={id} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={width} flexShrink={0}>
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            <Button key={`sec-${id}`} plain onPress={() => toggle(id)}>
              <Text dimColor>{isFolded ? '▸ ' : '▾ '}</Text>
              <Text>{glyph} </Text>
              <Text bold>{title}</Text>
            </Button>
            <Text dimColor>{right}</Text>
          </Box>
          {isFolded ? null : (body as never)}
        </Box>
      )
    }
    const row = (key: string, left: unknown, right?: unknown) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width={inner} gap={1}>
        <Box flexShrink={1} flexGrow={1} overflow="hidden">
          {left as never}
        </Box>
        {right ? <Box flexShrink={0}>{right as never}</Box> : null}
      </Box>
    )
    const capped = <T,>(rows: T[], draw: (r: T) => unknown): never => {
      const shown = rows.slice(0, MAX_ROWS)
      const more = rows.length - shown.length
      return [...shown.map(draw), more > 0 ? <Text key="more" dimColor>{`+${more} more`}</Text> : null] as never
    }

    // To-do: a mark, then the step; a finished step is struck through.
    const done = steps.filter(s => s.status === 'completed').length
    const todoBody = steps.length
      ? steps.map((s, i) => {
          const isDone = s.status === 'completed'
          const isNow = s.status === 'in_progress'
          return (
            <Box key={`todo:${i}`} flexDirection="row" width={inner} flexShrink={0}>
              <Box width={2} flexShrink={0}>
                {isDone ? <Text color={GOOD}>✓</Text> : isNow ? <Text color={ACCENT}>●</Text> : <Text dimColor>○</Text>}
              </Box>
              <Box flexShrink={1} flexGrow={1}>
                <Text dimColor={isDone} strikethrough={isDone} bold={isNow}>
                  {isNow && s.active ? s.active : s.text}
                </Text>
              </Box>
            </Box>
          )
        })
      : none('No to-do list yet.')

    // Connectors: the logo tile, the name, the tool called last, and the number of calls.
    const conns = newest(list.connectors)
    const connectorBody = conns.length
      ? capped(conns, c =>
          row(
            `c:${c.key}`,
            <Box flexDirection="row" gap={1}>
              {Svg ? <Svg source={logoSvg(c.name, c.key)} alt={c.name} width={32} height={32} /> : <Text color={ACCENT}>■</Text>}
              <Box flexDirection="column" flexShrink={1}>
                <Text bold wrap="truncate-end">
                  {c.name}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {c.tool}
                </Text>
              </Box>
            </Box>,
            <Text color={ACCENT}>{plural(c.count, 'call')}</Text>,
          ),
        )
      : none('None used yet')

    // Context files: "Files read" and its count, then a row per file; a memory file loaded at start says auto.
    const files = newest(list.files)
    const readCount = files.filter(f => !f.auto).length
    const fileBody = files.length
      ? [
          row('fread', <Text dimColor>Files read</Text>, <Text dimColor>{String(readCount)}</Text>),
          ...(capped(files, f => {
            const cut = f.path.lastIndexOf('/')
            const folder = tilde(cut > 0 ? f.path.slice(0, cut) : '/')
            const parts = folder.split('/').filter(Boolean)
            const short = folder.length > 28 && parts.length > 1 ? `…/${parts[parts.length - 1]}` : folder
            return row(
              `f:${f.path}`,
              <Text wrap="truncate-end">
                <Text bold>{f.path.slice(cut + 1)}</Text>
                <Text dimColor>{`  ${short}`}</Text>
              </Text>,
              f.auto ? <Text color={INFO}>auto</Text> : null,
            )
          }) as never as unknown[]),
        ]
      : none('None used yet')

    const skills = newest(list.skills)
    const skillBody = skills.length
      ? capped(skills, (s: SkillRow) =>
          row(
            `s:${s.name}`,
            <Text wrap="truncate-end">
              <Text color={ACCENT}>/</Text>
              <Text bold>{s.name}</Text>
            </Text>,
            <Text dimColor>{plural(s.count, 'use')}</Text>,
          ),
        )
      : none('None used yet')

    return (
      <Box flexDirection="column" width={width} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" width={width}>
          <Text bold>{TITLE}</Text>
          <Button key="hide" label="Hide" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {section('todo', '☑', 'To-do', steps.length ? `${done} of ${steps.length}` : '', todoBody)}
        {section('connectors', '⌁', 'Connectors', String(conns.length), connectorBody)}
        {section('files', '▤', 'Context files', String(files.length), fileBody)}
        {section('skills', 'ϟ', 'Skills', String(skills.length), skillBody)}
      </Box>
    )
  })
}
