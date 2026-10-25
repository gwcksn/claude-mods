import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlannedTask } from '../types'
import { clearHidden, readSwitch, takeOpenRequest } from './switch'

const flow = atom({ plugin: 'savvy-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'savvy-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
  isBandDismissed: false,
  isPaneOpen: false,
})
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
// The terminal crabs' walk frame; only the terminal drawing reads it.
const frame = atom({ plugin: 'savvy-progress', key: 'frame' } as const, 0)

const TOOL = 'mcp__savvy-progress__progress'
const STEP_TOOL = 'mcp__savvy-progress__step'
// Added to the end of each savvy worker's brief. Their system prompt words step
// reporting as a condition ("if the step tool appears among your tools") and they
// skip it even with the tool listed; the same request in the brief is followed.
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const PANE = 'savvy-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const TIERS: readonly string[] = ['fable', 'heavy', 'careful', 'medium', 'light']
// The tools' schemas are advice to the model, not a check: what a call may ask
// the band and the panel to draw is bounded here.
const MAX_TASKS = 200
const MAX_AFTER = 20
const MAX_TITLE = 120
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Hebrew or Russian.

type Lang = 'en' | 'ru' | 'he'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
    ctx: 'ctx',
    tier: { light: 'light', medium: 'medium', careful: 'careful', heavy: 'heavy', fable: 'fable', other: 'other' },
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    inChat: (n: number) => `${n} subagent${n === 1 ? '' : 's'} in this chat`,
    chatCost: 'Total chat cost',
    agentTokens: 'Subagent tokens',
    hide: 'Hide',
    step: 'Step',
    steps: 'steps',
    working: 'Working',
    showSide: 'Show sidebar',
    hideSide: 'Hide sidebar',
    clear: 'Clear subagents',
    now: 'Now',
    allDone: 'All done',
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    ctx: 'ctx',
    tier: { light: 'light', medium: 'medium', careful: 'careful', heavy: 'heavy', fable: 'fable', other: 'other' },
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    inChat: (n: number) => `Субагентов в чате: ${n}`,
    chatCost: 'Стоимость чата',
    agentTokens: 'Токены субагентов',
    hide: 'Скрыть',
    step: 'Шаг',
    steps: 'шагов',
    working: 'В работе',
    showSide: 'Показать панель',
    hideSide: 'Скрыть панель',
    clear: 'Очистить субагентов',
    now: 'Сейчас',
    allDone: 'Всё готово',
  },
  he: {
    pane: 'סוכנים',
    cost: 'עלות',
    tokens: 'טוקנים',
    time: 'זמן',
    collapse: 'כיווץ',
    expand: 'הרחבה',
    running: 'פועלים',
    finished: 'הסתיימו',
    planned: 'מתוכננים',
    empty: 'עדיין אין סוכנים.',
    round: 'סבב',
    failed: 'שגיאה',
    after: 'אחרי',
    tokensWord: 'טוקנים',
    agentsCount: 'סוכנים',
    isRunning: 'פועל',
    isFinished: 'הסתיים',
    isPlanned: 'מתוכנן',
    opened: 'חלונית הסוכנים נפתחה.',
    closed: 'חלונית הסוכנים נסגרה.',
    done: 'הושלם',
    plan: 'תכנון',
    design: 'עיצוב',
    tasks: 'משימות',
    review: 'בדיקה',
    busy: 'בעבודה',
    ctx: 'הקשר',
    tier: { light: 'קל', medium: 'בינוני', careful: 'זהיר', heavy: 'כבד', fable: 'פייבל', other: 'אחר' },
    effort: { low: 'נמוך', medium: 'בינוני', high: 'גבוה', xhigh: 'גבוה מאוד', max: 'מקסימלי' },
    inChat: (n: number) => `${n} סוכנים בצ'אט הזה`,
    chatCost: 'עלות הצ׳אט',
    agentTokens: 'טוקנים של סוכנים',
    hide: 'הסתרה',
    step: 'שלב',
    steps: 'שלבים',
    working: 'בעבודה',
    showSide: 'הצגת החלונית',
    hideSide: 'הסתרת החלונית',
    clear: 'ניקוי סוכנים',
    now: 'עכשיו',
    allDone: 'הכול הושלם',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

// Hebrew draws every row mirrored: crab and title on the right, numbers on the left.
const isRtl = () => lang === 'he'

// Tier and effort words as shown; anything unknown shows as it came.
const tierWord = (tier: string): string => (tr().tier as Record<string, string>)[tier] ?? tier
const effortWord = (effort: string): string => (tr().effort as Record<string, string>)[effort] ?? effort

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())
const isHebrew = (v: unknown): boolean => typeof v === 'string' && /^(he|iw|hebrew|עברית)/i.test(v.trim())
const langOf = (v: unknown): Lang => (isHebrew(v) ? 'he' : isRussian(v) ? 'ru' : 'en')

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru' || option === 'he') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return langOf(settings.language)
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return langOf(locale)
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && clip(input.title.trim(), MAX_TITLE) !== prev.title)

