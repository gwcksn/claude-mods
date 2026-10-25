// Finding the mods on this machine, and what each row says about them. Pure over a
// small `Disk`, so the same code runs under the engine and in a script on real folders.

export type Entry = { name: string; kind: string; size: number; isLink: boolean }
export type Disk = {
  list: (dir: string) => Promise<Entry[]>
  read: (path: string) => Promise<string>
}

/** `hide`: has a Shown/Hidden eye. `pane`: has a side pane to open. `switchable`: reads the switch file. */
export type Row = {
  name: string
  title: string
  what: string
  tip: string
  icon: string
  hide: boolean
  pane: boolean
  switchable: boolean
  isChatOnly: boolean
}

type Known = Omit<Row, 'switchable' | 'isChatOnly'>

// What is said about the mods we know, in the order they are listed. A mod that is not on
// this machine gets no row; one that is not here is named from its plugin.json instead.
export const KNOWN: readonly Known[] = [
  { name: 'savvy-progress', title: 'Agents', what: 'Progress band above the prompt, plus a card per subagent', tip: '/agents-info to open', icon: 'sliders', hide: true, pane: true },
  { name: 'chat-inventory', title: 'Chat Inventory', what: 'Connectors, files and skills this chat used', tip: '/inventory to open', icon: 'clipboard', hide: true, pane: true },
  { name: 'source-control', title: 'Source Control', what: 'Changed files, diffs, stage, commit, push and pull', tip: '/scm to open', icon: 'branch', hide: true, pane: true },
  { name: 'token-weather', title: 'Token Weather', what: 'A forecast of the context window above the prompt', tip: '', icon: 'cloud', hide: false, pane: false },
  { name: 'cache-clock', title: 'Cache Clock', what: 'Counts down until the cache goes cold', tip: '/cacheclock to show or hide', icon: 'clock', hide: true, pane: false },
  { name: 'handoff', title: 'Handoff (Refresh)', what: 'Moves a long chat to a fresh one', tip: '/refresh to show it', icon: 'arrow', hide: true, pane: false },
  { name: 'screen-share', title: 'Screen-Share Mode', what: 'Hides emails, phones and amounts on screen', tip: '/screen-share to hide private data', icon: 'shield', hide: false, pane: false },
  { name: 'brain-dump', title: 'Brain-Dump Shaper', what: 'Turns long rambling prompts into clear briefs', tip: '', icon: 'pencil', hide: false, pane: false },
  { name: 'reflect', title: 'Reflect', what: 'Saves your corrections as lasting rules', tip: '', icon: 'loop', hide: false, pane: false },
  { name: 'helper-desk', title: 'Helper Desk', what: 'Progress bar plus a card per subagent', tip: '/helpers to open', icon: 'sliders', hide: true, pane: true },
]

/** The mod the pane itself is; it never lists itself. */
export const SELF = 'switchboard'

export const titleCase = (name: string): string =>
  name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

const parseObject = (raw: string): Record<string, unknown> => {
  try {
    const json = JSON.parse(raw) as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const readText = async (disk: Disk, path: string): Promise<string> => {
  try {
    return String(await disk.read(path))
  } catch {
    return ''
  }
}

/** Folders (or links to folders) directly inside `dir`. A missing folder is an empty list. */
const listDirs = async (disk: Disk, dir: string): Promise<string[]> => {
  try {
    return (await disk.list(dir)).filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || x.isLink)).map(x => `${dir}/${x.name}`)
  } catch {
    return []
  }
}

/** Plugins installed from a marketplace: plugins/cache/<marketplace>/<plugin>/<version>, the newest version. */
const cacheDirs = async (disk: Disk, home: string): Promise<string[]> => {
  const out: string[] = []
  for (const market of await listDirs(disk, `${home}/.claude/plugins/cache`)) {
    for (const plugin of await listDirs(disk, market)) {
      const last = (await listDirs(disk, plugin)).sort().pop()
      if (last) out.push(last)
    }
  }
  return out
}

