export type DelegateAgent = 'opencode' | 'codex'

export type DelegateStatus = 'running' | 'done' | 'failed' | 'killed'

export type DelegateRun = {
  /** The Bash call's tool_use_id. */
  id: string
  agent: DelegateAgent
  title: string
  model: string
  cwd: string
  status: DelegateStatus
  startedAt: number
  endedAt?: number
  /** Set when the Bash call went to the background. */
  taskId?: string
  /** A plain-text piece of the command, looked for in `ps` while it runs in the background. */
  fingerprint: string
  /** Background polls in a row that found no process; two end the run. */
  misses?: number
  /** Index into the card palette, given once at start, staggering the bounce. */
  colorIndex: number
}

export type Panel = {
  isDoneCollapsed: boolean
  hasAutoOpened: boolean
  isPaneOpen?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'delegate-monitor': {
      runs: DelegateRun[]
      panel: Panel
      now: number
      frame: number
    }
  }
}