// Only a known tier is kept: the name is later a key into the tier tables.
const tierName = (v: string): string => {
  const t = v.replace(/^savvy-/, '').trim().toLowerCase()
  return TIERS.includes(t) ? t : ''
}

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .slice(0, MAX_TASKS)
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: tierName(t.tier ?? ''),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_AFTER),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.min(MAX_TASKS, Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total))))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: clip(input.title?.trim() || base.title, MAX_TITLE),
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a Chinese title was sized at half its width and the bar drew over it.
// 中日韩文字、全角标点和 emoji 约占 1em；按 0.56em 算时中文标题宽度被低估近一半，进度条会压到标题上。
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []
  // Positions are worked out left to right; right to left mirrors each box
  // inside the bar (`bx`) and across the row (`rx`). Text is never mirrored.
  const rtl = isRtl()
  const bx = (x: number, w: number): number => (rtl ? BAR_W - x - w : x)
  const rx = (x: number, w: number): number => (rtl ? W - x - w : x)

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${bx(c * CELL + 1, 2)}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${bx(c * CELL + 1, 1.7)}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${bx(x, 1.5)}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = bx(Math.max(0, Math.min(BAR_W - pillW, fillW - pillW)), pillW)
  const percent = `${Math.round(ratio(f) * 100)}%`
  // `direction="rtl"` puts Hebrew words and numbers in reading order; `start` is then the right edge.
  const titleAt = rtl ? `x="${W - 16}" direction="rtl" text-anchor="start"` : 'x="16"'
  const percentAt = rtl ? `x="${CRAB_W + 6}" y="${H / 2 + 4.5}"` : `x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end"`
  const crabW = CRAB_BOX * 0.8

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="${rtl ? W - 5 : 5}" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" ${titleAt} y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${rx(BAR_X, BAR_W)},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle"${rtl ? ' direction="rtl"' : ''} font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" ${percentAt} font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(rx(W - CRAB_W + 1, crabW), 0, 'other', false, isWorking, 0.8, rtl)}
</svg>`
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, [model: string, effort: string]> = {
  fable: ['Fable', 'high'],
  heavy: ['Opus', 'xhigh'],
  careful: ['Opus', 'high'],
  medium: ['Opus', 'medium'],
  light: ['Opus', 'low'],
}

// "Opus · xhigh", with the effort word in the panel's language; '' for an unknown tier.
const tierModel = (tier: string): string => {
  const m = TIER_MODEL[tier]
  return m ? `${m[0]} · ${effortWord(m[1])}` : ''
}

// "Opus 5.5 · low" for a run, or just the model when no effort was seen.
const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${effortWord(a.effort)}` : modelName(a.model))

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family.
// The engine reports tokens, not money, so the panel's cost is an estimate. It reports
// one cache-write count with no split by lifetime; writes are priced at the 1-hour
// rate (2x input), which is what Claude Code writes on a subscription.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const prompt = isRequest ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
  const [i, o, r, w] = priceOf(model, prompt)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return Object.hasOwn(TIER_COLOR, t) && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#ffffff;stroke:#e4e4e1}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#1e1e1d;stroke:#333331}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own. `mirror` flips the crab inside its
