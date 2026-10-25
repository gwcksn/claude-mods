import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DelegateAgent, DelegateRun, DelegateStatus, Panel } from '../types'
import { clearHidden, readSwitch, takeOpenRequest } from './switch'

const runs = atom({ plugin: 'delegate-monitor', key: 'runs' } as const, [])
const panel = atom({ plugin: 'delegate-monitor', key: 'panel' } as const, { isDoneCollapsed: false, hasAutoOpened: false, isPaneOpen: false })
const now = atom({ plugin: 'delegate-monitor', key: 'now' } as const, 0)
// The terminal icons' bounce frame; only the terminal drawing reads it.
const frame = atom({ plugin: 'delegate-monitor', key: 'frame' } as const, 0)

const NAME = 'delegate-monitor'
const PANE = 'delegates'
const TICK_MS = 200
const POLL_MS = 3000
// A background run is only looked for in `ps` after this long, and ends after two misses in a row.
const GRACE_MS = 8000
const MAX_TITLE = 60
// What the Switchboard says: off draws nothing and refuses /delegates, hidden draws nothing until
// /delegates or Open. Tracking goes on either way.
let isOff = false
let isHidden = false

// The cards' borders and the band: opencode's light grey, codex's blue violet.
const AGENT_COLOR: Record<DelegateAgent, string> = { opencode: '#D4D4D4', codex: '#7280FF' }
const SECTION = { running: '#22A04B', finished: '#E3AE16' }
const DONE_INK = '#2E9E5B'
const FAIL_INK = '#D0453F'
const HEAD_INK = '#CC6B4E'

// ---------- Parsing a Bash command ----------

