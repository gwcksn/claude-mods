import { expect, mock, test } from 'claude-code/testing'

const props = { title: 'Switchboard', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
const HOME = '/home/u'

// A fake machine: every mod is a folder with plugin.json, hooks/hooks.json and hooks/<source>.
const mod = (dir: string, name: string, source: string, description = '') => ({
  [`${dir}/.claude-plugin/plugin.json`]: JSON.stringify({ name, description }),
  [`${dir}/hooks/hooks.json`]: JSON.stringify({ modules: ['./register.tsx'] }),
  [`${dir}/hooks/register.tsx`]: source,
})
const SWITCHABLE = "const f = 'switches.json'"
const disk: Record<string, string> = {
  ...mod('/work/mods/source-control', 'source-control', `${SWITCHABLE}\nawait $.command.register({ name: 'scm' })`),
  ...mod('/work/mods/savvy-progress', 'savvy-progress', SWITCHABLE),
  ...mod('/work/mods/token-weather', 'token-weather', "await $.command.register({ name: 'weather' })"),
  ...mod('/work/mods/zeta-notes', 'zeta-notes', `${SWITCHABLE}\nawait $.command.register({ name: 'zeta' })`, 'Keeps short notes beside the chat'),
  ...mod('/work/mods/alpha', 'alpha', SWITCHABLE, 'Found through the env list'),
  ...mod('/work/mods/switchboard', 'switchboard', SWITCHABLE),
  [`/work/mods/not-a-mod/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'not-a-mod' }),
  [`/work/mods/not-a-mod/hooks/hooks.json`]: JSON.stringify({ hooks: {} }),
  ...mod(`${HOME}/.claude/plugins/cache/market/replay-theater/0.1.0`, 'replay-theater', SWITCHABLE, 'Replays each edit'),
  ...mod(`${HOME}/.claude/dev-mods/sid-1/brand-new`, 'brand-new', SWITCHABLE, 'Made in this chat'),
}
const dirs: Record<string, string[]> = {
  '/work/mods': ['source-control', 'savvy-progress', 'token-weather', 'zeta-notes', 'alpha', 'switchboard', 'not-a-mod'],
  [`${HOME}/.claude/plugins/cache`]: ['market'],
  [`${HOME}/.claude/plugins/cache/market`]: ['replay-theater'],
  [`${HOME}/.claude/plugins/cache/market/replay-theater`]: ['0.1.0'],
  [`${HOME}/.claude/dev-mods/sid-1`]: ['brand-new'],
}
const ENV = { HOME, CLAUDE_CODE_PLUGIN_DIRS: [...dirs['/work/mods']!.map(d => `/work/mods/${d}`)].join(':') }

const setup = async ($: any, on: any, surface: 'desktop' | 'terminal') => {
  const files: Record<string, string> = {}
  const opened: string[] = []
  const find = (end: string) => Object.keys(files).find(k => k.endsWith(end))
  on('session.start', async ($: any, e: any) => ({ cwd: e.cwd }) as never)
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('fs.exists', async ($: any, e: any) => ({ value: e.path in files }) as never)
  on('fs.read', async ($: any, e: any) => {
    const path: string = e.path
    if (path in files) return { value: files[path] } as never
    if (path in disk) return { value: disk[path] } as never
    throw new Error(`ENOENT ${path}`)
  })
  on('fs.write', async ($: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  on('fs.list', async ($: any, e: any) => {
    const path: string = String(e.path).replace(/\/+$/, '')
    if (dirs[path]) return { value: dirs[path]!.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) } as never
    const names = [...new Set(Object.keys(disk).filter(k => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/')).map(k => k.slice(path.length + 1)))]
    if (!names.length) throw new Error(`ENOENT ${path}`)
    return { value: names.map(name => ({ name, kind: 'file', size: 10, mtimeMs: 0, isLink: false })) } as never
  })
  mock.clock(on, { now: new Date(2026, 9, 25, 9, 0).getTime() })
  mock.env(on, ENV)
  await $.session.start({ source: 'startup', cwd: '/work', surface, isInteractive: true } as never)
  return { files, opened, find }
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`finds mods by itself, in order, and says what cannot be switched (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const { opened } = await setup($, on, surface)
    await $.command.run({ command: 'switchboard', args: '' } as never)
    expect(opened, '/switchboard opens the pane').toContain('switchboard')
    const v = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', requestId: 'switchboard', props })

    // Known mods are named from the table, new ones from plugin.json.
    expect(await v.find({ text: 'Agents' })).toBeDefined()
    expect(await v.find({ text: 'Source Control' })).toBeDefined()
    expect(await v.find({ text: '/scm to open' }), 'a known mod’s tip').toBeDefined()
    expect(await v.find({ text: 'Zeta Notes' })).toBeDefined()
    expect(await v.find({ text: 'Keeps short notes beside the chat' }), 'its description').toBeDefined()
    expect(await v.find({ text: '/zeta' }), 'and the command found in its source').toBeDefined()
    expect(await v.find({ text: 'Replay Theater' }), 'a marketplace install').toBeDefined()
    expect(await v.find({ text: 'Brand New' })).toBeDefined()
    expect(await v.find({ text: 'This chat only' })).toBeDefined()

    // Not switchable: a note and no toggle. Not a mod, and the pane itself: no row.
    expect(await v.find({ text: 'Token Weather' })).toBeDefined()
    expect(await v.find({ key: 'toggle-token-weather' })).toBeUndefined()
    expect(await v.find({ text: /Not switchable yet/ })).toBeDefined()
    expect(await v.find({ text: 'Not A Mod' })).toBeUndefined()
    expect(await v.find({ key: 'row-switchboard' })).toBeUndefined()

    // Eye and Open only where the mod draws something.
    expect(await v.find({ key: 'eye-source-control' })).toBeDefined()
    expect(await v.find({ key: 'open-source-control' })).toBeDefined()
    expect(await v.find({ key: 'eye-zeta-notes' }), 'a found mod has no eye').toBeUndefined()

    const order = (await v.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('row-')).map(k => k.slice(4))
    expect(order).toEqual(['savvy-progress', 'source-control', 'token-weather', 'alpha', 'replay-theater', 'zeta-notes', 'brand-new'])
  })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`On/Off writes the shared file, and the eye hides and shows (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const { files, find } = await setup($, on, surface)
    const v = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', requestId: 'switchboard', props })

    await v.press({ key: 'toggle-source-control' })
    const sw = find('/.claude/mods/switches.json') ?? ''
    expect(sw, 'written under the home folder, not the plugin folder').toBe(`${HOME}/.claude/mods/switches.json`)
    expect(JSON.parse(files[sw] ?? '{}')).toEqual({ 'source-control': false })
    expect(await v.find({ text: 'Source Control is off in every chat.' })).toBeDefined()
    expect(await v.find({ key: 'eye-source-control' }), 'no eye while off').toBeUndefined()
    expect(await v.find({ key: 'open-source-control' }), 'no Open while off').toBeUndefined()

    await v.press({ key: 'toggle-source-control' })
    expect(JSON.parse(files[sw] ?? '{}'), 'back on: the key is gone').toEqual({})

    await v.press({ key: 'eye-savvy-progress' })
    expect(JSON.parse(files[sw] ?? '{}')).toEqual({ 'savvy-progress:hidden': true })
    expect(await v.find({ text: 'Agents is hidden in every chat.' })).toBeDefined()
    expect(await v.find({ key: 'open-savvy-progress' }), 'no Open while hidden').toBeUndefined()
    expect(find('/.claude/mods/.open-savvy-progress-sid-1'), 'hiding asks for nothing').toBeUndefined()

    // Shown again: the pane mod is asked to open itself in this chat.
    await v.press({ key: 'eye-savvy-progress' })
    expect(JSON.parse(files[sw] ?? '{}')).toEqual({})
    expect(find('/.claude/mods/.open-savvy-progress-sid-1'), 'open request for this chat').toBeDefined()
  })

  test(`Open writes an empty request for this chat only while the mod is on and shown (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const { files, find } = await setup($, on, surface)
    const v = await $.ui.mount({ plugin: 'switchboard', surface, component: 'Pane', requestId: 'switchboard', props })

    expect(await v.find({ key: 'open-chat-inventory' }), 'a mod that is not here has no button').toBeUndefined()

    await v.press({ key: 'open-source-control' })
    const ask = find('/.claude/mods/.open-source-control-sid-1') ?? ''
    expect(ask).not.toBe('')
    expect(files[ask]).toBe('')
    expect(await v.find({ text: 'Source Control opens in this chat within 3 seconds.' })).toBeDefined()
  })
}