// own box (x .. x + CRAB_BOX * scale) so it faces left. `body` repaints the clay.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, mirror = false, body = CLAY): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c === CLAY ? body : c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const bodyG = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = mirror ? `translate(${x + CRAB_BOX * scale},${y}) scale(${-scale},${scale})` : `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${bodyG}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

// Panel rows are laid out left to right; in Hebrew each box mirrors across the
// row (`mx`) and text hugs the mirrored side. `words` text may hold Hebrew and
// takes `direction="rtl"` (whose `start` is the right edge); numbers stay
// left to right so "≈$0.25" keeps its order.
const mx = (W: number, x: number, w = 0): number => (isRtl() ? W - x - w : x)

// Text that starts at x: left-aligned, or right-aligned at the mirrored x.
const startText = (W: number, x: number, y: number, words = true): string =>
  !isRtl()
    ? `x="${x}" y="${y}"`
    : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="start"' : ' text-anchor="end"'}`

// Text that ends at x: right-aligned, or left-aligned at the mirrored x.
const endText = (W: number, x: number, y: number, words = false): string =>
  !isRtl() ? `x="${x}" y="${y}" text-anchor="end"` : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="end"' : ''}`

const crabWidth = (scale: number): number => Math.round(CRAB_BOX * scale * 100) / 100

// A panel crab at x in a row of width W: on the mirrored side and facing left in Hebrew.
const rowCrab = (W: number, x: number, y: number, costume: string, dim = false, isWalking = false, body = CLAY, scale = CRAB_SCALE): string =>
  crab(mx(W, x, crabWidth(scale)), y, costume, dim, isWalking, scale, isRtl(), body)

// The terminal crab in block glyphs, and its walk: legs step in turn while the
// body sidles a column, then a claw wave and a blink before the loop repeats.
const TICK_MS = 250
const CRAB_STILL = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']
const CRAB_WALK: readonly string[][] = [
  CRAB_STILL,
  ['  ▐▛███▜▌', ' ▝▜█████▛▘', '   ▝▝ ▘▘'],
  ['  ▐▛███▜▌', ' ▝▜█████▛▘', '   ▘▘ ▝▝'],
  [' ▐▛███▜▌', '▝▜█████▛▘', '  ▝▝ ▘▘'],
  CRAB_STILL,
  ['  ▐▛███▜▌', ' ▝▜█████▛▘', '   ▝▝ ▘▘'],
  ['▗ ▐▛███▜▌ ▖', ' ▝▜█████▛▘', '   ▘▘ ▝▝'],
  [' ▐█████▌', '▝▜█████▛▘', '  ▘▘ ▝▝'],
]

// The rows a crab draws at `tick`; `phase` (a running card's color index)
// staggers the crew. No phase: a crab that is not running, standing still.
export const crabFrame = (tick: number, phase?: number): string[] =>
  phase === undefined ? CRAB_STILL : (CRAB_WALK[(tick + phase * 3) % CRAB_WALK.length] ?? CRAB_STILL)

// --- cards: one color per run, given in spawn order.

const CARD_COLORS = ['#E06A2C', '#D0453F', '#2E9E5B', '#3B6FD0', '#C2407E', '#7F77DD', '#1D9E9E', '#C99A1E']
const STEP_INK = '#CC6B4E'
const DONE_INK = '#2E9E5B'
const SECTION = { running: '#22A04B', finished: '#E3AE16', planned: '#9A9A96' }

const cardColor = (a: AgentRun): string => CARD_COLORS[(a.colorIndex ?? 0) % CARD_COLORS.length] ?? CLAY

