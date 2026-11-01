// What the test files share: a made-up agent, the panes they mount, and a stand-in for Claude Code.
import { mock } from 'claude-code/testing'
import type { Agent } from '../types'
/** The test runtime has timers; the hooks environment's declarations leave them out. */
declare const setTimeout: (fn: () => void, ms: number) => unknown

export const agent = (over: Partial<Agent>): Agent => ({
  id: 'a1', name: 'docs', type: 'general-purpose', description: 'Rewrite the setup guide', status: 'running',
  context: 0, startedAt: 0, recent: [], files: [], edits: 0, fails: 0, steps: [], ...over,
})

export const PANE = {
  plugin: 'redhelm', component: 'Pane', requestId: 'redhelm',
  props: { title: 'REDhelm', isFocused: true, bodyColumns: 48, placement: 'dock' },
} as const

export const SHEET = {
  plugin: 'redhelm', component: 'Pane', requestId: 'redhelm-agent',
  props: { title: 'Agent', isFocused: true, bodyColumns: 70, placement: 'inline' },
} as const

/** Click an agent's name on the panel: its sheet is drawn in the panel itself, and "closing" it is Back. */
export const openSheet = async (_$: any, ui: any, id: string, _surface = 'terminal') => {
  await ui.press({ key: `sel-${id}` })
  await new Promise<void>(r => setTimeout(() => r(), 40))
  return {
    find: (q: any) => ui.find(q),
    findAll: (q: any) => ui.findAll(q),
    press: (t: any) => ui.press(t),
    // Back, unless the sheet already went back on its own (Message returns to the panel).
    unmount: async () => { if (await ui.find({ key: 'back' })) await ui.press({ key: 'back' }); await new Promise<void>(r => setTimeout(() => r(), 40)) },
  }
}

/** Beneath REDhelm: the engine's session, spawn and tools answer without running anything. */
/** The mocked clock of the latest engine(), so a test can move time on. */
export let clock: any
/** `shown`: Claude Code reports REDhelm's pane on screen, so its clock, traces and labels run. */
/** `opened`: each pane REDhelm opens, as it asked for it. `closed`: each pane it closes. */
export const engine = (on: any, isInteractive: boolean, opts: { shown?: boolean; opened?: any[]; closed?: any[] } = {}) => async ($: any) => {
  clock = mock.clock(on)
  mock.store(on)
  on('ui.open', (_$: any, e: any) => (opts.opened?.push(e), { value: { isPlaced: true } }))
  on('ui.close', (_$: any, e: any) => (opts.closed?.push(e), { value: undefined }))
  on('ui.panes', () => ({ value: opts.shown ? [{ id: 'redhelm', title: 'REDhelm', isShown: true }] : [] }))
  on('classic.PostModelSwitch', () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => { // Claude Code's own (empty) band
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.start', () => ({ cwd: '/p' }))
  on('session.root', () => ({ value: '/p' }))
  on('command.register', () => ({ value: { command: 'redhelm' } }))
  let spawned = 0 // each spawn gets the next id: a1, a2, ...
  on('agent.spawn', () => ({ model: 'claude-opus-5-5[1m]', agentId: `a${++spawned}` }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive })
}

export const spawn = ($: any) => $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
export const edit = ($: any) => $.tool.call({ tool: 'Edit', file_path: 'src/guide/setup.md', old_string: 'a', new_string: 'b', agentId: 'a1' })
