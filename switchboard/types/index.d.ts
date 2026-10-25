/** A short line under the list after a press: "Source Control is off in every chat." */
export type Note = string

declare module 'claude-code' {
  interface PluginState {
    switchboard: { note: Note }
  }
}