// "Step 4 · Writing thumbnails.md", "Done · 6 steps", or what the worker last did.
const stepLine = (a: AgentRun): { text: string; color: string } => {
  const s = tr()
  if (a.status === 'done') {
    const n = a.stepTotal || a.steps
    return { text: `${s.done} · ${n} ${s.steps}`, color: DONE_INK }
  }
  if (a.status === 'failed') return { text: s.failed, color: '#D0453F' }
  if (a.stepTotal) {
    const n = Math.min(a.stepTotal, (a.stepDone ?? 0) + 1)
    return { text: `${s.step} ${n}${a.stepNote ? ' · ' + a.stepNote : ''}`, color: STEP_INK }
  }
  return { text: `${s.working}…`, color: STEP_INK }
}

const MAX_RECENT = 2
const fileName = (p: unknown): string => (typeof p === 'string' ? p.split('/').filter(Boolean).pop() ?? p : '')

// A tool call in a worker's loop, in a few words; '' for the ones not worth a line.
const activityOf = (tool: string, input: Record<string, unknown>): string => {
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  switch (tool) {
    case 'Read':
      return `Reading ${fileName(input.file_path)}`
    case 'Write':
      return `Writing ${fileName(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${fileName(input.file_path ?? input.notebook_path)}`
    case 'Bash':
      return str('description') || `Running ${str('command').split(/\s+/)[0] ?? ''}`
    case 'Grep':
      return `Searching for ${str('pattern')}`
    case 'Glob':
      return `Listing ${str('pattern')}`
    case 'WebSearch':
      return `Searching the web: ${str('query')}`
    case 'WebFetch': {
      const host = /^https?:\/\/([^/]+)/.exec(str('url'))?.[1]
      return host ? `Reading ${host}` : 'Reading a web page'
    }
    case 'Skill':
      return `Reading the ${str('skill')} skill`
    case 'Agent':
      return `Delegating ${str('description')}`
    default:
      return ''
  }
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// "5 subagents in this chat", with the flow's name after it when one runs.
const TITLE_H = 28
const titleSvg = (W: number, text: string): string =>
  svg(W, TITLE_H, `<text ${startText(W, 2, 19)} font-family="${FONT}" font-size="15" font-weight="600" fill="${STEP_INK}">${xml(fitText(text, 15, W - 4))}</text>`)

const TILES_H = 64
const tilesSvg = (W: number, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 10
  const tw = (W - 2 - gap * 2) / 3
  const tile = (i: number, k: string, v: string) => {
    const x = 1 + i * (tw + gap)
    return `<rect class="tile" x="${mx(W, x, tw)}" y="1" width="${tw}" height="56" rx="8" stroke-width="1"/>
<text class="s" ${startText(W, x + 12, 23)} font-family="${FONT}" font-size="12">${xml(fitText(k, 12, tw - 20))}</text>
<text ${startText(W, x + 12, 45, false)} font-family="${FONT}" font-size="15" font-weight="500" fill="${STEP_INK}" font-variant-numeric="tabular-nums">${v}</text>`
  }
  return svg(W, TILES_H, `${tile(0, s.chatCost, fmtCost(t.cost))}${tile(1, s.agentTokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`)
}

// A full-width colored bar heading a section: "▾ Running · 4".
const SECTION_H = 34
const sectionSvg = (W: number, text: string, color: string): string =>
  svg(
    W,
    SECTION_H,
    `<rect x="${mx(W, 1, W - 2)}" y="6" width="${W - 2}" height="24" rx="3" fill="${color}"/>
<text ${startText(W, 10, 23)} font-family="${FONT}" font-size="13" font-weight="600" fill="#ffffff">${xml(`▾ ${text}`)}</text>`,
  )

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// A card: colored border, the crab in the card's color on the left; name, type and
// model; tokens and time on the right; the current step, the latest actions, a bar.
const CARD_GAP = 10
const CARD_SCALE = 1.4
const cardHeight = (a: AgentRun): number => 90 + Math.min(MAX_RECENT, a.recent?.length ?? 0) * 17 + CARD_GAP

const halfMoon = (W: number, x: number, y: number, color: string): string =>
  `<circle cx="${mx(W, x)}" cy="${y}" r="5" fill="none" stroke="${color}" stroke-width="1.3"/><path d="M${mx(W, x) - 5} ${y}a5 5 0 0 0 10 0z" fill="${color}"/>`

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = tr()
  const color = cardColor(a)
  const H = cardHeight(a)
  const cardH = H - CARD_GAP
  const x0 = 84
  const right = W - 20
  const textW = right - x0
  const recent = (a.recent ?? []).slice(0, MAX_RECENT)
  const step = stepLine(a)
  const progress = progressOf(a)
  const fillW = Math.round(textW * (progress ?? ctxOf(a) / 100))
  const stats = `${fmtTokens(a.tokens)} ${s.tokensWord} · ${fmtTime(elapsed(a, at))}`
  const meta = `${a.type.replace(/^[^:]*:/, '')} · ${modelName(a.model)}${a.round > 1 ? ` · ${s.round} ${a.round}` : ''}`
  const metaW = Math.max(40, textW - textWidth(stats, 12) - 12)
  const crabY = (cardH - 26 * CARD_SCALE) / 2 + 4
  const lines = recent
    .map((r, i) => `<text class="t" ${startText(W, x0 + 8, 82 + i * 17)} font-family="${FONT}" font-size="12.5">${xml(fitText(r, 12.5, textW - 8))}</text>`)
    .join('')
  return svg(
    W,
    H,
    `<rect x="1" y="1" width="${W - 2}" height="${cardH - 2}" rx="9" fill="${color}" fill-opacity="0.035" stroke="${color}" stroke-width="1.3"/>
${rowCrab(W, 16, crabY, costumeOf(a.type), false, a.status === 'running', color, CARD_SCALE)}
<text class="t" ${startText(W, x0, 27)} font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(a.description || a.type, 14, textW - 20))}</text>
${statusMark(mx(W, right - 2), 22, a.status, DONE_INK)}
<text class="s" ${startText(W, x0, 45)} font-family="${FONT}" font-size="12">${xml(fitText(meta, 12, metaW))}</text>
<text class="s" ${endText(W, right, 45)} font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${stats}</text>
${a.status === 'running' ? halfMoon(W, x0 + 5, 59, step.color) : ''}
<text ${startText(W, a.status === 'running' ? x0 + 15 : x0, 63)} font-family="${FONT}" font-size="13" fill="${step.color}">${xml(fitText(step.text, 13, textW - 15))}</text>
${lines}
<rect class="k" x="${mx(W, x0, textW)}" y="${cardH - 13}" width="${textW}" height="2.5" rx="1.25"/>
<rect x="${mx(W, x0, fillW)}" y="${cardH - 13}" width="${fillW}" height="2.5" rx="1.25" fill="${color}"${progress === null ? ' fill-opacity="0.45"' : ''}/>`,
  )
}

