import type { EngineInterface } from 'claude-code'

// How this mod follows the Switchboard (~/.claude/mods/switches.json): `"<name>": false` is off,
// `"<name>:hidden": true` is hidden, and an empty `.open-<name>-<session id>` file asks this chat to
// open the mod's pane (the mod deletes it). The same file in every mod; a missing or broken file
// means nothing is switched. Nothing here throws.

export type Switch = { isOff: boolean; isHidden: boolean }

const dir = (home: string): string => `${home}/.claude/mods`

// $ goes only into function declarations: the engine follows it no further.
async function homeOf($: EngineInterface): Promise<string> {
  try {
    return (await $.env.get('HOME')) ?? ''
  } catch {
    return ''
  }
}

async function readFile($: EngineInterface, home: string): Promise<Record<string, unknown>> {
  try {
    const path = `${dir(home)}/switches.json`
    if (!(await $.fs.exists(path))) return {}
    const json = JSON.parse(String(await $.fs.read(path))) as unknown
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** What the Switchboard says about `name` right now. */
export async function readSwitch($: EngineInterface, name: string): Promise<Switch> {
  const home = await homeOf($)
  if (!home) return { isOff: false, isHidden: false }
  const json = await readFile($, home)
  return { isOff: json[name] === false, isHidden: json[`${name}:hidden`] === true }
}

/** True once when the Switchboard asked this chat to open `name`'s pane; the request is used up. */
export async function takeOpenRequest($: EngineInterface, name: string): Promise<boolean> {
  try {
    const home = await homeOf($)
    if (!home) return false
    const path = `${dir(home)}/.open-${name}-${await $.session.id()}`
    if (!(await $.fs.exists(path))) return false
    await $.process.run(['rm', '-f', path])
    return true
  } catch {
    return false
  }
}

/** Shows `name` again in every chat, for when a person opens it by its own command. */
export async function clearHidden($: EngineInterface, name: string): Promise<void> {
  try {
    const home = await homeOf($)
    if (!home) return
    const json = await readFile($, home)
    if (json[`${name}:hidden`] !== true) return
    delete json[`${name}:hidden`]
    await $.process.run(['mkdir', '-p', dir(home)])
    await $.fs.write(`${dir(home)}/switches.json`, `${JSON.stringify(json, null, 2)}\n`)
  } catch {
    // The command still opens the pane for this chat.
  }
}
