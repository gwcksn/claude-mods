import type { EngineInterface, Register } from 'claude-code'
import { GLYPH, iconSvg } from './icons'
import { type Disk, type Row, scan, signature } from './scan'
import { flipHidden, flipOff, isHidden, isOff, openRequest, parseSwitches, serialise, switchesPath } from './switches'

// Switchboard: one row per mod found on this machine, each with an On/Off switch that holds
// in every chat. A mod that draws something also gets an eye (shown or hidden), and a mod with a
// side pane an Open button. The switches live in ~/.claude/mods/switches.json; a mod reads the file
// itself (see hooks/switches.ts), so a mod that never mentions it is listed but cannot be switched.

const PANE = 'switchboard'
const TITLE = 'Switchboard'
const NOTE = { plugin: 'switchboard', key: 'note' } as const
const POLL_MS = 3000
const SCAN_MS = 10_000
const ICON_COLS = 3
const BUTTONS_COLS = 20
const NOT_SWITCHABLE = 'Not switchable yet. Ask Claude: make this mod follow the Switchboard.'

const GOOD = '#16a34a'
const INK = '#4b5563'
const FAINT = '#9ca3af'

// Module variables are set again by every session.start; the switches themselves live in the file.
let home = ''
let sid = ''
let lastRaw = ''
let cache: { at: number; rows: Row[] } | null = null

const cut = (s: string, n: number): string => (n <= 0 ? '' : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)

async function log($: EngineInterface, where: string, err: unknown) {
  try {
    const dir = `${home}/.claude/mods-logs`
    const file = `${dir}/switchboard.log`
    await $.process.run(['mkdir', '-p', dir])
    let old = ''
    try {
      old = String(await $.fs.read(file))
    } catch {
      old = ''
    }
    const when = new Date(await $.clock.now()).toISOString()
    await $.fs.write(file, `${old}${when} ${where}: ${err instanceof Error ? err.message : String(err)}\n`.slice(-50_000))
  } catch {
    // Nowhere left to report it.
  }
}

async function readRaw($: EngineInterface): Promise<string> {
  try {
    const path = switchesPath(home)
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  } catch {
    return ''
  }
}

const readSwitches = async ($: EngineInterface) => parseSwitches(await readRaw($))

async function save($: EngineInterface, s: Record<string, unknown>) {
  await $.process.run(['mkdir', '-p', `${home}/.claude/mods`])
  const text = serialise(s)
  await $.fs.write(switchesPath(home), text)
  lastRaw = text
}

const diskOf = ($: EngineInterface): Disk => ({
  list: async dir => (await $.fs.list(dir)) as never,
  read: async path => String(await $.fs.read(path)),
})