const PLANNED_H = 62
const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const x0 = 84
  const textW = W - 20 - x0
  const meta = [tierWord(tier), tierModel(tier)]
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    PLANNED_H,
    `<rect x="1" y="1" width="${W - 2}" height="${PLANNED_H - CARD_GAP - 2}" rx="9" fill="none" stroke="#9a9a96" stroke-width="1.1" stroke-dasharray="4 3"/>
${rowCrab(W, 16, 6, tier, true, false, color, CARD_SCALE * 0.8)}
<text class="s" ${startText(W, x0, 23)} font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 14, textW - 20))}</text>
<text class="m" ${startText(W, x0, 41)} font-family="${FONT}" font-size="12">${xml(fitText(meta.filter(Boolean).join(' · '), 12, textW))}</text>
${statusMark(mx(W, W - 22), 19, 'planned', color)}`,
  )
}

// What the Switchboard says: off draws no band or pane and refuses /agents-info, hidden draws none until
// /agents-info or Open. Tracking goes on either way, so nothing is lost when it comes back.
const NAME = 'savvy-progress'
let isOff = false
let isHidden = false

// Opens or closes the agents pane. The state records which, so the band's button
// redraws with the right word (it also asks the engine, at draw time).
async function setPane($: EngineInterface, isOpen: boolean): Promise<void> {
  if (isOpen) {
    // The clocks start from the open; a host with no clock still opens.
    await $.clock.now().then(
      at => update($, now, () => at),
      () => undefined,
    )
    await $.ui.open({ id: PANE, title: tr().pane })
  } else {
    await $.ui.close({ id: PANE })
  }
  await update($, panel, prev => ({ ...prev, isPaneOpen: isOpen }))
}

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  await setPane($, !isOpen)
  return !isOpen
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  if (isOff || isHidden) return
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  // A drawing aid: if the pane cannot open, the flow goes on without it.
  void setPane($, true).catch(() => undefined)
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await $.tool.register({
      name: 'progress',
      description:
        'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value. ' +
        'For the main session only: a call from a subagent is ignored (workers report with `step`).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: [...TIERS] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind ToolSearch: workers do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks and the terminal crabs' walk; quiet when nothing runs.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, frame, n => n + 1)
        // The clocks move once a second: a desktop row redrawn faster would
        // restart its crab's CSS walk before it got anywhere.
        const prev = await read($, now)
        if (Math.floor(at / 1000) !== Math.floor(prev / 1000)) await update($, now, () => at)
      })()
    })
    await follow($)
    $.clock.every(3000, () => {
      void follow($).catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async ($, e) => {
    if (isOff) return { text: 'Agents is off. Turn it on with /switchboard.' }
    if (isHidden) {
      await clearHidden($, NAME)
      isHidden = false
    }
    // `/agents-info open` opens the panel, or brings it forward from behind another tab, without toggling it.
    if ((e.args ?? '').trim() === 'open') {
      await setPane($, true)
      return { text: tr().opened }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The flow is the main session's: a call from a worker's loop carries its agentId
    // and changes nothing, or any subagent could rename, finish or reset the flow.
    if (e.agentId) return { result: 'ignored: only the main session reports the flow' }
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    await update($, panel, prev => ({ ...prev, isBandDismissed: false }))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let matched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        matched = true
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: matched ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  // A worker's tool calls, as the latest lines on its card.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const line = agentId ? activityOf(String(e.tool), e as unknown as Record<string, unknown>) : ''
    if (agentId && line) {
      // Only a drawing: a failed write must never hold up the worker's tool.
      await update($, agents, list =>
        list.map(a => (a.agentId === agentId ? { ...a, recent: [clip(line, 80), ...(a.recent ?? []).filter(r => r !== line)].slice(0, MAX_RECENT) } : a)),
      ).catch(() => undefined)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const isUnbriefed = e.subagentType.startsWith('savvy-') && !e.prompt.includes(STEP_TOOL)
    const started = await next(isUnbriefed ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
        colorIndex: list.reduce((n, a) => Math.max(n, (a.colorIndex ?? -1) + 1), 0),
        recent: [],
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    await update($, panel, prev => ({ ...prev, isBandDismissed: false }))
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    } else if (options.autoOpen === 'any') {
      await autoOpen($, 'any-agent')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage, false),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const count = list.length
    const heading = title ? `${s.inChat(count)} · ${title}` : s.inChat(count)
    const hide = <Button key="hide" label={s.hide} onPress={() => void setPane($, false)} />
    // Once nothing runs, the finished crew can be cleared away (and a finished flow with it).
    const clearAgents = (
      <Button
        key="clear"
        label={s.clear}
        onPress={async () => {
          await update($, agents, l => l.filter(a => a.status === 'running'))
          await update($, flow, prev => (prev?.isFinished ? null : prev))
        }}
      />
    )
    const canClear = list.length > 0 && running.length === 0
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string, color: string) => (
        <Svg key={key} source={sectionSvg(W, text, color)} alt={text} width={W} height={SECTION_H} />
      )
      const card = (a: AgentRun, state: string) => (
        <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${state}`} width={W} height={cardHeight(a)} />
      )
      return (
        <Box flexDirection="column" alignItems={isRtl() ? 'flex-end' : undefined}>
          <Box flexDirection={isRtl() ? 'row-reverse' : 'row'} alignItems="center" gap={1}>
            <Svg source={titleSvg(W - 70, heading)} alt={heading} width={W - 70} height={TITLE_H} />
            {hide}
          </Box>
          <Svg source={tilesSvg(W, t)} alt={summary} width={W} height={TILES_H} />
          {canClear && clearAgents}
          {isEmpty && <Text dimColor>{s.empty}</Text>}
          {running.length > 0 && section('h-run', `${s.running} · ${running.length}`, SECTION.running)}
          {running.map(a => card(a, s.isRunning))}
          {finished.length > 0 && section('h-done', `${s.finished} · ${finished.length}`, SECTION.finished)}
          {finished.map(a => card(a, s.isFinished))}
          {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`, SECTION.planned)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={PLANNED_H} />
          ))}
        </Box>
      )
    }

    // Terminal: the same cards as bordered boxes, the crab drawn in block glyphs.
    const cols = Math.max(28, e.props.bodyColumns || 40)
    const hasCrab = cols >= 44
    const innerW = cols - 4 - (hasCrab ? 11 : 0)
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
    // A running crab walks: its frame follows the clock, offset per card so
    // the crew does not move in lockstep.
    const tick = await read($, frame)
    const crabArt = (color: string, dim = false, phase?: number) => {
      const rows = crabFrame(tick, phase)
      return (
        <Box flexDirection="column" width={11} flexShrink={0} justifyContent="center">
          {rows.map((row, i) => (
            <Text key={`c${i}`} color={color} dimColor={dim}>
              {row}
            </Text>
          ))}
        </Box>
      )
    }
    const mark = (a: AgentRun) =>
      a.status === 'running' ? <Text color={DONE_INK}>●</Text> : a.status === 'done' ? <Text color={DONE_INK}>✓</Text> : <Text color="#D0453F">✗</Text>
    const card = (a: AgentRun) => {
      const color = cardColor(a)
      const step = stepLine(a)
      const progress = progressOf(a)
      const filled = Math.round(innerW * (progress ?? ctxOf(a) / 100))
      const meta = `${a.type.replace(/^[^:]*:/, '')} · ${modelName(a.model)}${a.round > 1 ? ` · ${s.round} ${a.round}` : ''}`
      return (
        <Box key={a.id} flexDirection="row" borderStyle="round" borderColor={color} paddingX={1}>
          {hasCrab && crabArt(color, false, a.status === 'running' ? (a.colorIndex ?? 0) : undefined)}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold wrap="truncate-end">
                {a.description || a.type}
              </Text>
              {mark(a)}
            </Box>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text dimColor wrap="truncate-end">
                {meta}
              </Text>
              <Text dimColor>
                {fmtTokens(a.tokens)} {s.tokensWord} · {fmtTime(elapsed(a, at))}
              </Text>
            </Box>
            <Text color={step.color} wrap="truncate-end">
              {a.status === 'running' ? '◒ ' : ''}
              {step.text}
            </Text>
            {(a.recent ?? []).slice(0, MAX_RECENT).map((r, i) => (
              <Text key={`r${i}`} wrap="truncate-end">
                {' '}
                {r}
              </Text>
            ))}
            <Text>
              <Text color={color}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'─'.repeat(Math.max(0, innerW - filled))}</Text>
            </Text>
          </Box>
        </Box>
      )
    }
    const narrow = cols < 60
    const tileW = Math.floor((cols - 2) / 3)
    const tile = (k: string, v: string) => (
      <Box key={k} flexDirection="column" width={tileW} flexShrink={0} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {k}
        </Text>
        <Text color={STEP_INK}>{v}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text color={STEP_INK} bold wrap="truncate-end">
            {heading}
          </Text>
          {hide}
        </Box>
        <Box flexDirection="row" gap={1}>
          {tile(narrow ? s.cost : s.chatCost, fmtCost(t.cost))}
          {tile(narrow ? s.tokens : s.agentTokens, fmtTokens(t.tokens))}
          {tile(s.time, fmtTime(t.time))}
        </Box>
        {canClear && clearAgents}
        {isEmpty && <Text dimColor>{s.empty}</Text>}
        {running.length > 0 && bar('h-run', `▾ ${s.running} · ${running.length}`, SECTION.running)}
        {running.map(card)}
        {finished.length > 0 &&
          bar('h-done', `${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`, SECTION.finished, () =>
            update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed })),
          )}
        {!p.isDoneCollapsed && finished.map(card)}
        {planned.length > 0 && bar('h-plan', `▾ ${s.planned} · ${planned.length}`, SECTION.planned)}
        {planned.map(pl => {
          const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
          return (
            <Box key={`plan-${pl.n}`} flexDirection="row" borderStyle="round" borderDimColor paddingX={1}>
              {hasCrab && crabArt(colorOf(tier), true)}
              <Box flexDirection="column" flexGrow={1}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text dimColor bold wrap="truncate-end">
                    {pl.n}. {pl.title}
                  </Text>
                  <Text dimColor>◷</Text>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {tierWord(tier)} · {tierModel(tier)}
                  {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isOff || isHidden) return next(e)
    const flowNow = await read($, flow)
    const list = await read($, agents)
    const p: Panel = await read($, panel)
    // A flow reports its own plan; without one, any subagent still gets a band that counts them.
    const hasBand = flowNow !== null || (list.length > 0 && !p.isBandDismissed)
    if (!hasBand || e.props.hasSurvey) return next(e)
    const running = list.filter(a => a.status === 'running')
    const f: Flow =
      flowNow ?? {
        ...blank(),
        title: tr().pane,
        total: list.length,
        done: list.length - running.length,
        running: running.length,
        phase: 'delegate',
        isFinished: running.length === 0,
      }
    // Draw this row with the other mods' bands beneath it. Claude Code's own placeholder ({ type: 'engine' }) is
    // never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isWorking = running.length > 0
    // What the engine says, since the pane can also be closed from outside; the state is the fallback.
    const isOpen = await $.ui.panes().then(
      panes => panes.some(x => x.id === PANE),
      () => p.isPaneOpen === true,
    )
    const sideLabel = isOpen ? s.hideSide : s.showSide
    const sideButton = <Button key="savvy-agents" label={sideLabel} plain onPress={() => void togglePane($)} />
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={async () => {
          await update($, flow, () => null)
          await update($, panel, prev => ({ ...prev, isBandDismissed: true }))
        }}
      />
    )
    const names = running.map(a => a.description || a.type)
    const nowText = names.length
      ? `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
      : flowNow && !flowNow.isFinished && flowNow.phase !== 'close'
        ? label(flowNow)
        : s.allDone
    const nowLine = `${s.now}: ${nowText}`

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the toggle, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96 - sideLabel.length * 6))
      return (
        <Box flexDirection="column">
          <Box flexDirection={isRtl() ? 'row-reverse' : 'row'} alignItems="center" gap={1}>
            <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
            {sideButton}
            {dismiss}
          </Box>
          <Text dimColor wrap="truncate-end">
            {nowLine}
          </Text>
          {below}
        </Box>
      )
    }

    // Terminal: a rounded box like the prompt's own, two lines: the bar, then what is happening now.
    const cols = Math.max(30, e.props.bodyColumns)
    const inner = cols - 4
    const text = label(f)
    const pillW = text.length + 2
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(inner / 3)))
    const width = Math.max(4, Math.min(48, inner - titleW - pillW - 4 - sideLabel.length - 1 - 5))
    const filled = Math.round(width * ratio(f))
    const color = f.isFinished ? DONE : ACCENT
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Box width={titleW} flexShrink={0}>
              <Text color={color}>● </Text>
              <Text bold wrap="truncate-end">
                {f.title}
              </Text>
            </Box>
            <Text backgroundColor={color} color="#ffffff" bold>
              {` ${text} `}
            </Text>
            <Text>
              <Text color={color}>{'█'.repeat(filled)}</Text>
              <Text dimColor>{'░'.repeat(Math.max(0, width - filled))}</Text>
            </Text>
            <Text dimColor>{percent.padStart(4)}</Text>
            {sideButton}
            {dismiss}
          </Box>
          <Text dimColor wrap="truncate-end">
            {nowLine}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })
}