/** CLAUDE_CODE_PLUGIN_DIRS as folders: split at ':', `~` meaning the home folder. */
export const envDirs = (raw: string | null | undefined, home: string): string[] =>
  (raw ?? '')
    .split(':')
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x === '~' ? home : x.startsWith('~/') ? `${home}${x.slice(1)}` : x))
    .map(x => x.replace(/\/+$/, ''))

/** Every source file of a mod's hooks folder, tests left out. */
const hooksSource = async (disk: Disk, dir: string): Promise<string> => {
  let text = ''
  try {
    for (const x of await disk.list(`${dir}/hooks`)) {
      if (x.kind !== 'file' || !/\.(tsx?|jsx?|mjs|cjs)$/.test(x.name) || /\.test\./.test(x.name) || x.size > 2_000_000) continue
      text += `${await readText(disk, `${dir}/hooks/${x.name}`)}\n`
    }
  } catch {
    // An unreadable hooks folder finds nothing in it.
  }
  return text
}

/** The slash commands a source registers: `command.register({ name: 'scm', ...`. */
export const commandsIn = (source: string): string[] => {
  const out: string[] = []
  for (const m of source.matchAll(/command\.register\(\s*\{\s*name:\s*['"`]([^'"`]+)['"`]/g)) {
    const name = m[1] ?? ''
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// A mod is a plugin.json plus a hooks.json with "modules". Anything else is not one.
const inspect = async (disk: Disk, dir: string, isChatOnly: boolean): Promise<Row | null> => {
  const pluginRaw = await readText(disk, `${dir}/.claude-plugin/plugin.json`)
  if (!pluginRaw) return null
  if (!('modules' in parseObject(await readText(disk, `${dir}/hooks/hooks.json`)))) return null
  const plugin = parseObject(pluginRaw)
  const name = typeof plugin.name === 'string' && plugin.name ? plugin.name : (dir.split('/').pop() ?? '')
  if (!name || name === SELF) return null
  const source = await hooksSource(disk, dir)
  const known = KNOWN.find(k => k.name === name)
  const commands = commandsIn(source).map(c => `/${c}`)
  return {
    name,
    title: known?.title ?? titleCase(name),
    what: known?.what ?? (typeof plugin.description === 'string' ? plugin.description : ''),
    tip: known?.tip ?? commands.join(', '),
    icon: known?.icon ?? 'puzzle',
    hide: known?.hide ?? false,
    pane: known?.pane ?? false,
    switchable: source.includes('switches.json'),
    isChatOnly,
  }
}

/** Every mod found, known ones first in their order, then the rest A to Z, then this chat's own. */
export const scan = async (disk: Disk, opts: { home: string; sid: string; envList: string | null | undefined }): Promise<Row[]> => {
  const { home, sid } = opts
  const dirs: [string, boolean][] = []
  for (const d of await listDirs(disk, `${home}/.claude/mods`)) dirs.push([d, false])
  for (const d of envDirs(opts.envList, home)) dirs.push([d, false])
  for (const d of await cacheDirs(disk, home)) dirs.push([d, false])
  if (sid) for (const d of await listDirs(disk, `${home}/.claude/dev-mods/${sid}`)) dirs.push([d, true])

  const found = new Map<string, Row>()
  const seen = new Set<string>()
  for (const [dir, isChatOnly] of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const row = await inspect(disk, dir, isChatOnly)
    if (row && !found.has(row.name)) found.set(row.name, row)
  }
  const first: Row[] = []
  for (const k of KNOWN) {
    const hit = found.get(k.name)
    if (!hit) continue
    found.delete(k.name)
    first.push(hit)
  }
  const rest = [...found.values()].sort((a, b) => a.title.localeCompare(b.title))
  return [...first, ...rest.filter(r => !r.isChatOnly), ...rest.filter(r => r.isChatOnly)]
}

/** A signature of what the rows say, to tell whether a rescan changed anything to draw. */
export const signature = (rows: readonly Row[]): string => rows.map(r => `${r.name}|${r.title}|${r.what}|${r.tip}|${r.switchable}|${r.isChatOnly}`).join('\n')