async function getRows($: EngineInterface, isForced = false): Promise<Row[]> {
  const now = await $.clock.now()
  if (!isForced && cache && now - cache.at < SCAN_MS) return cache.rows
  let envList: string | null = null
  try {
    envList = (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? null
  } catch {
    envList = null
  }
  const rows = await scan(diskOf($), { home, sid, envList })
  cache = { at: now, rows }
  return rows
}

/** While the pane is shut nothing is scanned; while open, a changed list redraws it. */
async function scanPoll($: EngineInterface) {
  let isOpen = false
  try {
    isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    isOpen = false
  }
  if (!isOpen) return
  const before = signature(cache?.rows ?? [])
  if (signature(await getRows($, true)) !== before) $.ui.invalidate('ui.render')
}

/** Another chat may have flipped a switch: draw again when the file changed. */
async function poll($: EngineInterface) {
  const raw = await readRaw($)
  if (raw === lastRaw) return
  lastRaw = raw
  $.ui.invalidate('ui.render')
}

const say = ($: EngineInterface, text: string) => $.state.set(NOTE, text)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      try {
        home = (await $.env.get('HOME')) ?? ''
      } catch {
        home = ''
      }
      sid = await $.session.id()
      cache = null
      await $.command.register({ name: 'switchboard', description: 'Show or hide the Switchboard: turn each mod on or off, show or hide it, in every chat', immediate: true })
      lastRaw = await readRaw($)
      $.clock.every(POLL_MS, () => {
        void poll($).catch(err => log($, 'poll', err))
      })
      $.clock.every(SCAN_MS, () => {
        void scanPoll($).catch(err => log($, 'scan', err))
      })
    } catch (err) {
      await log($, 'session start', err)
    }
    return next(e)
  })

  on('command.run', { command: 'switchboard' }, async $ => {
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      return { text: 'Switchboard closed.' }
    }
    try {
      await getRows($, true)
    } catch (err) {
      await log($, 'scan on open', err)
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Switchboard opened.' }
  })

  // Presses are handled here, not in onPress: a closure lives for one drawing only.
  on('ui.press', { plugin: 'switchboard', element: /^toggle-.+$/ }, async ($, e) => {
    const name = e.element.slice('toggle-'.length)
    const mod = (await getRows($)).find(m => m.name === name && m.switchable)
    if (!mod) return { element: e.element }
    try {
      const { next, isNowOff } = flipOff(await readSwitches($), name)
      await save($, next)
      await say($, `${mod.title} is ${isNowOff ? 'off' : 'on'} in every chat.`)
    } catch (err) {
      await log($, `toggle ${name}`, err)
      await say($, `Could not change ${mod.title}. See ~/.claude/mods-logs/switchboard.log`)
    }
    return { element: e.element }
  })

  on('ui.press', { plugin: 'switchboard', element: /^eye-.+$/ }, async ($, e) => {
    const name = e.element.slice('eye-'.length)
    const mod = (await getRows($)).find(m => m.name === name && m.hide && m.switchable)
    if (!mod) return { element: e.element }
    try {
      const switches = await readSwitches($)
      if (isOff(switches, name)) {
        await say($, `${mod.title} is off. Turn it on first.`)
        return { element: e.element }
      }
      const { next, isNowHidden } = flipHidden(switches, name)
      await save($, next)
      // Shown again: a pane mod opens itself in this chat, the way Open does.
      if (!isNowHidden && mod.pane) await $.fs.write(openRequest(home, sid, name), '')
      await say($, `${mod.title} is ${isNowHidden ? 'hidden' : 'shown'} in every chat.`)
    } catch (err) {
      await log($, `eye ${name}`, err)
      await say($, `Could not change ${mod.title}. See ~/.claude/mods-logs/switchboard.log`)
    }
    return { element: e.element }
  })

  // Open asks this chat's copy of a side-pane mod to open; the mod finds the empty file and deletes it.
  on('ui.press', { plugin: 'switchboard', element: /^open-.+$/ }, async ($, e) => {
    const name = e.element.slice('open-'.length)
    const mod = (await getRows($)).find(m => m.name === name && m.pane && m.switchable)
    if (!mod) return { element: e.element }
    try {
      const switches = await readSwitches($)
      if (isOff(switches, name) || isHidden(switches, name)) {
        await say($, `${mod.title} is ${isOff(switches, name) ? 'off' : 'hidden'}. Turn it on and show it first.`)
        return { element: e.element }
      }
      await $.process.run(['mkdir', '-p', `${home}/.claude/mods`])
      await $.fs.write(openRequest(home, sid, name), '')
      await say($, `${mod.title} opens in this chat within 3 seconds.`)
    } catch (err) {
      await log($, `open ${name}`, err)
      await say($, `Could not open ${mod.title}. See ~/.claude/mods-logs/switchboard.log`)
    }
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const noop = () => undefined
    const note = (await $.state.get(NOTE)).value ?? ''
    const switches = await readSwitches($)
    const cols = Math.max(30, e.props.bodyColumns || 44)

    let list: Row[] = []
    try {
      list = await getRows($)
    } catch (err) {
      await log($, 'scan', err)
    }

    const rows = list.map(m => {
      const isDown = m.switchable && isOff(switches, m.name)
      const isDim = isDown
      const hidden = isHidden(switches, m.name)
      const textW = Math.max(10, cols - ICON_COLS - (m.switchable ? BUTTONS_COLS : 0))
      const icon = Svg ? (
        <Box width={ICON_COLS}>
          <Svg source={iconSvg(m.icon, isDim ? FAINT : INK)} alt={m.title} width={20} height={20} />
        </Box>
      ) : (
        <Box width={ICON_COLS}>
          <Text dimColor={isDim}>{GLYPH[m.icon] ?? GLYPH.puzzle}</Text>
        </Box>
      )
      const about = (
        <Box flexDirection="column" width={textW}>
          <Text bold dimColor={isDim} wrap="truncate-end">
            {cut(m.title, textW)}
          </Text>
          {m.what ? (
            <Text dimColor wrap="truncate-end">
              {cut(m.what, textW)}
            </Text>
          ) : null}
          {m.tip ? (
            <Text dimColor italic wrap="truncate-end">
              {cut(m.tip, textW)}
            </Text>
          ) : null}
          {m.isChatOnly ? (
            <Text dimColor italic wrap="truncate-end">
              This chat only
            </Text>
          ) : null}
          {m.switchable ? null : (
            <Text dimColor wrap="wrap">
              {NOT_SWITCHABLE}
            </Text>
          )}
        </Box>
      )
      if (!m.switchable) {
        return (
          <Box key={`row-${m.name}`} flexDirection="row" marginTop={1}>
            {icon}
            {about}
          </Box>
        )
      }
      return (
        <Box key={`row-${m.name}`} flexDirection="row" marginTop={1}>
          {icon}
          {about}
          <Box flexDirection="row" gap={1}>
            {m.pane ? (
              isDown || hidden ? (
                <Text dimColor>Open</Text>
              ) : (
                <Button key={`open-${m.name}`} onPress={noop}>
                  Open
                </Button>
              )
            ) : null}
            {m.hide ? (
              isDown ? (
                <Text dimColor>{hidden ? '◌' : '◉'}</Text>
              ) : (
                <Button key={`eye-${m.name}`} onPress={noop}>
                  {hidden ? <Text dimColor>◌</Text> : <Text color={GOOD}>◉</Text>}
                </Button>
              )
            ) : null}
            <Button key={`toggle-${m.name}`} onPress={noop}>
              {isDown ? <Text dimColor>○ Off</Text> : <Text color={GOOD}>● On</Text>}
            </Button>
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" width={cols}>
        {list.length ? rows : <Text dimColor>No mods found.</Text>}
        <Box marginTop={1} flexDirection="column">
          {note ? (
            <Text color={GOOD} wrap="truncate-end">
              {cut(note, cols)}
            </Text>
          ) : null}
          <Text dimColor wrap="wrap">
            Off means off in every chat. Hidden (◌) keeps it on but out of sight. Changes apply within 3 seconds.
          </Text>
          <Text dimColor wrap="wrap">
            New mods appear here by themselves.
          </Text>
        </Box>
      </Box>
    )
  })
}
