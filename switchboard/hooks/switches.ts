// The shared switch file, ~/.claude/mods/switches.json. Off is `"<mod>": false`, hidden is
// `"<mod>:hidden": true`; the key goes away when the switch goes back. A mod reads this file
// itself, so the format is the whole contract. Pure: no engine, no disk.

export type Switches = Record<string, unknown>

export const switchesPath = (home: string): string => `${home}/.claude/mods/switches.json`
/** The empty file a mod finds and deletes to open its own pane in one chat. */
export const openRequest = (home: string, sid: string, name: string): string => `${home}/.claude/mods/.open-${name}-${sid}`
export const hiddenKey = (name: string): string => `${name}:hidden`

export const parseSwitches = (raw: string): Switches => {
  try {
    const json = JSON.parse(raw) as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Switches) : {}
  } catch {
    return {}
  }
}

export const serialise = (s: Switches): string => `${JSON.stringify(s, null, 2)}\n`

export const isOff = (s: Switches, name: string): boolean => s[name] === false
export const isHidden = (s: Switches, name: string): boolean => s[hiddenKey(name)] === true

/** The switches with `name` turned the other way, and whether it is now off. */
export const flipOff = (s: Switches, name: string): { next: Switches; isNowOff: boolean } => {
  const next = { ...s }
  const isNowOff = !isOff(s, name)
  if (isNowOff) next[name] = false
  else delete next[name]
  return { next, isNowOff }
}

/** The switches with `name` hidden or shown the other way, and whether it is now hidden. */
export const flipHidden = (s: Switches, name: string): { next: Switches; isNowHidden: boolean } => {
  const next = { ...s }
  const isNowHidden = !isHidden(s, name)
  if (isNowHidden) next[hiddenKey(name)] = true
  else delete next[hiddenKey(name)]
  return { next, isNowHidden }
}
