/** M modified, A added, D deleted, R renamed, C copied, T type changed, U untracked, ! conflict. */
export type Change = { path: string; orig?: string; code: string; isUntracked?: boolean }

export type Branch = { name: string; isDetached: boolean; oid: string; upstream: string; ahead: number; behind: number }

export type Status = {
  branch: Branch
  /** False on a repository with no commit yet. */
  hasHead: boolean
  staged: Change[]
  unstaged: Change[]
  conflicts: Change[]
}

export type LocalBranch = { name: string; isCurrent: boolean; upstream: string }

export type Commit = { hash: string; short: string; subject: string; author: string; when: string; isUnpushed?: boolean }

/** What git knows about the repository the pane shows. */
export type Repo = {
  /** Absolute path of the working tree's root; '' when there is none. */
  root: string
  status: Status | null
  branches: LocalBranch[]
  commits: Commit[]
  stashCount: number
  /** The first remote's name; '' for none. */
  remote: string
  /** Why there is no repository, in a few words. */
  problem: string
}

/** A diff ready to draw, or the reason there is nothing to draw. */
export type DiffView = { text: string; note: string }

export type CommitMode = 'commit' | 'push' | 'sync' | 'amend'

/** Which extra row the header opened under it. */
export type Drawer = '' | 'repo' | 'branch' | 'newbranch'

export type Notice = { kind: 'error' | 'info'; text: string }

export type View = {
  message: string
  mode: CommitMode
  /** Rows opened: "s:path" staged, "u:path" changes, "c:hash" a commit. */
  expanded: string[]
  /** Sections folded: conflicts, staged, changes, commits. */
  folded: string[]
  /** Diffs and `git show` texts of the open rows, by row key. */
  diffs: Record<string, DiffView>
  /** What is running ("Pushing…"); '' when idle. */
  busy: string
  isGenerating: boolean
  notice: Notice | null
  /** The destructive action waiting for its second press; '' for none. */
  confirm: string
  drawer: Drawer
  /** What the person typed in the drawer's field. */
  field: string
}

declare module 'claude-code' {
  interface PluginState {
    'source-control': {
      repo: Repo
      view: View
    }
  }
}