const LAUNCH = /(?:^|[\s;&|(`'"])(opencode)\s+run\b|(?:^|[\s;&|(`'"])(codex)\s+(?:exec|e)\b/

// Flags that take a value, so their value is not mistaken for the prompt.
const VALUE_FLAGS = new Set([
  '-m', '--model', '--title', '--agent', '--session', '-s', '--file', '-f', '--format', '--port', '--attach', '--variant',
  '-C', '--cd', '--sandbox', '-p', '--profile', '-c', '--config', '-i', '--image', '-o', '--output-last-message', '--color',
  '--output-schema', '--add-dir',
])
const STOP = new Set(['|', '||', '&&', ';', '&', '>', '>>', '2>&1', '2>', '<', '<<'])

/** Shell-ish words: quotes grouped, `$(...)` kept whole, operators split off. */
export const words = (text: string): string[] => {
  const out: string[] = []
  let cur = ''
  let has = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1)
      const stop = end < 0 ? text.length : end
      cur += text.slice(i + 1, stop)
      has = true
      i = stop
    } else if (c === '$' && text[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')' && --depth === 0) break
      }
      cur += text.slice(i, j + 1)
      has = true
      i = j
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else if (c === ';' || c === '|' || c === '&' || c === '>' || c === '<') {
      // `2>&1`: the descriptor belongs to the redirection.
      const isFd = (c === '>' || c === '<') && /^\d$/.test(cur)
      if (has && !isFd) out.push(cur)
      let op = isFd ? cur + c : c
      while (i + 1 < text.length && /[;|&><]/.test(text[i + 1]!)) op += text[++i]
      out.push(op)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

export type Launch = { agent: DelegateAgent; title: string; model: string; prompt: string; cwd: string }

const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// The model's last path part ("MiniMax-M3"), with the one before it when the last says little ("kilo-auto/free").
const modelLabel = (model: string): string => {
  const parts = model.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return last.length < 6 && parts.length > 1 ? parts.slice(-2).join('/') : last
}

/** The opencode or codex run a Bash command starts, or null when it starts none. */
export const parseLaunch = (command: string, description = ''): Launch | null => {
  const m = LAUNCH.exec(command)
  if (!m) return null
  const agent: DelegateAgent = m[1] ? 'opencode' : 'codex'
  const before = command.slice(0, m.index + 1)
  const cd = /(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)[^]*$/.exec(before)
  const cwd = cd ? cd[1]!.replace(/^["']|["']$/g, '') : ''
  const rest = words(command.slice(m.index + m[0].length))
  let title = ''
  let model = ''
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!
    if (STOP.has(w) || /^\d?[;|&<>]/.test(w)) break
    if (w.startsWith('-')) {
      const eq = w.indexOf('=')
      const flag = eq > 0 ? w.slice(0, eq) : w
      const value = eq > 0 ? w.slice(eq + 1) : VALUE_FLAGS.has(flag) ? (rest[++i] ?? '') : ''
      if (flag === '--title') title = value
      else if (flag === '-m' || flag === '--model') model = value
      continue
    }
    positional.push(w)
  }
  const prompt = positional.join(' ')
  const shownPrompt = /^\$\(/.test(prompt) ? '' : prompt
  return {
    agent,
    title: clip(title || description || shownPrompt || `${agent} task`, MAX_TITLE),
    model: modelLabel(model),
    prompt,
    cwd,
  }
}

/** The longest plain run of letters, digits and spaces in the title or prompt: what `ps` is searched for. */
export const fingerprintOf = (l: Launch, hasTitleFlag: boolean): string => {
  const source = hasTitleFlag ? l.title : l.prompt
  const pieces = source.match(/[A-Za-z0-9][A-Za-z0-9 _.,-]{5,}/g) ?? []
  const best = pieces.sort((a, b) => b.length - a.length)[0] ?? ''
  return best.trim().slice(0, 32)
}

/** A background task's notification: its id, and how it ended. */
export const parseNotification = (text: string): { taskId: string; status: DelegateStatus } | null => {
  if (!/task[-_]notification/i.test(text)) return null
  const id = /<task[-_]id>\s*([^<\s]+)\s*<\/task[-_]id>/i.exec(text)?.[1]
  if (!id) return null
  const raw = (/<status>\s*([^<\s]+)\s*<\/status>/i.exec(text)?.[1] ?? 'completed').toLowerCase()
  const code = /exit code[:\s]+(-?\d+)/i.exec(text)?.[1]
  const status: DelegateStatus =
    raw === 'killed' || raw === 'stopped' ? 'killed' : raw === 'failed' || (code !== undefined && code !== '0') ? 'failed' : 'done'
  return { taskId: id, status }
}

// ---------- Icons and the bounce ----------

// Pixel art, one letter per pixel, two pixel rows per text row (half blocks).
// opencode: its framed window, the lower part filled; codex: a cloud with a prompt.
// F frame, G fill, C cloud (a gradient by row), W white, . empty.
const ART: Record<DelegateAgent, string[]> = {
  opencode: ['.FFFFFFF.', '.FFFFFFF.', '.FF...FF.', '.FF...FF.', '.FFGGGFF.', '.FFGGGFF.', '.FFFFFFF.', '.FFFFFFF.'],
  codex: ['..CC.CC..', '.CCCCCCC.', 'CCWCCCCCC', 'CCCWCCCCC', 'CCWCCWWCC', 'CCCCCCCCC', '.CCCCCCC.', '..CC.CC..'],
}
const ICON_W = 9
// The canvas in pixels: headroom for the hop, the icon, and the shadow on the last row.
const CANVAS_H = 12
const GROUND = CANVAS_H - 1 - ART.opencode.length
// Height above the ground per frame, in pixels: rise, hang, fall, land squashed, rest.
const HOPS = [0, 1, 2, 3, 3, 2, 1, 0, -1, 0]
const SHADOW_INK = '#4A4A4A'

const hex = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const toHex = (rgb: number[]): string => `#${rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
const mix = (a: string, b: string, t: number): string => {
  const x = hex(a)
  const y = hex(b)
  return toHex(x.map((v, i) => v + (y[i]! - v) * t))
}

const PIXEL: Record<DelegateAgent, (ch: string, row: number) => string | undefined> = {
  opencode: ch => (ch === 'F' ? '#E6E6E6' : ch === 'G' ? '#8C8C8C' : undefined),
  codex: (ch, row) => (ch === 'C' ? mix('#B3A8FF', '#3F4CFF', row / 7) : ch === 'W' ? '#FFFFFF' : undefined),
}

export type Seg = { text: string; color?: string; bg?: string }

/** The icon's text rows at `tick`, as colored runs; `phase` staggers cards. No phase: still and faded. */
export const iconRows = (agent: DelegateAgent, tick: number, phase?: number): Seg[][] => {
  const isStill = phase === undefined
  const h = isStill ? 0 : HOPS[(tick + phase * 3) % HOPS.length]!
  // Landing squashes: one inner row drops out and the icon sits on the ground.
  const art = h < 0 ? ART[agent].filter((_, i) => i !== 3) : ART[agent]
  const top = GROUND + (ART[agent].length - art.length) - Math.max(0, h)
  const grid: (string | undefined)[][] = Array.from({ length: CANVAS_H }, () => Array<string | undefined>(ICON_W).fill(undefined))
  art.forEach((line, y) =>
    [...line].forEach((ch, x) => {
      const c = PIXEL[agent](ch, y)
      if (c) grid[top + y]![x] = isStill ? mix(c, '#2A2A2A', 0.45) : c
    }),
  )
  // The shadow narrows as the icon rises.
  const half = Math.max(1, 4 - Math.max(0, h))
  for (let x = 4 - half + 1; x <= 4 + half - 1; x++) grid[CANVAS_H - 1]![x] = SHADOW_INK

  const rows: Seg[][] = []
  for (let y = 0; y < CANVAS_H; y += 2) {
    const segs: Seg[] = []
    for (let x = 0; x < ICON_W; x++) {
      const up = grid[y]![x]
      const down = grid[y + 1]![x]
      const seg: Seg = !up && !down ? { text: ' ' } : up === down ? { text: '█', color: up } : !up ? { text: '▄', color: down } : { text: '▀', color: up, bg: down }
      const last = segs[segs.length - 1]
      if (last && last.color === seg.color && last.bg === seg.bg) last.text += seg.text
      else segs.push(seg)
    }
    rows.push(segs)
  }
  return rows
}

// The desktop's icon: drawn shapes, bouncing in CSS while it runs.
const iconSvg = (agent: DelegateAgent, isRunning: boolean, phase: number): string => {
  const glyph =
    agent === 'opencode'
      ? `<rect x="12" y="4" width="24" height="32" fill="#E6E6E6"/><rect x="18" y="11" width="12" height="18" fill="#1E1E1E"/><rect x="18" y="19" width="12" height="10" fill="#8C8C8C"/>`
      : `<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B3A8FF"/><stop offset="1" stop-color="#3F4CFF"/></linearGradient></defs>` +
        `<path d="M24 4c4 0 6.5 2 8 4.5 4-1 9 1.5 9.5 6.5 3 2 4 6 2 9.5 1.5 3.5 0 8-4 9.5-1 4-5.5 6-9.5 4.5-2.5 2.5-7.5 2.5-10 0-4 1.5-8.5-.5-9.5-4.5-4-1.5-5.5-6-4-9.5-2-3.5-1-7.5 2-9.5.5-5 5.5-7.5 9.5-6.5C17.5 6 20 4 24 4z" fill="url(#cg)"/>` +
        `<path d="M17 16l5 6-5 6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 28h7" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`
  const delay = `-${(phase % 4) * 0.18}s`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><style>
.b{transform-origin:24px 40px;animation:hop .9s cubic-bezier(.3,.6,.4,1) infinite;animation-delay:${delay}}
.s{transform-origin:24px 45px;animation:sh .9s cubic-bezier(.3,.6,.4,1) infinite;animation-delay:${delay}}
@keyframes hop{0%,100%{transform:translateY(0) scale(1.08,.9)}12%{transform:translateY(0) scale(1)}45%{transform:translateY(-6px)}80%{transform:translateY(0) scale(1)}}
@keyframes sh{0%,100%{transform:scaleX(1);opacity:.35}45%{transform:scaleX(.5);opacity:.15}}
@media (prefers-reduced-motion: reduce){.b,.s{animation:none}}
</style><ellipse class="${isRunning ? 's' : ''}" cx="24" cy="45" rx="12" ry="2" fill="#888" opacity=".3"/><g class="${isRunning ? 'b' : ''}" opacity="${isRunning ? 1 : 0.5}">${glyph}</g></svg>`
}

// ---------- Formatting ----------

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (r: DelegateRun, at: number): number => (r.endedAt ?? Math.max(at, r.startedAt)) - r.startedAt

const shortPath = (path: string, home: string): string => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

const STATUS_WORD: Record<DelegateStatus, string> = { running: 'running', done: 'finished', failed: 'failed', killed: 'stopped' }

// ---------- The pane ----------

let home = ''

// Opens or closes the pane, and records which so the band's button says the right word.
async function setPane($: EngineInterface, isOpen: boolean): Promise<void> {
  if (isOpen) {
    await $.clock.now().then(
      at => update($, now, () => at),
      () => undefined,
    )
    await $.ui.open({ id: PANE, title: 'Delegations' })
  } else {
    await $.ui.close({ id: PANE })
  }
  await update($, panel, prev => ({ ...prev, isPaneOpen: isOpen }))
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  await setPane($, !isOpen)
  return !isOpen
}

/** Follows the Switchboard: closes the pane when switched off or hidden, opens it when asked to. */
async function follow($: EngineInterface): Promise<void> {
  const s = await readSwitch($, NAME)
  isOff = s.isOff
  isHidden = s.isHidden
  const isAsked = await takeOpenRequest($, NAME)
  const isUp = (await $.ui.panes().catch(() => [])).some(p => p.id === PANE)
  if (isOff || isHidden) {
    if (isUp) await setPane($, false).catch(() => undefined)
  } else if (isAsked && !isUp) await setPane($, true).catch(() => undefined)
}

async function finish($: EngineInterface, match: (r: DelegateRun) => boolean, status: DelegateStatus): Promise<void> {
  const at = await $.clock.now()
  await update($, runs, list => list.map(r => (r.status === 'running' && match(r) ? { ...r, status, endedAt: at } : r)))
  await update($, now, () => at)
}

// Background runs whose process is gone from `ps`: a notification that never reached a hook still ends them.
async function sweep($: EngineInterface): Promise<void> {
  const list = await read($, runs)
  const at = await $.clock.now()
  const watched = list.filter(r => r.status === 'running' && r.taskId && at - r.startedAt > GRACE_MS)
  if (!watched.length) return
  const { exitCode, stdout } = await $.process.run(['ps', '-eo', 'args', '--no-headers'])
  if (exitCode !== 0) return
  const lines = stdout.split('\n').filter(l => /\b(opencode|codex)\b/.test(l))
  const alive = (r: DelegateRun) => lines.some(l => l.includes(r.agent) && (!r.fingerprint || l.includes(r.fingerprint)))
  await update($, runs, prev =>
    prev.map((r): DelegateRun => {
      if (!watched.some(w => w.id === r.id) || r.status !== 'running') return r
      if (alive(r)) return r.misses ? { ...r, misses: 0 } : r
      const misses = (r.misses ?? 0) + 1
      return misses >= 2 ? { ...r, misses, status: 'done', endedAt: at } : { ...r, misses }
    }),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    await $.command.register({
      name: 'delegates',
      description: 'Show or hide the sidebar of tasks delegated to opencode and codex: running and finished',
    })
    // Moves the bounce and the clocks while something runs; quiet otherwise.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const list = await read($, runs)
        if (!list.some(r => r.status === 'running')) return
        const at = await $.clock.now()
        await update($, frame, n => n + 1)
        const prev = await read($, now)
        if (Math.floor(at / 1000) !== Math.floor(prev / 1000)) await update($, now, () => at)
      })().catch(() => undefined)
    })
    await follow($).catch(() => undefined)
    $.clock.every(POLL_MS, () => {
      void follow($).catch(() => undefined)
      void sweep($).catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'delegates' }, async ($, e) => {
    if (isOff) return { text: 'Delegations is off. Turn it on with /switchboard.' }
    if (isHidden) {
      await clearHidden($, NAME)
      isHidden = false
    }
    if ((e.args ?? '').trim() === 'open') {
      await setPane($, true)
      return { text: 'Delegations sidebar opened.' }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Delegations sidebar opened.' : 'Delegations sidebar closed.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    const launch = parseLaunch(command, typeof e.description === 'string' ? e.description : '')
    if (!launch) return next(e)

    const id = e.tool_use_id || `run-${Date.now()}`
    const at = await $.clock.now()
    const cwd = launch.cwd || (await $.session.cwd().catch(() => ''))
    // Only a drawing: a failed write must never hold up the command.
    const run: DelegateRun = {
      id,
      agent: launch.agent,
      title: launch.title,
      model: launch.model,
      cwd,
      status: 'running',
      startedAt: at,
      fingerprint: fingerprintOf(launch, /--title[\s=]/.test(command)),
      colorIndex: 0,
    }
    await update($, runs, (list): DelegateRun[] => [...list.filter(r => r.id !== id), { ...run, colorIndex: list.length }]).catch(() => undefined)
    await update($, now, () => at).catch(() => undefined)
    const p = await read($, panel)
    if (!p.hasAutoOpened && !isOff && !isHidden) {
      await update($, panel, prev => ({ ...prev, hasAutoOpened: true }))
      void setPane($, true).catch(() => undefined)
    }

    const result = await next(e)
    const answer = result as { deny?: string; result?: unknown; isError?: boolean }
    const out = answer.result && typeof answer.result === 'object' ? (answer.result as { backgroundTaskId?: string; interrupted?: boolean }) : {}
    if (answer.deny) {
      await update($, runs, list => list.filter(r => r.id !== id)).catch(() => undefined)
    } else if (out.backgroundTaskId) {
      const taskId = out.backgroundTaskId
      await update($, runs, list => list.map(r => (r.id === id ? { ...r, taskId } : r))).catch(() => undefined)
    } else {
      const status: DelegateStatus = out.interrupted ? 'killed' : answer.isError ? 'failed' : 'done'
      await finish($, r => r.id === id, status).catch(() => undefined)
    }
    return result
  })

  // Stopping a tracked background task ends its run.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const result = await next(e)
    const input = e as unknown as { task_id?: string; shell_id?: string }
    const taskId = input.task_id || input.shell_id
    if (taskId && !(result as { deny?: string }).deny) await finish($, r => r.taskId === taskId, 'killed').catch(() => undefined)
    return result
  })

  // A background task's notification says how it ended.
  on('prompt.submit', async ($, e, next) => {
    const note = parseNotification(e.text ?? '')
    if (note) await finish($, r => r.taskId === note.taskId, note.status).catch(() => undefined)
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    const note = parseNotification(e.text ?? '')
    if (note) await finish($, r => r.taskId === note.taskId, note.status).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(r => r.startedAt), 0)
    const tick = await read($, frame)

    const running = list.filter(r => r.status === 'running').reverse()
    const finished = list.filter(r => r.status !== 'running').reverse()
    const total = list.reduce((sum, r) => sum + elapsed(r, at), 0)
    const cols = Math.max(28, e.props.bodyColumns || 40)
    const hasIcon = cols >= 40
    const innerW = cols - 4 - (hasIcon ? ICON_W + 1 : 0)
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui

    const heading = `${list.length} delegation${list.length === 1 ? '' : 's'} in this chat`
    const hide = <Button key="hide" label="Hide" onPress={() => void setPane($, false)} />
    const clear = (
      <Button
        key="clear"
        label="Clear finished"
        onPress={async () => {
          await update($, runs, l => l.filter(r => r.status === 'running'))
        }}
      />
    )

    const pad = (text: string) => ` ${text}`.padEnd(cols)
    const bar = (key: string, text: string, color: string, onPress?: () => void) =>
      onPress ? (
        <Button key={key} plain onPress={onPress}>
          <Text backgroundColor={color} color="#ffffff" bold>
            {pad(text)}
          </Text>
        </Button>
      ) : (
        <Text key={key} backgroundColor={color} color="#ffffff" bold>
          {pad(text)}
        </Text>
      )

    const icon = (r: DelegateRun) => {
      const isRunning = r.status === 'running'
      if (isDesktop && 'Svg' in ui) {
        const { Svg } = ui
        return <Svg source={iconSvg(r.agent, isRunning, r.colorIndex)} alt={`${r.agent} ${STATUS_WORD[r.status]}`} width={48} height={48} />
      }
      const rows = iconRows(r.agent, tick, isRunning ? r.colorIndex : undefined)
      return (
        <Box flexDirection="column" width={ICON_W} flexShrink={0} justifyContent="center">
          {rows.map((segs, i) => (
            <Text key={`i${i}`}>
              {segs.map((g, j) => (
                <Text key={`s${j}`} color={g.color} backgroundColor={g.bg}>
                  {g.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )
    }

    const mark = (r: DelegateRun) =>
      r.status === 'running' ? (
        <Text color={DONE_INK}>{tick % 4 < 2 ? '●' : '○'}</Text>
      ) : r.status === 'done' ? (
        <Text color={DONE_INK}>✓</Text>
      ) : (
        <Text color={FAIL_INK}>✗</Text>
      )

    const card = (r: DelegateRun) => {
      const color = AGENT_COLOR[r.agent]
      const isRunning = r.status === 'running'
      const meta = [r.agent, r.model, r.taskId ? 'background' : ''].filter(Boolean).join(' · ')
      // While running, a light sweeps along the line; finished, it is full in the card's color.
      const w = Math.max(4, innerW)
      const spot = tick % (w + 6)
      const line = isRunning
        ? Array.from({ length: w }, (_, i) => (Math.abs(i - spot + 3) <= 2 ? '━' : '─')).join('')
        : '━'.repeat(w)
      return (
        <Box key={r.id} flexDirection="row" borderStyle="round" borderColor={color} borderDimColor={!isRunning} paddingX={1} gap={1}>
          {hasIcon && icon(r)}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold wrap="truncate-end">
                {r.title}
              </Text>
              {mark(r)}
            </Box>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text dimColor wrap="truncate-end">
                {meta}
              </Text>
              <Text dimColor>{fmtTime(elapsed(r, at))}</Text>
            </Box>
            <Text dimColor wrap="truncate-start">
              {r.cwd ? shortPath(r.cwd, home) : ' '}
            </Text>
            <Text color={isRunning ? color : r.status === 'done' ? DONE_INK : FAIL_INK} wrap="truncate-end">
              {isRunning ? `◒ ${STATUS_WORD[r.status]}` : STATUS_WORD[r.status]}
            </Text>
            <Text>
              {isRunning ? (
                line.split('').map((ch, i) => (
                  <Text key={`l${i}`} color={ch === '━' ? color : undefined} dimColor={ch !== '━'}>
                    {ch}
                  </Text>
                ))
              ) : (
                <Text color={r.status === 'done' ? DONE_INK : FAIL_INK} dimColor>
                  {line}
                </Text>
              )}
            </Text>
          </Box>
        </Box>
      )
    }

    const tileW = Math.floor((cols - 2) / 3)
    const tile = (k: string, v: string) => (
      <Box key={k} flexDirection="column" width={tileW} flexShrink={0} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {k}
        </Text>
        <Text color={HEAD_INK}>{v}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text color={HEAD_INK} bold wrap="truncate-end">
            {heading}
          </Text>
          {hide}
        </Box>
        <Box flexDirection="row" gap={1}>
          {tile('Running', String(running.length))}
          {tile('Finished', String(finished.length))}
          {tile('Time', fmtTime(total))}
        </Box>
        {finished.length > 0 && clear}
        {list.length === 0 && <Text dimColor>No opencode or codex runs yet. They show up here when Claude hands one off.</Text>}
        {running.length > 0 && bar('h-run', `▾ Running · ${running.length}`, SECTION.running)}
        {running.map(card)}
        {finished.length > 0 &&
          bar('h-done', `${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`, SECTION.finished, () =>
            void update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed })),
          )}
        {!p.isDoneCollapsed && finished.map(card)}
      </Box>
    )
  })

  // A one-line band above the prompt while something runs, with the sidebar's toggle.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOff || isHidden || e.props.hasSurvey) return next(e)
    const running = (await read($, runs)).filter(r => r.status === 'running')
    if (!running.length) return next(e)
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, panel)
    const isOpen = await $.ui.panes().then(
      panes => panes.some(x => x.id === PANE),
      () => p.isPaneOpen === true,
    )
    const tick = await read($, frame)
    const count = (agent: DelegateAgent) => running.filter(r => r.agent === agent).length
    const parts = (['opencode', 'codex'] as const).filter(a => count(a) > 0)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {parts.map(a => (
            <Text key={a}>
              <Text color={AGENT_COLOR[a]} bold>
                {(tick + (a === 'codex' ? 2 : 0)) % 4 < 2 ? '▲' : '▼'} {a}
              </Text>
              <Text dimColor> ×{count(a)}</Text>
            </Text>
          ))}
          <Text dimColor>running</Text>
          <Button key="delegates-toggle" label={isOpen ? 'Hide delegations' : 'Show delegations'} plain onPress={() => void togglePane($)} />
        </Box>
        {below}
      </Box>
    )
  })
}
