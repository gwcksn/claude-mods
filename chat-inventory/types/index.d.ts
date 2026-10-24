/** One connector (an MCP server) and what this chat did with it. */
export type ConnectorRow = {
  /** The MCP server id: the row's key. */
  key: string
  name: string
  /** The tool called last, as the server names it: "list_events". */
  tool: string
  count: number
  /** Order of last use: higher is newer. */
  seq: number
}

/** One file this chat read, or a memory file loaded at start. */
export type FileRow = {
  /** Absolute path. */
  path: string
  /** A memory file the chat loaded at start (CLAUDE.md and the like). */
  auto: boolean
  seq: number
}

export type SkillRow = {
  name: string
  count: number
  seq: number
}

export type Inventory = {
  connectors: ConnectorRow[]
  files: FileRow[]
  skills: SkillRow[]
}

export type PlanStep = {
  text: string
  /** The present-tense form shown while the step is in progress. */
  active?: string
  status: 'pending' | 'in_progress' | 'completed'
  /** TaskCreate's id, so TaskUpdate finds the step. */
  id?: string
}

export type View = {
  /** Sections the person folded: todo, connectors, files, skills. */
  folded: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'chat-inventory': {
      inv: Inventory
      plan: PlanStep[]
      view: View
    }
  }
}
