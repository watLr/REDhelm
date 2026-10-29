import { describe, expect, mock, test } from 'claude-code/testing'

import type { Agent } from '../types'

/** The test runtime has timers; the hooks environment's declarations leave them out. */
declare const setTimeout: (fn: () => void, ms: number) => unknown
import { appearance, grouped, tidyPaths, looksLikeQuestion, isNewer, age, firstAsk, plainHeadline, stateOf,
  DEFAULTS, activity, handleOf, handles, settings, foldLanes, foldStatusBoard, isStale, kindOf, overlaps, parseRun, parseStandards, phase, remember, short, staleTarget,
} from '../hooks/model'
import { workspaces, type Io } from '../hooks/sources'
import { label, rack, relevant, shortName, summary, type View } from '../hooks/view'
import { bars, buckets, burst, mix, rasterCells, record, spectrum, speed, tail } from '../hooks/trace'
import { clean, hash, labeler, type Complete } from '../hooks/labels'
import { PALETTES, animates, backdrop as drawBackdrop, isLattice } from '../hooks/backdrop'
import { agentCalls, applyReading, checkReading, command, defaultForm, foldRepeats, groupRoles, isPrompt, leadSkills, leadTrace, readingRequest, readWorkflow,
  READING_CALL, READING_SYSTEM, runCalls, sharedParts, stagesOf, stretches, teamOf, widen, type Msg } from '../hooks/workflows'

const agent = (over: Partial<Agent>): Agent => ({
  id: 'a1', name: 'docs', type: 'general-purpose', description: 'Rewrite the setup guide', status: 'running',
  context: 0, startedAt: 0, recent: [], files: [], edits: 0, fails: 0, steps: [], ...over,
})

/** An in-memory folder tree standing in for $.fs. */
const fakeIo = (files: Record<string, string>, root = '/p'): Io => {
  const isDir = (d: string) => Object.keys(files).some(f => f.startsWith(`${d}/`))
  return {
    root,
    read: async p => {
      if (!(p in files)) throw new Error(`missing ${p}`)
      return files[p]!
    },
    stat: async p => {
      if (!(p in files) && !isDir(p)) throw new Error(`missing ${p}`)
      return { mtimeMs: 1 }
    },
    exists: async p => p in files || isDir(p),
    list: async d => [...new Set(Object.keys(files).filter(f => f.startsWith(`${d}/`)).map(f => f.slice(d.length + 1).split('/')[0]!))]
      .map(name => ({ name, kind: isDir(`${d}/${name}`) ? 'dir' : 'file' })),
  }
}

describe('models', () => {
  test('names and staleness follow the guard scripts', async () => {
    expect(short('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(short('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(isStale('claude-opus-5[1m]', 'claude-opus-5-5')).toBe(true)
    expect(isStale('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(false)
    expect(isStale('claude-haiku-4-5', 'claude-opus-5-5')).toBe(false)
  })

  test('the saved default resolves a picker alias to the newest version seen', async () => {
    const seen = remember(remember({}, 'claude-opus-5-5[1m]'), 'claude-opus-6')
    expect(seen).toEqual({ opus: 'claude-opus-6' })
    expect(remember(seen, 'claude-opus-5')).toBe(seen)
    expect(staleTarget('claude-opus-5-5[1m]', 'opus', seen)).toBe('claude-opus-6')
    expect(staleTarget('claude-opus-6', 'opus', seen)).toBeUndefined()
    expect(staleTarget('claude-opus-5', 'claude-opus-5-5[1m]', {})).toBe('claude-opus-5-5')
  })

  test('setup asks for pause-on-flag, never for switching models automatically', async () => {
    const flag = DEFAULTS.find(d => d.key === 'switchModelsOnFlag')!
    expect(flag.want(['Switch automatically', 'Ask each time'])).toBe('Ask each time')
  })
})

describe('what agents do', () => {
  test('tool calls read as phase, activity and changed files', async () => {
    expect(activity('Edit', { file_path: '/p/src/app/server.ts' })).toBe('Edit server.ts')
    expect(activity('Bash', { command: 'npm test -- --watch' })).toBe('Bash npm test')
    expect(activity('Monitor', { command: 'until [ -f out ]; do sleep 1; done', description: 'Wait for the build' })).toBe('Wait for the build')
    expect(activity('SendMessage', { to: 'main', message: 'Done?' })).toBe('Message to main')
    expect(phase(['exploring', 'building', 'building', 'checking'])).toBe('building')
    expect(phase(['building', 'checking'])).toBe('checking')
    expect(kindOf('Grep')).toBe('exploring')
  })

  test('overlaps flag a file two live agents are both changing', async () => {
    const list = [
      agent({ id: 'a', files: ['src/guide/setup.md', 'src/app/index.ts'] }),
      agent({ id: 'b', name: 'camera', files: ['src/guide/setup.md', 'tools/cam.mjs'] }),
      agent({ id: 'c', status: 'completed', files: ['src/guide/setup.md'] }),
    ]
    expect(overlaps(list)).toEqual([{ file: 'src/guide/setup.md', ids: ['a', 'b'] }])
  })
})

describe('workflows', () => {
  test('status-board folds to open rows, newest first', async () => {
    const events = [
      '{"t":"2026-10-05T20:00:00Z","id":"P1","stages":{"Done":"yes","Verified":"yes","Reviewed":"yes","Shipped":"yes"}}',
      '{"t":"2026-10-05T20:10:00Z","id":"P2","note":"started","stages":{"Done":"doing"}}',
      '{"t":"2026-10-05T20:20:00Z","id":"P3","note":"first","stages":{"Done":"yes"}}',
      '{"t":"2026-10-05T20:30:00Z","id":"P4","stages":{"Done":"skip","Verified":"skip","Reviewed":"skip","Shipped":"skip"}}',
      'not json',
    ].join('\n')
    const { rows, total } = foldStatusBoard(events, ['Done', 'Verified', 'Reviewed', 'Shipped'])
    expect(total).toBe(4)
    expect(rows.map(r => r.id)).toEqual(['P3', 'P2'])
  })

  test('lane boards count checked-done items and show the furthest open one', async () => {
    const spec = { lanes: [{ id: 'api', title: 'API', agent: 'a1', items: [{ id: '1', title: 'Auth' }, { id: '2', title: 'Cache' }] }] }
    const lanes = foldLanes(spec, { api: '{"item":"1","stage":"checked","status":"done"}\n{"item":"2","stage":"looked","status":"done"}' })
    expect(lanes[0]).toEqual({ id: 'api', title: 'API', done: 1, total: 2, active: 'Cache', agent: 'a1' })
  })

  test('REDManager v1 ledgers and v2 snapshots both parse', async () => {
    expect(parseRun('demo-run', '# REDManager state ledger\n- Run status: `ACTIVE`\n| P1 | `DISPATCHED` |')).toEqual({
      name: 'demo-run', status: 'ACTIVE', next: undefined, open: 1,
    })
    expect(parseRun('x', '{"run_id":"r","status":"PAUSED","next_action":"Verify","open_attempts":[{}]}')).toEqual({
      name: 'r', status: 'PAUSED', next: 'Verify', open: 1,
    })
  })

  test('REDStudio standards count and newest title', async () => {
    const md = '- **S1 · 2026-10-01 · Short labels.** text\n- **S2 · 2026-10-02 · Real content first.** text'
    expect(parseStandards(md)).toEqual({ standards: 2, latest: 'Real content first' })
  })

  test('workspaces are found at the root and one level below', async () => {
    const io = fakeIo({
      '/p/app/.redstudio/standards.md': '- **S1 · 2026-10-01 · Short labels.** x',
      '/p/app/.status-board/events.jsonl': '{"t":"2026-10-05T20:10:00Z","id":"P2","stages":{"Done":"doing"}}',
      '/p/app/.status-board/config.json': '{"name":"Demo app","stages":["Done","Shipped"]}',
      '/p/game/docs/aaa/board/lanes.json': '{"lanes":[{"id":"api","title":"API","items":[{"id":"1"}]}]}',
      '/p/Plain/readme.md': 'no workflow',
      '/p/.redmanager/state.md': '- Run status: `ACTIVE`',
    })
    const found = await workspaces(io)
    expect(found.map(w => w.name)).toEqual(['p', 'Demo app', 'game'])
    expect(found[0]!.runs?.[0]?.status).toBe('ACTIVE')
    expect(found[1]!.studio?.standards).toBe(1)
    expect(found[1]!.board?.rows.length).toBe(1)
    expect(found[2]!.lanes?.[0]?.total).toBe(1)
  })
})

const PANE = {
  plugin: 'redhelm', component: 'Pane', requestId: 'redhelm',
  props: { title: 'REDhelm', isFocused: true, bodyColumns: 48, placement: 'dock' },
} as const

const SHEET = {
  plugin: 'redhelm', component: 'Pane', requestId: 'redhelm-agent',
  props: { title: 'Agent', isFocused: true, bodyColumns: 70, placement: 'inline' },
} as const

/** Click an agent's name on the panel: its sheet is drawn in the panel itself, and "closing" it is Back. */
const openSheet = async (_$: any, ui: any, id: string, _surface = 'terminal') => {
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
let clock: any
/** `shown`: Claude Code reports REDhelm's pane on screen, so its clock, traces and labels run. */
const engine = (on: any, isInteractive: boolean, opts: { shown?: boolean } = {}) => async ($: any) => {
  clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
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

const spawn = ($: any) => $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
const edit = ($: any) => $.tool.call({ tool: 'Edit', file_path: 'src/guide/setup.md', old_string: 'a', new_string: 'b', agentId: 'a1' })

describe('the pane', () => {
  test('a spawned agent shows live on every surface, with Message on each', async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    await edit($)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
      expect(await ui.find({ type: 'Text', text: /^Edit setup\.md$/ })).toBeDefined() // its headline, in plain words until the model writes one
      // The trace: repainted in place on the terminal, a drawing elsewhere.
      expect(await ui.find(surface === 'terminal' ? { type: 'Raster', key: 'trace-a1' } : { type: 'Svg' })).toBeDefined()
      const sheet = await openSheet($, ui, 'a1', surface)
      expect(await sheet.find({ type: 'Text', text: /^Task$/ })).toBeDefined()
      expect(await sheet.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
      expect(await sheet.find({ type: 'Text', text: /Edit setup\.md/ })).toBeDefined()
      expect(await sheet.find({ key: 'compose-a1' })).toBeDefined() // messaging goes through the prompt, so every surface has it
      await sheet.unmount()
      await ui.unmount()
    }
  })

  test('stays out of sessions nobody watches (claude -p, SDK, spawned runs)', async ($: any, on: any) => {
    await engine(on, false)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ key: 'sel-a1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('the bottom panel lays the rack out one line per agent, bays beside it', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 140 } } as any)
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
    expect(await ui.find({ type: 'Text', text: /^Getting started$/ })).toBeDefined()
    await ui.unmount()
  })

  test('on the classic screen, where clicks never arrive, it says how to turn fullscreen on', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const props = { ...PANE.props, placement: 'inline', bodyColumns: 140 }
    const classic = await $.ui.mount({ ...PANE, surface: 'terminal', props, viewport: { columns: 140, rows: 40, isFullscreen: false } } as any)
    expect(await classic.find({ type: 'Text', text: /\/tui fullscreen/ })).toBeDefined()
    await classic.unmount()
    const full = await $.ui.mount({ ...PANE, surface: 'terminal', props, viewport: { columns: 140, rows: 40, isFullscreen: true } } as any)
    expect(await full.find({ type: 'Text', text: /\/tui fullscreen/ })).toBeUndefined()
    await full.unmount()
  })

  test('/redhelm bottom moves the whole rack above the prompt, and /redhelm folds it', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const run = (args: string) => $.command.run({ command: 'redhelm', args, origin: { kind: 'person' }, presentation: {} } as any)
    const band = { plugin: 'redhelm', component: 'AbovePrompt', surface: 'terminal',
      props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120 } } as any

    expect((await run('bottom')).text).toBe('REDhelm now lives at the bottom')
    let ui = await $.ui.mount(band)
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
    await ui.unmount()

    expect((await run('')).text).toBe('REDhelm folded')
    ui = await $.ui.mount(band)
    expect(await ui.find({ key: 'sel-a1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the rack', () => {
  test('orders strips by who needs you next and pulls out the ones that do', async () => {
    const v = {
      now: 0, notes: [], workspaces: [], guard: {}, inspecting: null, briefOpen: false, theme: 'dark' as const, composing: null, setup: [], showDone: false, aside: false, release: null, root: '/p', handles: {}, lanes: {}, traces: {}, at: 0, motion: true,
      agents: [
        agent({ id: 'run', startedAt: 1 }),
        agent({ id: 'done', status: 'completed', endedAt: 5 }),
        agent({ id: 'asks', startedAt: 2 }),
      ],
      inbox: [{ id: 'm', agentId: 'asks', text: 'Ready to merge?', at: 3 }],
    } satisfies View
    expect(rack(v).map(s => [s.agent.id, s.cocked])).toEqual([['asks', true], ['run', false], ['done', false]])
  })
})

describe('what REDhelm brings to Claude Code', () => {
  /** Lets work REDhelm started without awaiting (its start-up, a pressed button) finish. */
  const settle = () => new Promise<void>(r => setTimeout(() => r(), 40))

  const ROWS: any[] = [
    { key: 'switchModelsOnFlag', label: 'x', kind: 'choice', value: 'Switch automatically', options: ['Switch automatically', 'Ask each time'], isLocked: false },
    { key: 'turnDuration', label: 'x', kind: 'boolean', value: false, isLocked: false },
    { key: 'timestamps', label: 'x', kind: 'boolean', value: true, isLocked: false },
    { key: 'inputNeededNotifEnabled', label: 'x', kind: 'boolean', value: false, isLocked: true },
  ]

  test('the setup card offers only what differs and is not locked, and Apply writes it', async ($: any, on: any) => {
    const written: Record<string, unknown> = {}
    on('config.list', () => ({ value: ROWS }))
    on('config.set', (_: any, e: any) => ((written[e.key] = e.value), { value: e.value }))
    await engine(on, true)($)
    await settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /Finish setting up REDhelm/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Timestamp every message/ })).toBeUndefined() // already on
    expect(await ui.find({ type: 'Text', text: /phone/ })).toBeUndefined() // locked by policy
    await ui.press({ key: 'setup-apply' })
    await settle()
    expect(written).toEqual({ switchModelsOnFlag: 'Ask each time', turnDuration: true })
    expect(await ui.find({ type: 'Text', text: /Finish setting up REDhelm/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a model switch REDhelm did not see you choose holds prompts and tools until /model', async ($: any, on: any) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    const sw = (source: string, to: string) =>
      ($ as any).classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: to, requested_model: null, source })

    await sw('auto', 'claude-opus-4-8')
    expect((await $.prompt.submit({ text: 'go on' } as any)).drop).toMatch(/switched models on its own/)
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)).deny).toMatch(/held/)

    await sw('picker', 'claude-fable-5-1')
    expect((await $.prompt.submit({ text: 'go on' } as any)).text).toBe('go on')
  })

  test('a session behind the saved default is stopped once, then lets you continue', async ($: any, on: any) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: { model: 'claude-opus-6' } }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await ($ as any).classic.PostModelSwitch({ from_model: 'claude-opus-5', to_model: 'claude-opus-5-5', requested_model: null, source: 'resume' })
    expect((await $.prompt.submit({ text: 'next' } as any)).drop).toMatch(/default is now Opus 6/)
    expect((await $.prompt.submit({ text: 'next' } as any)).text).toBe('next')
  })
})

describe('your REDhelm settings', () => {
  test('missing or unknown values fall back to the defaults', async () => {
    expect(settings()).toEqual({ placement: 'right', statusLine: 'off', guard: 'hold', notifyAfter: 120, autoOpen: true, agentToasts: true, motion: 'on', labels: 'haiku', backdrop: 'ripples' })
    expect(settings({ motion: 'off', labels: 'plain' })).toMatchObject({ motion: 'off', labels: 'plain' })
    expect(settings({ placement: 'left', notifyAfter: -5, autoOpen: false })).toMatchObject({ placement: 'right', notifyAfter: 120, autoOpen: false })
  })

  test('guard "warn" reports a silent switch but never holds your prompt', { options: { guard: 'warn' } } as any, async ($: any, on: any) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await $.classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: 'claude-opus-4-8', requested_model: null, source: 'auto' })
    expect((await $.prompt.submit({ text: 'go on' })).text).toBe('go on')
  })

  test("setup ships REDhelm's status lines into settings.json and keeps the rest of the file", async ($: any, on: any) => {
    const writes: Record<string, string> = {}
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: { statusLine: { type: 'command', command: 'old-line' } } }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'Python 3', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('env.get', () => ({ value: '/h' }))
    on('fs.exists', (_: any, e: any) => ({ value: !e.path.startsWith('/h/.claude/redhelm/') }))
    on('fs.read', (_: any, e: any) => ({ value: e.path.endsWith('.py') ? `# ${e.path.split('/').pop()}` : '{"theme":"dark","statusLine":{"type":"command","command":"old-line"}}' }))
    on('fs.write', (_: any, e: any) => ((writes[e.path] = e.text), { value: undefined }))
    await engine(on, true)($)
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(writes['/h/.claude/settings.json']).toBeUndefined() // a line of your own is left alone
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /under the prompt \(replaces your current one\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /agent panel/ })).toBeDefined()
    await ui.press({ key: 'setup-apply' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    const json = JSON.parse(writes['/h/.claude/settings.json']!)
    expect(json.theme).toBe('dark')
    // They run from copies beside REDhelm's state, which an update does not move.
    expect(json.statusLine.command).toBe('python3 "/h/.claude/redhelm/statusline/statusline.py"')
    expect(json.subagentStatusLine.command).toBe('python3 "/h/.claude/redhelm/statusline/agents.py"')
    expect(writes['/h/.claude/redhelm/statusline/common.py']).toBe('# common.py')
    await ui.unmount()
  })

  test('a status line an earlier REDhelm left in the versioned plugin folder moves to the kept copies', async ($: any, on: any) => {
    const writes: Record<string, string> = {}
    const old = 'python3 "/h/.claude/plugins/cache/redhelm/redhelm/0.7.1/statusline/statusline.py"'
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    on('env.get', () => ({ value: '/h' }))
    on('fs.exists', (_: any, e: any) => ({ value: e.path === '/h/.claude/settings.json' }))
    on('fs.read', (_: any, e: any) => ({ value: e.path.endsWith('.py') ? `# ${e.path.split('/').pop()}` : JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: old } }) }))
    on('fs.write', (_: any, e: any) => ((writes[e.path] = e.text), { value: undefined }))
    await engine(on, true)($)
    await new Promise<void>(r => setTimeout(() => r(), 40))
    const json = JSON.parse(writes['/h/.claude/settings.json']!)
    expect(json).toEqual({ theme: 'dark', statusLine: { type: 'command', command: 'python3 "/h/.claude/redhelm/statusline/statusline.py"' } })
    expect(Object.keys(writes).filter(k => k.endsWith('.py')).sort()).toEqual(['agents.py', 'common.py', 'statusline.py'].map(n => `/h/.claude/redhelm/statusline/${n}`))
  })
})

describe('the bottom bar', () => {
  test('long workspace names shorten to their first words', async () => {
    expect(shortName('Demo app (web folder) — beta')).toBe('Demo app')
    expect(shortName('Game')).toBe('Game')
  })

  test('each workspace reads as a few words', async () => {
    expect(summary({ dir: '/p/game', name: 'Game', lanes: [{ id: 'api', title: 'API', done: 1, total: 2 }] })).toBe('Game 1 of 2 done')
    expect(summary({
      dir: '/p/app', name: 'Demo app (web) — beta',
      board: { stages: ['Done'], rows: [{ id: 'P1', stages: {}, note: '', at: 0 }], total: 4 },
      runs: [{ name: 'demo-run', status: 'ACTIVE', open: 2 }],
    })).toBe('Demo app 1 task open · demo-run active')
  })
})

describe('messaging an agent', () => {
  test('a prompt addressed "→ name: …" goes to that agent, not to Claude', async ($: any, on: any) => {
    const sent: any[] = []
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const r = await $.prompt.submit({ text: '→ docs: please also cover Windows' })
    expect(sent.map(e => [e.to, e.text])).toEqual([['a1', 'From the user (via REDhelm): please also cover Windows']])
    expect(r.drop).toMatch(/→ docs: sent/)
    expect((await $.prompt.submit({ text: 'an ordinary prompt' })).text).toBe('an ordinary prompt')
  })

  test('once sent, the prompt is empty again: Claude Code keeps the text of a prompt a hook took', async ($: any, on: any) => {
    let box = ''
    on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
    on('prompt.fill', (_: any, e: any) => ((box = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', () => ({ isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    box = '→ docs: please also cover Windows'
    await $.prompt.submit({ text: box })
    await clock.advance(200)
    expect(box).toBe('')
  })

  test('Message puts the address in your prompt, where your keyboard already is', async ($: any, on: any) => {
    let filled = ''
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', (_: any, e: any) => ((filled = e.text), { isFilled: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(filled).toBe('→ docs: ')
    await ui.unmount()
  })

  test('an agent named only by a description with a colon still gets its message (the address round-trips)', async ($: any, on: any) => {
    let filled = ''
    const sent: any[] = []
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', (_: any, e: any) => ((filled = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'echo: test target for REDhelm Message', subagentType: 'general-purpose' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    await ui.unmount()
    const r = await $.prompt.submit({ text: `${filled}Hi` })
    expect(sent.map(e => [e.to, e.text])).toEqual([['a1', 'From the user (via REDhelm): Hi']])
    expect(r.drop).toMatch(/sent/)
  })

  test('an agent that asks you gets a card, and Reply says where to type instead of staying a button', async ($: any, on: any) => {
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', () => ({ isFilled: true }))
    on('session.send', () => ({ isDelivered: true }))
    on('agent.list', () => ({ value: [] }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    await $.session.send({ to: 'lead', text: 'Ready to merge?', agentId: 'a1' })
    await clock.advance(100) // REDhelm reads whether it is a question
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('Docs')
    expect(await ui.find({ key: 'ask-a1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Ready to merge\?/ })).toBeDefined()
    await ui.press({ key: 'compose-a1' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(await ui.find({ type: 'Text', text: /Writing to Docs/ })).toBeDefined()
    expect(await ui.find({ key: 'cancel-compose' })).toBeDefined()
    expect(await ui.find({ key: 'compose-a1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('what REDhelm chooses to show', () => {
  const base = { now: 0, notes: [], inbox: [], guard: {}, inspecting: null, briefOpen: false, theme: 'dark' as const, composing: null, setup: [], showDone: false, aside: false, release: null, handles: {}, lanes: {}, traces: {}, at: 0, motion: true }

  test("only this session's workflows, or ones an agent here is changing; finished runs stay quiet", async () => {
    const ws = (dir: string, extra: object) => ({ dir, name: dir.split('/').pop()!, ...extra })
    const v = {
      ...base, root: '/p/app',
      agents: [agent({ files: ['/p/lib/util.ts'] })],
      workspaces: [
        ws('/p/app', { board: { stages: ['Done'], rows: [{ id: 'T1', stages: {}, note: '', at: 0 }], total: 3 } }), // here
        ws('/p/lib', { runs: [{ name: 'lib-run', status: 'ACTIVE', open: 1 }] }),                                    // an agent edits it
        ws('/p/other', { runs: [{ name: 'other-run', status: 'ACTIVE', open: 1 }] }),                                // just nearby
        ws('/p', { runs: [{ name: 'old-run', status: 'COMPLETED', open: 0 }] }),                                     // above, but finished
      ],
    } satisfies View
    expect(relevant(v).map(w => w.name)).toEqual(['app', 'lib'])
  })

  test('agents with no name or task get a unique name that is also their address', async () => {
    const one = agent({ id: 'a1697d99', name: '', description: '' })
    const two = agent({ id: 'a9b6863a', name: '', description: '' })
    expect([label(one, {}), label(two, {})]).toEqual(['Agent a169', 'Agent a9b6'])
    expect([handleOf(one), handleOf(two)]).toEqual(['agent a169', 'agent a9b6'])
  })
})

describe('your draft is never sent to an agent', () => {
  test('Message sets an existing draft aside and puts it back after the agent message is sent', async ($: any, on: any) => {
    let box = 'a note I was writing to Claude'
    const sent: any[] = []
    on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
    on('prompt.fill', (_: any, e: any) => ((box = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(box).toBe('→ docs: ')
    await $.prompt.submit({ text: `${box}please also cover Windows` })
    await clock.advance(200)
    expect(sent.map(e => e.text)).toEqual(['From the user (via REDhelm): please also cover Windows'])
    expect(box).toBe('a note I was writing to Claude')
    await ui.unmount()
  })

  test("a question's card says it in a line and when it asked; its sheet has the whole question and the steps", async ($: any, on: any) => {
    on('session.send', () => ({ isDelivered: true }))
    on('agent.list', () => ({ value: [] }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Choose colors for the settings page', subagentType: 'general-purpose', name: 'asker' })
    await $.tool.call({ tool: 'Edit', file_path: 'src/Button.tsx', old_string: 'a', new_string: 'b', agentId: 'a1' })
    await $.session.send({ to: 'lead', text: 'The palette is drafted in Button.tsx. Should I use blue or green for the save button? Both pass contrast.', agentId: 'a1' })
    await clock.advance(100) // REDhelm reads whether it is a question
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'ask-a1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Should I use blue or green for the save button\?$/ })).toBeDefined() // the question, not the preamble
    expect(await ui.find({ type: 'Text', text: /palette is drafted/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^ Asks you $/ })).toBeDefined() // amber, beside the name
    expect(await ui.find({ type: 'Text', text: /^now$/ })).toBeDefined()
    const sheet = await openSheet($, ui, 'a1')
    expect(await sheet.find({ type: 'Text', text: /Edit Button\.tsx/ })).toBeDefined() // its recent steps
    expect(await sheet.find({ type: 'Text', text: /palette is drafted in Button\.tsx\. Should I use blue or green/ })).toBeDefined() // all of it
    await sheet.unmount()
    await ui.unmount()
  })
})

describe('two agents with the same name', () => {
  test('get distinct addresses, and Reply goes to the agent whose card you pressed', async ($: any, on: any) => {
    let box = ''
    const sent: any[] = []
    on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
    on('prompt.fill', (_: any, e: any) => ((box = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    on('session.send', (_: any, e: any) => (sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'asker', subagentType: 'general-purpose', name: 'asker' })
    await $.agent.spawn({ prompt: 'x', description: 'asker', subagentType: 'general-purpose', name: 'asker' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a2')
    await sheet.press({ key: 'compose-a2' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(box).toBe('→ asker a2: ')
    await $.prompt.submit({ text: `${box}yes` })
    expect(sent.map(e => [e.to, e.text])).toEqual([['a2', 'From the user (via REDhelm): yes']])
    await ui.unmount()
  })
})

describe('waiting is not the same as waiting for you', () => {
  test('an agent that messaged another agent reads "Waiting for <that agent>", with no card for you', async ($: any, on: any) => {
    on('session.send', () => ({ isDelivered: true }))
    on('agent.list', () => ({ value: [{ id: 'a1', name: 'echo', description: 'echo', type: 'general-purpose', status: 'running' }] }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'echo', subagentType: 'general-purpose', name: 'echo' })
    await $.agent.spawn({ prompt: 'x', description: 'asker', subagentType: 'general-purpose', name: 'asker' })
    await $.session.send({ to: 'echo', text: 'are you done?', agentId: 'a2' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^Waiting for Echo$/ })).toBeDefined()
    expect(await ui.find({ key: 'ask-a2' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('saying what an agent is doing, truthfully', () => {
  test('an agent with no action for 15 minutes reads as quiet, not as still doing its last thing', async () => {
    const now = 10 * 3600_000
    const busy = agent({ activity: 'Read a.ts', steps: [{ text: 'Read a.ts', at: now - 60_000 }] })
    const quiet = agent({ activity: 'Read a.ts', steps: [{ text: 'Read a.ts', at: now - 3 * 3600_000 }] })
    expect([stateOf(busy, now), plainHeadline(busy, now)]).toEqual(['working', 'Read a.ts'])
    expect([stateOf(quiet, now), plainHeadline(quiet, now)]).toEqual(['quiet', 'No action for 3h'])
  })

  test('each state has its own words, and a question outranks the rest', async () => {
    expect(plainHeadline(agent({ waitingOn: 'echo' }), 0)).toBe('Waiting for Echo')
    expect(plainHeadline(agent({ status: 'waiting' }), 0)).toBe('Waiting on work it started')
    expect(plainHeadline(agent({}), 0)).toBe('Getting started')
    expect(plainHeadline(agent({ status: 'completed', answer: 'Wrote the guide' }), 0)).toBe('Wrote the guide')
    expect(plainHeadline(agent({ status: 'killed' }), 0)).toBe('Stopped')
    expect(stateOf(agent({ status: 'failed' }), 0)).toBe('failed')
    expect(stateOf(agent({ status: 'running' }), 0, true)).toBe('asks')
  })

  test('times read in a five-character column', () => {
    expect([age(0), age(12_000), age(3 * 60_000 + 5_000), age(2 * 3_600_000), age(3 * 86_400_000)]).toEqual(['now', '12s', '3m', '2h', '3d'])
  })

  test("a question's line is its first sentence that asks", () => {
    expect(firstAsk('The diff is written. Should I forward it? It is small.')).toBe('Should I forward it?')
    expect(firstAsk('Approve the migration before I run it')).toBe('Approve the migration before I run it')
  })
})

describe('names stay plain unless two live agents share one', () => {
  test('a live agent keeps its plain name; finished namesakes get the tag', async () => {
    const live = agent({ id: 'ac82ffff', name: 'asker', status: 'running' })
    const old1 = agent({ id: 'a4dfeeee', name: 'asker', status: 'completed' })
    const old2 = agent({ id: 'aee7dddd', name: 'asker', status: 'completed' })
    expect(handles([old1, live, old2])).toEqual({ ac82ffff: 'asker', a4dfeeee: 'asker a4df', aee7dddd: 'asker aee7' })
    const twin = agent({ id: 'a9b6aaaa', name: 'asker', status: 'running' })
    expect(handles([live, twin])).toEqual({ ac82ffff: 'asker ac82', a9b6aaaa: 'asker a9b6' })
  })
})

describe('agents Claude Code no longer lists', () => {
  test('stop showing as running once they drop off the list (no ghosts)', async ($: any, on: any) => {
    on('agent.list', () => ({ value: [] })) // Claude Code has dropped the agent
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    await clock.advance(60_000) // REDhelm checks the list every 1.5 s
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^Finished · 1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▶ \d+$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a question the main Claude answers stops asking for you', async ($: any, on: any) => {
    const docs = { id: 'a1', name: 'docs', description: 'Rewrite the setup guide', type: 'general-purpose', status: 'running' }
    const api = { id: 'a2', name: 'api', description: 'Fix the API tests', type: 'general-purpose', status: 'running' }
    on('agent.list', () => ({ value: [docs, api] }))
    on('session.send', () => ({ isDelivered: true }))
    await engine(on, true)($)
    await clock.advance(3_000) // REDhelm reads the list
    await $.session.send({ to: 'lead', text: 'Blue or green for the save button?', agentId: 'a1' })
    await $.session.send({ to: 'lead', text: 'Which test runner?', agentId: 'a2' })
    await clock.advance(100) // REDhelm reads whether it is a question
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ 2$/ })).toBeDefined()
    await ui.unmount()
    await $.session.send({ to: 'docs', text: 'Green, to match the brand' }) // the main conversation, by name
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ 1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Blue or green/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Which test runner/ })).toBeDefined()
    await ui.unmount()
    await $.session.send({ to: 'a2', text: 'Use the one in package.json' }) // and by id
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ \d+$/ })).toBeUndefined()
    await ui.unmount()
  })

  test("an ended agent's question stays a while, then goes; Dismiss clears it sooner", async ($: any, on: any) => {
    let listed: any[] = [{ id: 'a1', name: 'docs', description: 'Rewrite the setup guide', type: 'general-purpose', status: 'running' }]
    on('agent.list', () => ({ value: listed }))
    on('session.send', () => ({ isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    await $.session.send({ to: 'lead', text: 'The schema diff is written. Should I forward it?', agentId: 'a1' })
    await clock.advance(100) // REDhelm reads whether it is a question
    listed = [] // finished and dropped from the list: a reply still resumes it
    await clock.advance(60_000)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ 1$/ })).toBeDefined()
    expect(await ui.find({ key: 'dismiss-a1' })).toBeDefined() // ended: Dismiss where Stop was
    expect(await ui.find({ key: 'stop-a1' })).toBeUndefined()
    await ui.unmount()
    await clock.advance(30 * 60_000) // long after it ended, the question has gone stale
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ \d+$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Finished · 1$/ })).toBeDefined()
    await ui.unmount()
  })

  test('Dismiss puts away the question of an agent that has ended', async ($: any, on: any) => {
    let listed: any[] = [{ id: 'a1', name: 'docs', description: 'Rewrite the setup guide', type: 'general-purpose', status: 'running' }]
    on('agent.list', () => ({ value: listed }))
    on('session.send', () => ({ isDelivered: true }))
    await engine(on, true)($)
    await $.session.send({ to: 'lead', text: 'Should I forward the diff?', agentId: 'a1' })
    await clock.advance(100)
    listed = [{ ...listed[0], status: 'completed' }]
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'dismiss-a1' })
    await clock.advance(100)
    expect(await ui.find({ type: 'Text', text: /^⚑ \d+$/ })).toBeUndefined()
    await ui.unmount()
  })
})


describe('agents that started before REDhelm', () => {
  test('their sheet is filled from what Claude Code kept of their conversation', async ($: any, on: any) => {
    on('agent.list', () => ({ value: [{ id: 'a9', name: 'review', description: 'Review the parser', type: 'general-purpose', status: 'running' }] }))
    on('session.messages', (_$: any, e: any) => ({
      value: e.agentId === 'a9'
        ? [
            { role: 'user', text: 'Check the parser for off-by-one errors', toolUses: [] },
            { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/p/src/parser.ts' } }] },
            { role: 'assistant', text: 'The loop bound looks wrong', toolUses: [{ tool_use_id: 't2', tool: 'Edit', input: { file_path: '/p/src/parser.ts' } }] },
          ]
        : { deny: 'not an agent' },
    }))
    await engine(on, true)($)
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a9')
    expect(await sheet.find({ type: 'Text', text: /off-by-one/ })).toBeDefined()
    expect(await sheet.find({ type: 'Text', text: /Edit parser\.ts/ })).toBeDefined()
    expect(await sheet.find({ type: 'Text', text: /loop bound/ })).toBeDefined()
    expect(await sheet.find({ type: 'Text', text: /parser\.ts$/ })).toBeDefined() // Changed
    await sheet.unmount()
    await ui.unmount()
  })

  test('with no record to read, the sheet says so instead of showing empty fields', async ($: any, on: any) => {
    on('agent.list', () => ({ value: [{ id: 'a8', type: 'general-purpose', description: '', status: 'running' }] }))
    on('session.messages', () => ({ value: { deny: 'no transcript' } }))
    await engine(on, true)($)
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a8')
    expect(await sheet.find({ type: 'Text', text: /started before REDhelm/ })).toBeDefined()
    await sheet.unmount()
    await ui.unmount()
  })
})

describe("Claude Code's own background work", () => {
  test('a fork of the session no list names (compaction, memory) gets no row, however much it does', async ($: any, on: any) => {
    const toasts: string[] = []
    on('agent.list', () => ({ value: [] }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
    await engine(on, true)($)
    await $.tool.call({ tool: 'Read', file_path: 'notes.md', agentId: 'fork1' } as any)
    await $.turn.complete({ answer: 'No-op placeholder', durationMs: 900, isAborted: false, turnId: 't1', agentId: 'fork1', reason: 'answer' })
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'sel-fork1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Agent fork/ })).toBeUndefined()
    expect(toasts).toEqual([])
    await ui.unmount()
  })
})

describe('an agent still waiting on work it started', () => {
  test('is not called finished until Claude Code says it ended', async ($: any, on: any) => {
    let status = 'waiting'
    const toasts: string[] = []
    on('agent.list', () => ({ value: [{ id: 'a1', name: 'probe', description: 'probe', type: 'general-purpose', status }] }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'probe', subagentType: 'general-purpose', name: 'probe' })
    await $.turn.complete({ answer: 'Read the files; one wait still running', durationMs: 9000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^Waiting on work it started$/ })).toBeDefined()
    expect(toasts.some(t => /finished/.test(t))).toBe(false)
    status = 'completed'
    await clock.advance(3_000)
    expect(toasts.filter(t => /probe finished/.test(t))).toHaveLength(1)
    await ui.unmount()
  })
})

describe('the sheet reads cleanly', () => {
  test('repeated steps fold into one line with a count', () => {
    const steps = [{ text: 'Edit review.md', at: 5 }, { text: 'Edit review.md', at: 4 }, { text: 'Edit review.md', at: 3 }, { text: 'Read List.tsx', at: 2 }]
    expect(grouped(steps)).toEqual([{ text: 'Edit review.md', at: 5, count: 3 }, { text: 'Read List.tsx', at: 2, count: 1 }])
  })

  test('paths in what agents say lose the project folder and the home folder', () => {
    expect(tidyPaths('I rewrote /home/sam/notes-app/docs/setup.md and /home/sam/.config/x', '/home/sam/notes-app', '/home/sam'))
      .toBe('I rewrote docs/setup.md and ~/.config/x')
  })

  test('a finished agent shows its last words once, not again as thinking', async ($: any, on: any) => {
    let status = 'running'
    on('agent.list', () => ({ value: [{ id: 'a7', name: 'review', description: 'Review the UI', type: 'general-purpose', status }] }))
    on('session.messages', () => ({ value: [
      { role: 'user', text: 'Review the UI', toolUses: [] },
      { role: 'assistant', text: 'I wrote the review with six findings', toolUses: [] },
    ] }))
    on('turn.complete', () => ({ text: '' }))
    await engine(on, true)($)
    await clock.advance(3_000) // read back: thinking = its latest words
    status = 'completed'
    await $.turn.complete({ answer: 'I wrote the review with six findings', durationMs: 9000, isAborted: false, turnId: 't1', agentId: 'a7', reason: 'answer' })
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'toggle-done' })
    const sheet = await openSheet($, ui, 'a7')
    expect(await sheet.find({ type: 'Text', text: /Last said/ })).toBeDefined()
    expect(await sheet.find({ type: 'Text', text: /Thinking/ })).toBeUndefined()
    await sheet.unmount()
    await ui.unmount()
  })
})

describe('changing your mind after Reply or Message', () => {
  const setup = async ($: any, on: any, draft: string) => {
    const state = { box: draft, sent: [] as any[] }
    on('prompt.read', () => ({ value: { text: state.box, cursor: state.box.length } }))
    on('prompt.fill', (_: any, e: any) => ((state.box = e.text), { isFilled: true }))
    on('session.send', (_: any, e: any) => (state.sent.push(e), { isDelivered: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    return { state, ui }
  }

  test('REDhelm says who you are writing to, with a Cancel that brings your draft back', async ($: any, on: any) => {
    const { state, ui } = await setup($, on, 'a note I was writing to Claude')
    expect(state.box).toBe('→ docs: ')
    expect(await ui.find({ type: 'Text', text: /Writing to Docs/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /draft kept/ })).toBeDefined()
    await ui.press({ key: 'cancel-compose' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(state.box).toBe('a note I was writing to Claude')
    expect(await ui.find({ type: 'Text', text: /Writing to/ })).toBeUndefined()
    expect(state.sent).toEqual([])
    await ui.unmount()
  })

  test('with no draft, Cancel leaves an empty prompt', async ($: any, on: any) => {
    const { state, ui } = await setup($, on, '')
    await ui.press({ key: 'cancel-compose' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(state.box).toBe('')
    await ui.unmount()
  })

  test('the bottom layout has the same Cancel', async ($: any, on: any) => {
    const { state, ui } = await setup($, on, 'draft')
    await ui.unmount()
    const wide = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 140 } } as any)
    expect(await wide.find({ type: 'Text', text: /Writing to Docs/ })).toBeDefined()
    await wide.press({ key: 'cancel-compose' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(state.box).toBe('draft')
    await wide.unmount()
  })
})

describe('a reply abandoned by hand', () => {
  test('deleting "→ name:" and sending to Claude ends the reply and brings the draft back', async ($: any, on: any) => {
    let box = 'my draft'
    on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
    on('prompt.fill', (_: any, e: any) => ((box = e.text), { isFilled: true }))
    on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await sheet.unmount()
    await new Promise<void>(r => setTimeout(() => r(), 40))
    await $.prompt.submit({ text: 'a question for Claude instead' })
    await clock.advance(200)
    expect(box).toBe('my draft')
    expect(await ui.find({ type: 'Text', text: /Writing to/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the agent sheet', () => {
  test('opens inside the panel, not as a tab beside it, and Back returns to your agents', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /^▶ 1$/ })).toBeDefined()
    await ui.press({ key: 'sel-a1' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(await ui.find({ type: 'Text', text: /^Task$/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▶ 1$/ })).toBeUndefined() // the sheet, in place of the list and its counts
    await ui.press({ key: 'back' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(await ui.find({ type: 'Text', text: /^▶ 1$/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
  })

  test('Message from the sheet goes back to the panel, where "Writing to" shows', async ($: any, on: any) => {
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', () => ({ isFilled: true }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    expect(await ui.find({ type: 'Text', text: /Writing to Docs/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
  })

  test('from the bar above the prompt, where there is no panel to draw in, it opens as its own pane', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'rewrite', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' } as any)
    await $.command.run({ command: 'redhelm', args: 'bottom', origin: { kind: 'person' }, presentation: {} } as any)
    const band = await $.ui.mount({ plugin: 'redhelm', component: 'AbovePrompt', surface: 'terminal',
      props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120 } } as any)
    await band.press({ key: 'sel-a1' })
    await new Promise<void>(r => setTimeout(() => r(), 40))
    const sheet = await $.ui.mount({ ...SHEET, surface: 'terminal' } as any)
    expect(await sheet.find({ type: 'Text', text: /^Task$/ })).toBeDefined()
    expect(await sheet.find({ type: 'Text', text: /Esc to close/ })).toBeDefined()
    await sheet.unmount()
    await band.unmount()
  })
})

describe('what an agent sends you', () => {
  const docs = { id: 'a1', name: 'docs', description: 'Rewrite the setup guide', type: 'general-purpose', status: 'running' }

  test('a report is not a question: no card, and it shows as what the agent last said', async ($: any, on: any) => {
    on('agent.list', () => ({ value: [docs] }))
    on('session.send', () => ({ isDelivered: true }))
    await engine(on, true)($)
    await clock.advance(3_000)
    await $.session.send({ to: 'lead', text: 'The schema diff is written to docs/schema.md', agentId: 'a1' })
    await clock.advance(100)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ \d+$/ })).toBeUndefined()
    expect(await ui.find({ key: 'ask-a1' })).toBeUndefined()
    const sheet = await openSheet($, ui, 'a1')
    expect(await sheet.find({ type: 'Text', text: /schema diff is written/ })).toBeDefined()
    expect(await sheet.find({ type: 'Text', text: /^asks ·/ })).toBeUndefined()
    await sheet.unmount()
    await ui.unmount()
  })

  test('a request with no question mark still asks you, when the model reads it as one', async ($: any, on: any) => {
    on('agent.list', () => ({ value: [docs] }))
    on('session.send', () => ({ isDelivered: true }))
    on('model.classify', (_$: any, e: any) => ({ value: /approve/i.test(e.text) ? e.labels[0] : e.labels[1] }))
    await engine(on, true)($)
    await clock.advance(3_000)
    await $.session.send({ to: 'lead', text: 'Approve the migration before I run it', agentId: 'a1' })
    await clock.advance(100)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^⚑ 1$/ })).toBeDefined()
    expect(await ui.find({ key: 'ask-a1' })).toBeDefined()
    await ui.unmount()
  })

  test('without the model, a question mark or a plain request still counts; a URL query does not', () => {
    expect(looksLikeQuestion('Should I use blue or green?')).toBe(true)
    expect(looksLikeQuestion('Let me know which runner to use')).toBe(true)
    expect(looksLikeQuestion('Waiting on your approval to merge')).toBe(true)
    expect(looksLikeQuestion('Done: see https://example.com/pr?id=4 for the diff')).toBe(false)
    expect(looksLikeQuestion('Tests pass. `a?.b` is now guarded.')).toBe(false)
    expect(looksLikeQuestion('Task 4 schema diff is written, for forwarding to task 5')).toBe(false)
  })
})

describe('a newer REDhelm', () => {
  const installed = (id: string, version: string) => ({ value: { exitCode: 0, stdout: JSON.stringify([{ id, version, enabled: true }]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const published = (version: string) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: 'redhelm', version }) } })

  test('is offered in one quiet line, and Update runs the plugin update', async ($: any, on: any) => {
    const ran: string[] = []
    on('process.run', (_$: any, e: any) => (ran.push(e.argv.join(' ')), e.argv.includes('list') ? installed('redhelm@redhelm', '0.4.5') : installed('', '')))
    on('http.fetch', () => published('0.5.0'))
    await engine(on, true)($)
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /0\.5\.0 is out/ })).toBeDefined()
    await ui.press({ key: 'update' })
    await clock.advance(100)
    expect(ran).toContain('claude plugin update redhelm@redhelm')
    expect(await ui.find({ type: 'Text', text: /\/reload-plugins/ })).toBeDefined()
    await ui.unmount()
  })

  test('/redhelm update does the same from the keyboard', async ($: any, on: any) => {
    const ran: string[] = []
    on('process.run', (_$: any, e: any) => (ran.push(e.argv.join(' ')), installed('redhelm@redhelm', '0.4.5')))
    on('http.fetch', () => published('0.5.0'))
    await engine(on, true)($)
    await clock.advance(3_000)
    const r = await $.command.run({ command: 'redhelm', args: 'update', origin: { kind: 'person' }, presentation: {} } as any)
    expect(r.text).toMatch(/0\.5\.0/)
    expect(ran).toContain('claude plugin update redhelm@redhelm')
  })

  test('says nothing when REDhelm is up to date', async ($: any, on: any) => {
    on('process.run', () => installed('redhelm@redhelm', '0.4.5'))
    on('http.fetch', () => published('0.4.5'))
    await engine(on, true)($)
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'update' })).toBeUndefined()
    await ui.unmount()
  })

  test('says nothing when REDhelm runs from a local folder, which is its own source', async ($: any, on: any) => {
    on('process.run', () => installed('redhelm@inline', '0.4.5'))
    on('http.fetch', () => published('0.5.0'))
    await engine(on, true)($)
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'update' })).toBeUndefined()
    await ui.unmount()
  })

  test('says nothing when another marketplace, such as the plugin directory, installed it: that one updates it', async ($: any, on: any) => {
    let fetched = 0
    on('process.run', () => installed('redhelm@claude-plugins-official', '0.4.5'))
    on('http.fetch', () => (fetched++, published('0.5.0')))
    await engine(on, true)($)
    await clock.advance(3_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'update' })).toBeUndefined()
    await ui.unmount()
    expect(fetched).toBe(0)
    const r = await $.command.run({ command: 'redhelm', args: 'update', origin: { kind: 'person' }, presentation: {} } as any)
    expect(r.text).toMatch(/comes from claude-plugins-official.*claude plugin update redhelm@claude-plugins-official/)
  })

  test('versions compare by number, not by text', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.4.5', '0.4.5')).toBe(false)
    expect(isNewer('0.4.4', '0.4.5')).toBe(false)
    expect(isNewer('garbage', '0.4.5')).toBe(false)
  })
})


describe('traces', () => {
  test('calls fall into fixed four-second buckets, newest last, and age out after a minute', () => {
    expect(buckets([0, 100, 4500, 19_000], 19_999, 5)).toEqual([2, 1, 0, 0, 1])
    expect(buckets([], 0, 3)).toEqual([0, 0, 0])
    expect(buckets([5000], 4000, 3)).toEqual([0, 0, 0]) // not yet
    expect(record([0, 70_000], 70_500)).toEqual([70_000, 70_500])
  })

  test('speed: output tokens over the seconds they took to stream, pooled over the last minute', () => {
    const two = burst(burst([], { at: 10_000, tokens: 120, ms: 2_000 }), { at: 20_000, tokens: 50, ms: 500 })
    expect(speed(two, 20_000)).toBe(68) // 170 tokens in 2.5 s
    expect(speed(two, 75_000)).toBe(100) // the first has aged out
    expect(speed(two, 81_000)).toBeUndefined() // nothing streamed in the last minute
    expect(burst(two, { at: 79_000, tokens: 1, ms: 1 }).length).toBe(2) // the first has aged out
    expect(speed([{ at: 0, tokens: 3, ms: 20 }], 0)).toBeUndefined() // too quick to time
  })

  test('bars rise from a flat baseline, one bucket a cell', () => {
    expect(bars([0, 0, 1, 4])).toEqual(['▁▁▃█'])
    expect(bars([0, 8], 2)).toEqual([' █', '▁█'])
  })

  test('raster cells are base64 of the code point, colour and background of each cell', () => {
    const b = atob(rasterCells(['▁'], 0x123456))
    const u32 = (i: number) => (b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8) | (b.charCodeAt(i + 2) << 16) | (b.charCodeAt(i + 3) << 24)) >>> 0
    expect([b.length, u32(0), u32(4), u32(8)]).toEqual([12, 0x2581, 0x123456, 0x01000000])
  })
})

describe('colour', () => {
  test("a trace is a comet tail: grey at its oldest, the agent's own colour at its newest", () => {
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080)
    const t = tail(0x4f8ff7, 0x4c4c55, 8)
    expect([t.length, t[7]]).toEqual([8, 0x4f8ff7])
    expect(t[0]).toBe(mix(0x4c4c55, 0x4f8ff7, 0.3))
  })

  test('the spectrum gives each agent its share of the last minute, at least a cell each', () => {
    const now = 100_000
    expect(spectrum({ a: [now - 1000, now - 2000, now - 3000], b: [now - 500], c: [now - 90_000] }, now, 20))
      .toEqual([{ id: 'a', cells: 15 }, { id: 'b', cells: 5 }])
    expect(spectrum({ a: [now - 90_000] }, now, 20)).toEqual([]) // an idle minute: no line
    const many = spectrum({ a: Array(50).fill(now - 1), b: [now - 1], c: [now - 1] }, now, 10)
    expect(many.reduce((s, p) => s + p.cells, 0)).toBe(10)
    expect(many.every(p => p.cells >= 1)).toBe(true)
  })
})

describe('the backdrop', () => {
  /** Cell `i` of Raster cells: its character and colour. */
  const cell = (cells: string, i: number) => {
    const b = atob(cells)
    const u32 = (o: number) => (b.charCodeAt(o) | (b.charCodeAt(o + 1) << 8) | (b.charCodeAt(o + 2) << 16) | (b.charCodeAt(o + 3) << 24)) >>> 0
    return { ch: String.fromCodePoint(u32(i * 12)), fg: u32(i * 12 + 4), bg: u32(i * 12 + 8) }
  }

  test('the lattice is a + every fourth column, every other row, on black', () => {
    const cells = drawBackdrop('lattice', 8, 4, 0, PALETTES.dark)
    expect(atob(cells).length).toBe(8 * 4 * 12)
    expect(cell(cells, 1 * 8 + 2)).toEqual({ ch: '+', fg: PALETTES.dark.lattice, bg: 0 })
    expect(cell(cells, 0).ch).toBe(' ')
    expect(isLattice(6, 3)).toBe(true)
  })

  test("a tool call's ring lights the lattice in its agent's colour as it passes, then is gone", () => {
    const ring = [{ x: 0, y: 1, at: 0, color: 0x4f8ff7 }]
    const lit = drawBackdrop('ripples', 40, 12, 0.3, PALETTES.dark, 0, ring) // radius 6 at 0.3 s
    expect(cell(lit, 1 * 40 + 6).fg).not.toBe(PALETTES.dark.lattice)
    expect(cell(lit, 1 * 40 + 38).fg).toBe(PALETTES.dark.lattice) // not reached yet
    expect(drawBackdrop('ripples', 40, 12, 5, PALETTES.dark, 0, ring)).toBe(drawBackdrop('lattice', 40, 12, 5, PALETTES.dark))
    expect([animates('ripples', ring, 1), animates('ripples', ring, 3), animates('lattice', ring, 1), animates('field', [], 9)]).toEqual([true, false, false, true])
  })

  test('the field and the ember move with time', () => {
    expect(drawBackdrop('field', 30, 10, 0, PALETTES.dark)).not.toBe(drawBackdrop('field', 30, 10, 2, PALETTES.dark))
    expect(drawBackdrop('ember', 30, 10, 0, PALETTES.dark)).not.toBe(drawBackdrop('ember', 30, 10, 2, PALETTES.dark))
  })

  test('the docked sidebar draws it behind everything, the size of the pane, with rows on plates of its colour', async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    await edit($)
    const props = { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props })
    const field = await ui.find({ type: 'Raster', key: 'backdrop' })
    expect([field?.props.columns, field?.props.rows]).toEqual([48, 30])
    expect((await ui.find({ key: 'row-a1' }))?.props.backgroundColor).toBe('#000000') // its plate
    await ui.unmount()
    for (const other of [{ surface: 'desktop', props }, { surface: 'terminal', props: { ...props, placement: 'inline', bodyColumns: 140 } }]) {
      const elsewhere = await $.ui.mount({ ...PANE, ...other })
      expect(await elsewhere.find({ type: 'Raster', key: 'backdrop' })).toBeUndefined()
      await elsewhere.unmount()
    }
  })

  test('an open sheet sits on the backdrop colour, without the pattern', async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    expect(await sheet.find({ type: 'Raster', key: 'backdrop' })).toBeUndefined()
    expect((await sheet.findAll({ type: 'Box' })).some((b: any) => b.props.backgroundColor === '#000000')).toBe(true)
    await sheet.unmount()
    await ui.unmount()
  })

  test("Claude Code's auto theme follows the desktop: macOS's dark key, GNOME's colour scheme, else dark", async () => {
    const answers = (map: Record<string, { exitCode: number; stdout: string } | undefined>) => async (argv: string[]) => map[argv[0]!]
    expect(await appearance(answers({ defaults: { exitCode: 0, stdout: 'Dark\n' } }))).toBe('dark')
    expect(await appearance(answers({ defaults: { exitCode: 1, stdout: '' } }))).toBe('light') // macOS, no dark key
    expect(await appearance(answers({ gsettings: { exitCode: 0, stdout: "'prefer-light'" } }))).toBe('light')
    expect(await appearance(answers({ gsettings: { exitCode: 0, stdout: "'prefer-dark'" } }))).toBe('dark')
    expect(await appearance(answers({}))).toBe('dark')
  })

  test('the light theme draws on near-white, which Claude Code paints (it leaves a Box of pure #ffffff unpainted)', () => {
    expect(PALETTES.light.bg).not.toBe(0xffffff)
    expect(PALETTES.light.bg).toBeGreaterThan(0xf8f8f8)
  })

  test('background: none leaves the pane as it was', { options: { backdrop: 'none' } } as any, async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Raster', key: 'backdrop' })).toBeUndefined()
    expect((await ui.find({ key: 'row-a1' }))?.props.backgroundColor).toBeUndefined()
    await ui.unmount()
  })
})

describe('labels', () => {
  test('a reply becomes a short, clean label, or nothing', () => {
    expect(clean('"Rewriting the setup guide."', 6)).toBe('Rewriting the setup guide')
    expect(clean('Headline: Fixing the flaky auth tests now and later too', 6)).toBe('Fixing the flaky auth tests now')
    expect(clean("I can't help with that.", 6)).toBeUndefined()
    expect(clean('', 6)).toBeUndefined()
    expect(clean('Add a README section?\nMore text', 8, true)).toBe('Add a README section?')
  })

  test('one call per input, one at a time, an agent at most every 45 seconds', async () => {
    const calls: string[] = []
    let release = () => {}
    const slow: Complete = async ask => {
      calls.push(ask.prompt)
      await new Promise<void>(r => (release = r))
      return 'Writing the guide'
    }
    const l = labeler()
    const first = l.ask(slow, 'headline', 'a1', 'x', 0)
    expect(await l.ask(slow, 'headline', 'a2', 'y', 0)).toBeUndefined() // one at a time
    release()
    expect(await first).toBe('Writing the guide')
    expect(await l.ask(slow, 'headline', 'a1', 'x', 1)).toBe('Writing the guide') // the same input: no call
    expect(await l.ask(slow, 'headline', 'a1', 'z', 5_000)).toBeUndefined() // too soon
    expect(calls).toEqual(['x'])
  })

  test('a failed call leaves the plain words and is tried again later', async () => {
    let n = 0
    const flaky: Complete = async () => (++n === 1 ? undefined : 'Running the tests')
    const l = labeler()
    expect(await l.ask(flaky, 'headline', 'a1', 'x', 0)).toBeUndefined()
    expect(await l.ask(flaky, 'headline', 'a1', 'x', 46_000)).toBe('Running the tests')
  })

  test('no more than 30 calls go out in an hour, whatever asks', async () => {
    let calls = 0
    const count: Complete = async () => (calls++, 'Working')
    const l = labeler()
    for (let i = 0; i < 40; i++) await l.ask(count, 'headline', `a${i}`, `input ${i}`, i * 1000)
    expect(calls).toBe(30)
    await l.ask(count, 'headline', 'late', 'later input', 3_601_000) // the first calls have aged out
    expect(calls).toBe(31)
  })
})

describe('the live list', () => {

  test('a working row has its glyph, its trace, a time and, on hover, Message and Stop', async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    await edit($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^▶ 1$/ })).toBeDefined() // the header count
    expect(await ui.find({ type: 'Text', text: /^▶$/ })).toBeDefined() // the row's glyph
    expect((await ui.find({ type: 'Raster', key: 'trace-a1' }))?.props.columns).toBe(8)
    expect(await ui.find({ key: 'compose-a1' })).toBeDefined()
    expect((await ui.findAll({ type: 'Box' })).some((b: any) => b.props.display === 'none')).toBe(true) // revealed by the pointer, no hook
    await ui.unmount()
  })

  test('in a 22-column sidebar the name and time keep their room and the trace halves', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'x', subagentType: 'general-purpose', name: 'a very long agent name indeed' })
    await edit($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 22 } })
    expect((await ui.find({ key: 'sel-a1' }))?.text).toBe('A ver…')
    expect((await ui.find({ type: 'Raster', key: 'trace-a1' }))?.props.columns).toBe(4)
    expect(await ui.find({ type: 'Text', text: /^now$/ })).toBeDefined()
    await ui.unmount()
  })

  test('with motion off, no Raster: the trace is still text', { options: { motion: 'off' } } as any, async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    await edit($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Raster', key: 'trace-a1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^[▁-█]{8}$/ })).toBeDefined()
    await ui.unmount()
  })

  test("each agent shows how fast its tokens arrive beside its trace: in the sidebar, the bar and its sheet", async ($: any, on: any) => {
    const usage = { input_tokens: 10, output_tokens: 140, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
    on('turn.step', async function* (_: any, e: any) {
      yield { kind: 'thinking', index: 0, text: 'Plan' } // thinking tokens count, so its time does too
      await clock.advance(3_000)
      yield { kind: 'text', index: 1, text: 'Done.' }
      yield { kind: 'stop', stopReason: 'end_turn', usage }
      // A second of it the API spent running its own tool: not streaming.
      return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage,
        serverToolUses: [{ id: 's1', name: 'advisor', input: {}, startedAt: 500, endedAt: 1_500 }] }
    })
    await engine(on, true, { shown: true })($)
    await spawn($)
    await edit($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'rate-a1' }))?.text).toBe('–') // nothing streamed yet
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })
    for await (const _ of step) { /* read to the end */ }
    await step.result
    await clock.advance(1_100) // the next tick redraws it
    expect((await ui.find({ key: 'rate-a1' }))?.text).toBe('70 t/s') // 140 tokens in 2 s
    const sheet = await openSheet($, ui, 'a1')
    expect((await sheet.find({ key: 'rate-a1' }))?.text).toBe('70 t/s')
    await sheet.unmount()
    await ui.unmount()
    const bar = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 140 } })
    expect((await bar.find({ key: 'rate-a1' }))?.text).toBe('70 t/s')
    await bar.unmount()
  })

  test('while shown, a moving trace is repainted in place between redraws, and a finished agent is not', async ($: any, on: any) => {
    const blits: string[] = []
    let status = 'running'
    on('ui.blit', (_$: any, e: any) => (blits.push(e.key), { value: {} }))
    on('agent.list', () => ({ value: [{ id: 'a1', name: 'docs', description: 'Rewrite the setup guide', type: 'general-purpose', status }] }))
    on('turn.complete', () => ({ text: '' }))
    await engine(on, true, { shown: true })($)
    await spawn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clock.advance(61_100) // on screen, and past its first minute: times change once a minute now
    await edit($)
    await clock.advance(4_100) // the trace scrolls a bucket, between redraws
    expect(blits).toContain('trace-a1')
    status = 'completed'
    await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    await clock.advance(300)
    const after = blits.length
    await clock.advance(4_000)
    expect(blits.length).toBe(after) // finished: no trace drawn, nothing repainted
    await ui.unmount()
  })
})

describe('labels from the small model', () => {
  const docs = { id: 'a1', name: 'docs', description: 'Rewrite the setup guide', type: 'general-purpose', status: 'running' }
  const answer = (text: string) => ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })

  test("while REDhelm is on screen, Haiku writes a working agent's headline and a question's title", async ($: any, on: any) => {
    const asked: any[] = []
    on('agent.list', () => ({ value: [docs] }))
    on('session.send', () => ({ isDelivered: true }))
    on('model.complete', (_$: any, e: any) => (asked.push(e), answer(/question/.test(e.system) ? '"Use blue or green?"' : 'Rewriting the setup guide.')))
    await engine(on, true, { shown: true })($)
    await spawn($)
    await edit($)
    await $.session.send({ to: 'lead', text: 'The palette is ready. Should I use blue or green for the save button?', agentId: 'a1' })
    await clock.advance(100)
    await clock.advance(1_000)
    await clock.advance(1_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^Use blue or green\?$/ })).toBeDefined()
    expect(asked.every(e => e.model === 'haiku' && e.effort === 'low' && e.maxTokens === 30 && e.timeoutMs === 6000)).toBe(true)
    await ui.unmount()
    await $.session.send({ to: 'docs', text: 'Blue' }) // answered: the agent is at work again
    await clock.advance(1_000)
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await again.find({ type: 'Text', text: /^Rewriting the setup guide$/ })).toBeDefined()
    await again.unmount()
  })

  test('a headline holds while the work is the same, even if the model would word it differently each time', async ($: any, on: any) => {
    let calls = 0
    on('agent.list', () => ({ value: [docs] }))
    on('model.complete', () => (calls++, answer(calls % 2 ? 'Rewriting the setup guide' : 'Updating the setup docs')))
    await engine(on, true, { shown: true })($)
    await spawn($)
    await edit($)
    await clock.advance(2_000)
    const headline = async () => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).find((t: string) => /setup (guide|docs)/.test(t))
      await ui.unmount()
      return text
    }
    expect(await headline()).toBe('Rewriting the setup guide')
    await clock.advance(120_000) // the same steps: no new call, the same words
    expect([calls, await headline()]).toEqual([1, 'Rewriting the setup guide'])
    await edit($) // new work, long enough after: one new headline
    await clock.advance(2_000)
    expect([calls, await headline()]).toEqual([2, 'Updating the setup docs'])
    await edit($) // new work again, too soon: it waits
    await clock.advance(10_000)
    expect([calls, await headline()]).toEqual([2, 'Updating the setup docs'])
  })

  test('labels: plain never calls the model', { options: { labels: 'plain' } } as any, async ($: any, on: any) => {
    let calls = 0
    on('model.complete', () => (calls++, answer('x')))
    await engine(on, true, { shown: true })($)
    await spawn($)
    await edit($)
    await clock.advance(3_000)
    expect(calls).toBe(0)
  })

  test('nothing is asked while REDhelm is off screen', async ($: any, on: any) => {
    let calls = 0
    on('model.complete', () => (calls++, answer('x')))
    await engine(on, true)($)
    await spawn($)
    await edit($)
    await clock.advance(3_000)
    expect(calls).toBe(0)
  })
})

/**
 * A plugin beside REDhelm that hands a test REDhelm's agent records: a test's own `$` has no `$.state`,
 * and the host lets a hook read state only from a scanned hooks module, which the test's `on` is not.
 */
const RECORDS = {
  name: 'records',
  register(on: any) {
    on('tool.call', async ($: any, e: any, next: any) =>
      e.tool === 'RedhelmRecords' ? { result: (await $.state.get({ plugin: 'redhelm', key: 'agents' })).value } : next(e))
  },
}

describe('workflow records', () => {
  const agents = async ($: any) => (await $.tool.call({ tool: 'RedhelmRecords' } as any)).result
  test('an agent of a built-in workflow run is still working past the 20-second grace', { plugins: [RECORDS] }, async ($: any, on: any) => {
    on('agent.list', () => ({ value: [] })) // Claude Code's list never names a run's agents
    on('turn.complete', () => ({ text: '' }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Probe the parser', subagentType: 'general-purpose', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
    await clock.advance(25_000)
    expect((await agents($)).a1.status).toBe('running')
    expect((await agents($)).a1.run).toBe('wf_1')
    await $.turn.complete({ answer: 'done', durationMs: 9000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    expect((await agents($)).a1.status).toBe('completed')
  })
  test('tools are counted per agent, MCP tools by server, skills once each in order', { plugins: [RECORDS] }, async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    for (const call of [{ tool: 'Read', file_path: 'a' }, { tool: 'Read', file_path: 'b' }, { tool: 'mcp__notes__search', q: 'x' },
      { tool: 'Skill', skill: 'tdd' }, { tool: 'Skill', skill: 'tdd' }, { tool: 'Skill', skill: 'brainstorming' }])
      await $.tool.call({ ...call, agentId: 'a1' } as any)
    const a = (await agents($)).a1
    expect(a.tools).toEqual({ Read: 2, 'mcp:notes': 1, Skill: 3 })
    expect(a.skills).toEqual(['tdd', 'brainstorming'])
  })
  test('a spawn records its parent, whether it is a teammate and where its type comes from', { plugins: [RECORDS] }, async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Scout', subagentType: 'Explore', parentAgentId: 'lead1', isTeammate: true, provider: { plugin: 'project', tier: 'user' } } as any)
    expect((await agents($)).a1).toMatchObject({ parent: 'lead1', teammate: true, origin: 'project' })
  })
})

const you = (text: string): Msg => ({ role: 'user', text, toolUses: [] })
const lead = (...toolUses: any[]): Msg => ({ role: 'assistant', text: '', toolUses })
const call = (agentId: string, input: Record<string, unknown> = {}) =>
  ({ tool: 'Agent', agentId, input: { description: 'Write the docs', prompt: 'Write docs/api.md', subagent_type: 'general-purpose', ...input } })
const skill = (name: string) => ({ tool: 'Skill', input: { skill: name } })
// Shapes seen in Task 1 (findings 1 and 2).
const notice = (text: string): Msg => ({ role: 'user', text: `<task-notification> <task-id>a1</task-id> ${text} </task-notification>`, toolUses: [] })
const slash = (name: string): Msg => ({ role: 'user', text: `<command-message>${name}</command-message> <command-name>/${name}</command-name>`, toolUses: [] })
const result = (): Msg => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'Async agent launched successfully.' }] })

describe('reading a session', () => {
  test('stretches split at your prompts that started agents; a skill that led keeps the rest whole', () => {
    const msgs = [you('Write the docs'), lead(call('a1')), you('thanks'), you('Now test it'), lead(call('a2', { description: 'Add tests' }))]
    expect(stretches(msgs)).toEqual([{ from: 0, to: 3, led: false }, { from: 3, to: 5, led: false }])
    expect(widen(stretches(msgs), 1)).toEqual({ from: 0, to: 5, led: false })
    const led = [you('Plan the build'), lead(skill('redmanager')), lead(call('a1')), you('go on'), lead(call('a2'))]
    expect(stretches(led)).toEqual([{ from: 0, to: 5, led: true }])
  })
  test('a skill loaded in your prompts before the agents leads from the prompt before the load', () => {
    const msgs = [you('Build the store'), lead(call('a1')), slash('redmanager'), lead(), you('approved'), lead(call('a2', { description: 'Add tests' }))]
    expect(stretches(msgs)).toEqual([{ from: 0, to: 2, led: false }, { from: 2, to: 6, led: true }])
    expect(defaultForm(msgs, stretches(msgs)[1]!)).toBe('roles')
  })
  test('notifications are not your prompts', () => {
    expect(isPrompt(notice('agent a1 finished'))).toBe(false)
    expect(isPrompt(result())).toBe(false)
    expect(isPrompt(you('[Request interrupted by user]'))).toBe(false)
    expect(isPrompt(slash('probe-skill'))).toBe(true)
    expect(isPrompt(you('hi'))).toBe(true)
    expect(stretches([you('go'), lead(call('a1', { run_in_background: true })), notice('done'), lead(call('a2'))])).toHaveLength(1)
  })
  test('lead skills come from the Skill tool and from / commands, once each, in order', () => {
    const msgs = [slash('redmanager'), lead(skill('brainstorming'), skill('redmanager')), lead(call('a1'))]
    expect(leadSkills(msgs, { from: 0, to: 3, led: true })).toEqual(['redmanager', 'brainstorming'])
    // A / command the model never answered (a built-in like /effort) is not a skill.
    expect(leadSkills([slash('effort'), you('go'), lead(call('a1'))], { from: 0, to: 3, led: false })).toEqual([])
  })
  test('one lead message is a run of assistant messages; a tool result between two calls splits it', () => {
    const msgs = [you('go'), lead(call('a1')), lead(call('a2', { description: 'Add tests' })), result(), result(), lead(call('a3', { description: 'Review' }))]
    expect(stagesOf(agentCalls(msgs, { from: 0, to: 6, led: false }), {}).map(st => st.map(c => c.agentId))).toEqual([['a1', 'a2'], ['a3']])
  })
  test('one lead message is one stage; started while another runs joins it; started after all ended opens the next', () => {
    const records = { a1: agent({ id: 'a1', startedAt: 0, endedAt: 50 }), a2: agent({ id: 'a2', startedAt: 0, endedAt: 90 }),
      a3: agent({ id: 'a3', startedAt: 60, endedAt: 99 }), a4: agent({ id: 'a4', startedAt: 100 }) }
    const msgs = [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' })), result(), lead(call('a3', { description: 'Check types' })), result(), lead(call('a4', { description: 'Review' }))]
    const s = { from: 0, to: 6, led: false }
    expect(stagesOf(agentCalls(msgs, s), records).map(st => st.map(c => c.agentId))).toEqual([['a1', 'a2', 'a3'], ['a4']])
    expect(stagesOf(agentCalls(msgs, s), {}).map(st => st.map(c => c.agentId))).toEqual([['a1', 'a2'], ['a3'], ['a4']])
  })
  test('a failed or refused Agent call is not read', () => {
    const msgs = [you('go'), lead({ ...call('a9'), isError: true }, { ...call(''), agentId: undefined })]
    expect(agentCalls(msgs, { from: 0, to: 2, led: false })).toEqual([])
  })
  test('a repeat in a later stage folds with its count; two alike in one stage are peers', () => {
    const impl = (id: string) => call(id, { description: 'Build the slice', name: 'impl' })
    const rev = (id: string) => call(id, { description: 'Review the slice', subagent_type: 'reviewer' })
    const msgs = [you('go'), lead(impl('a1')), result(), lead(rev('a2')), result(), lead(impl('a3')), result(), lead(rev('a4')), result(),
      lead(call('a5', { subagent_type: 'Explore' }), call('a6', { subagent_type: 'Explore' }))]
    const st = stagesOf(agentCalls(msgs, { from: 0, to: 10, led: false }), {})
    const r = foldRepeats(st)
    expect(r.stages.map(x => x.map(c => c.agentId))).toEqual([['a1'], ['a2'], ['a5', 'a6']])
    expect(r.folded).toEqual([{ label: 'Build the slice', times: 2 }, { label: 'Review the slice', times: 2 }])
  })
  test('the default form is Roles when a skill loaded before the first agent', () => {
    expect(defaultForm([you('go'), lead(skill('redmanager')), lead(call('a1'))], { from: 0, to: 3, led: true })).toBe('roles')
    expect(defaultForm([you('go'), lead(call('a1')), lead(skill('status-board'))], { from: 0, to: 3, led: false })).toBe('lineup')
  })
  test('roles group by type, model, effort and isolation; ran counts them; tools sum', () => {
    const records = { a1: agent({ id: 'a1', tools: { Edit: 3 } }), a2: agent({ id: 'a2', tools: { Edit: 1, Bash: 2 }, skills: ['tdd'] }) }
    const msgs = [you('go'), lead(call('a1', { model: 'opus', isolation: 'worktree' }), call('a2', { model: 'opus', isolation: 'worktree' }), call('a3', { subagent_type: 'reviewer', model: 'sonnet' }))]
    const roles = groupRoles(agentCalls(msgs, { from: 0, to: 2, led: false }), records)
    expect(roles.map(r => [r.type, r.model, r.isolation, r.ran])).toEqual([['general-purpose', 'opus', 'worktree', 2], ['reviewer', 'sonnet', undefined, 1]])
    expect(roles[0]).toMatchObject({ tools: { Edit: 4, Bash: 2 }, skills: ['tdd'], label: 'general-purpose' })
  })
  test("an agent's own agents become its team, one level down", () => {
    const team = teamOf([lead(call('b1', { subagent_type: 'Explore' }), call('b2', { subagent_type: 'Explore' }))], {})
    expect(team?.map(r => [r.type, r.ran])).toEqual([['Explore', 2]])
    expect(teamOf([], {})).toBeUndefined()
  })
  test('a paragraph most briefs share is kept verbatim; one in a single brief is not', () => {
    const report = 'STATUS: DONE | BLOCKED\nCHANGED: <files>'
    expect(sharedParts([`Write the docs.\n\n${report}`, `Add tests.\n\n${report}`, 'Review it.'])).toEqual([report])
    expect(sharedParts(['one\n\nonly here', 'two'])).toEqual([])
    expect(sharedParts([`a\n\n${'x'.repeat(1501)}`, `b\n\n${'x'.repeat(1501)}`])).toEqual([])
  })
  test('commands keep the program and subcommand only', () => {
    expect(command('cd app && FOO=1 npm test -- --watch')).toBe('npm test')
    expect(command('git commit -m "token=abc"')).toBe('git commit')
    expect(command('ls -la /p')).toBe('ls')
  })
  test('the lead trace is one numbered line a step', () => {
    const msgs = [you('Build the store'), lead(skill('brainstorming')), lead(call('a1', { model: 'opus', isolation: 'worktree' }), call('a2', { model: 'opus', isolation: 'worktree' })),
      lead({ tool: 'Bash', input: { command: 'npm test' } }, { tool: 'SendMessage', input: { to: 'a1', message: 'fix' } }),
      lead({ tool: 'AskUserQuestion', input: {} }, { tool: 'Bash', input: { command: 'git commit -m x' } })]
    expect(leadTrace(msgs, { from: 0, to: 5, led: false }).map(e => `#${e.n} ${e.line}`)).toEqual([
      '#1 you: "Build the store"', '#2 lead loaded skill brainstorming', '#3 lead started 2 × general-purpose · opus · worktree together',
      '#4 lead ran npm test', '#5 lead sent a message to an agent', '#6 lead asked you a question', '#7 lead ran git commit'])
  })
  test('a long stretch keeps the first 20 and the last 180 steps', () => {
    const msgs = [you('go'), ...Array.from({ length: 300 }, () => lead({ tool: 'Bash', input: { command: 'npm test' } }))]
    const t = leadTrace(msgs, { from: 0, to: msgs.length, led: false })
    expect(t).toHaveLength(201)
    expect(t[20]!.line).toBe('… 101 earlier steps left out')
  })
  test('readWorkflow fills both forms, the lead and the shared parts, and nothing read yet', () => {
    const d = readWorkflow({ msgs: [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' }))], records: {}, teams: {},
      list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p/notes-app', lead: { model: 'claude-opus-5-5' } })!
    expect(d).toMatchObject({ form: 'lineup', project: 'notes-app', read: 'pending', back: 0, more: false, lead: { skills: [], playbook: [], model: 'claude-opus-5-5' } })
    expect(d.stages[0]!.agents.map(a => a.label)).toEqual(['Write the docs', 'Add tests'])
    expect(d.roles).toHaveLength(1)
    expect(readWorkflow({ msgs: [you('hi')], records: {}, teams: {}, list: [], back: 0, root: '/p', lead: {} })).toBeUndefined()
  })
  // Beyond the plan's tests: the rules it states but does not pin.
  test("a workflow run's agents come from records, in start order, as general-purpose, placed in stages by time", () => {
    const records = {
      w2: agent({ id: 'w2', run: 'wf_1', type: 'workflow-subagent', description: 'read:b', brief: 'Read b', startedAt: 20, endedAt: 30, model: 'claude-haiku-5-5' }),
      w1: agent({ id: 'w1', run: 'wf_1', type: 'workflow-subagent', description: 'read:a', brief: 'Read a', startedAt: 10, endedAt: 15 }),
      w9: agent({ id: 'w9', run: 'wf_other', startedAt: 5 }),
      w3: agent({ id: 'w3', run: 'wf_1', parent: 'w1', startedAt: 12 }), // w1's own: it counts only in w1's tools
    }
    // Shapes seen in Task 1: the run's result names its task, and the run's finish is a notice of that task.
    const finished: Msg = { role: 'user', text: '<task-notification>\n<task-id>ws1</task-id>\n<summary>Dynamic workflow "read" completed</summary>\n</task-notification>', toolUses: [] }
    const msgs = [you('go'), lead({ tool: 'Workflow', input: { script: 'agent(…)' }, result: { status: 'async_launched', taskId: 'ws1', runId: 'wf_1', workflowName: 'read', scriptPath: '/s.js' } }),
      result(), finished, notice('done')]
    const s = { from: 0, to: msgs.length, led: false }
    expect(runCalls(msgs, s, records).map(c => [c.agentId, c.input.subagent_type, c.input.prompt])).toEqual([['w1', 'general-purpose', 'Read a'], ['w2', 'general-purpose', 'Read b']])
    const d = readWorkflow({ msgs, records, teams: {}, list: [s], back: 0, root: '/p', lead: {} })!
    // Their script started them, not the lead message: w1 ended before w2 started, so two stages.
    expect(d.stages.map(st => st.agents.map(a => a.description))).toEqual([['read:a'], ['read:b']])
    expect(d.roles.map(r => [r.type, r.model, r.ran])).toEqual([['general-purpose', undefined, 1], ['general-purpose', 'haiku', 1]])
    expect(leadTrace(msgs, s).map(e => e.line)).toEqual(['you: "go"', 'lead started a workflow', 'a workflow finished', 'an agent finished'])
  })
  test('the trace tells one agent, a finished agent, edits, a workflow and your / command apart', () => {
    const edit = (file_path: string) => ({ tool: 'Edit', input: { file_path } })
    const msgs = [you('Fix it\n\nplease'), lead(call('a1', { subagent_type: 'Explore', model: 'haiku' }), { ...call('a9'), isError: true }), result(), notice('done'),
      lead(edit('/p/a.ts')), result(), lead(edit('/p/b.ts')), result(), lead(edit('/p/a.ts')), lead({ ...edit('/p/c.ts'), isError: true }),
      slash('redmanager'), lead(), lead({ tool: 'Bash', input: { command: '' } })]
    const t = leadTrace(msgs, { from: 0, to: msgs.length, led: false })
    expect(t.map(e => e.line)).toEqual(['you: "Fix it please"', 'lead started Explore · haiku', 'an agent finished', 'lead edited 2 files',
      'you: "/redmanager"', 'lead ran a command'])
    expect(t.map(e => e.yours)).toEqual(['Fix it\n\nplease', undefined, undefined, undefined, '/redmanager', undefined])
  })
  test('the steps left out are numbered 0, so no practice can cite them; the rest keep their numbers', () => {
    const msgs = [you('go'), ...Array.from({ length: 300 }, () => lead({ tool: 'Bash', input: { command: 'npm test' } }))]
    const t = leadTrace(msgs, { from: 0, to: msgs.length, led: false })
    expect([t[19]!.n, t[20]!.n, t[21]!.n, t[200]!.n]).toEqual([20, 0, 122, 301])
  })
  test('shared parts: whitespace evened out to compare, at most three, each as first written', () => {
    expect(sharedParts(['Rules:  keep   it\n  short.\n\nx', 'Rules: keep it short.\n\ny'])).toEqual(['Rules:  keep   it\n  short.'])
    expect(sharedParts(['a\n\nb\n\nc\n\nd', 'd\n\nc\n\nb\n\na'])).toEqual(['a', 'b', 'c'])
    expect(sharedParts(['same\n\nsame', 'other'])).toEqual([])
    expect(sharedParts(['Report: DONE', 'Report: DONE', '', '', ' '])).toEqual(['Report: DONE'])
  })
  test('commands drop paths, file arguments and quoted values', () => {
    expect(command('/usr/local/bin/node server.js')).toBe('node')
    expect(command('FOO="a b" pytest tests/ -k x')).toBe('pytest')
    expect(command('npm test\nnpm run lint')).toBe('npm test')
    expect(command('cd /p')).toBe('cd')
  })
  test("a program's first argument is never kept, unless the program has subcommands; a wrapper names the command it runs", () => {
    expect(command('echo sk_live_abc123')).toBe('echo')
    expect(command('cat notes')).toBe('cat')
    expect(command('mkdir secretdir')).toBe('mkdir')
    expect(command('grep hunter2 file')).toBe('grep')
    expect(command('sudo rm -rf build')).toBe('rm')
    expect(command('env FOO=1 npm test')).toBe('npm test')
    // A wrapper given flags stays alone: a flag's value (`-u root`) is never read as the program.
    expect(command('sudo -u root rm -rf build')).toBe('sudo')
    expect(command('time /usr/bin/git push --force')).toBe('git push')
    expect(command('npx tsc -p plugins/redhelm')).toBe('npx tsc')
    // The brief's cases still hold.
    expect(command('cd app && FOO=1 npm test -- --watch')).toBe('npm test')
    expect(command('git commit -m "token=abc"')).toBe('git commit')
    expect(command('ls -la /p')).toBe('ls')
  })
  test("readWorkflow: each agent and role gets its own team; labels cut at a word; Earlier while there is one before", () => {
    const msgs = [you('one'), lead(call('a1', { description: 'Review the whole store module' })), you('two'), lead(call('a2', { description: 'Add tests' }))]
    const list = stretches(msgs)
    const read = (back: number) => readWorkflow({ msgs, records: {}, teams: { a1: [lead(call('b1', { subagent_type: 'Explore' }))] }, list, back, root: '/Users/x/notes-app/', lead: {} })!
    expect([read(0).more, read(1).more]).toEqual([true, false])
    expect(read(0).stages.map(st => st.agents.map(a => a.label))).toEqual([['Add tests']])
    const d = read(1)
    expect(d.stages.map(st => st.agents.map(a => a.label))).toEqual([['Review the whole'], ['Add tests']])
    expect(d.stages[0]!.agents[0]!.team?.map(r => [r.type, r.ran])).toEqual([['Explore', 1]])
    expect(d.stages[1]!.agents[0]!.team).toBeUndefined()
    expect(d.roles.map(r => r.team?.map(t => t.type))).toEqual([['Explore']])
    expect(d).toMatchObject({ project: 'notes-app', projectKey: hash('/Users/x/notes-app/'), types: [], notCopied: [], evidence: [], folded: [] })
  })
})

describe('the reading', () => {
  const d = () => readWorkflow({ msgs: [you('Build the store, 3 rounds of review at most'), lead(call('a1'), call('a2', { description: 'Add tests' }))],
    records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p/notes-app', lead: {} })!
  const trace = () => leadTrace([you('Build the store, 3 rounds of review at most'), lead(call('a1'), call('a2'))], { from: 0, to: 2, led: false })
  const reply = (over: any = {}) => JSON.stringify({ name: 'Docs and tests', purpose: 'Writes docs and tests together', labels: ['Docs', 'Tests'],
    roles: [{ label: 'Writer', role: 'Writes one part' }], playbook: [{ when: 'When parts are independent', do: 'start writers together', evidence: [2] }], ...over })
  test('a good reading fills names, roles and the playbook, with evidence lines', () => {
    const r = applyReading(d(), checkReading(reply(), trace(), d()), trace())
    expect(r).toMatchObject({ name: 'Docs and tests', read: 'done', roles: [{ label: 'Writer', role: 'Writes one part' }] })
    expect(r.stages[0]!.agents.map(a => a.label)).toEqual(['Docs', 'Tests'])
    expect(r.evidence).toEqual([['#2 lead started 2 × general-purpose together']])
  })
  test('a practice citing no real step is dropped', () => {
    expect(checkReading(reply({ playbook: [{ when: 'Always', do: 'x', evidence: [99] }, { when: 'Always', do: 'y', evidence: [] }] }), trace(), d())!.playbook).toEqual([])
  })
  test('a number survives only when a cited prompt of yours holds it', () => {
    const p = (evidence: number[]) => checkReading(reply({ playbook: [{ when: 'When a review fails', do: 'review again, 3 rounds at most', evidence }] }), trace(), d())!.playbook
    expect(p([2])).toEqual([])
    expect(p([1])).toHaveLength(1)
  })
  test('more than eight practices are cut to eight; lengths are enforced', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ when: `When step ${'abcdefghij'[i]}`, do: 'go', evidence: [2] }))
    expect(checkReading(reply({ playbook: many }), trace(), d())!.playbook).toHaveLength(8)
    expect(checkReading(reply({ name: 'x'.repeat(41) }), trace(), d())!.name).toBeUndefined()
    expect(checkReading(reply({ labels: ['Docs'] }), trace(), d())!.labels).toBeUndefined() // one per agent, or none
  })
  test('a failed reading falls back and says so; a fenced answer still parses', () => {
    const r = applyReading(d(), checkReading(undefined, trace(), d()), trace())
    expect(r).toMatchObject({ read: 'failed', name: 'Write the docs, Add tests', purpose: '', lead: { playbook: [] } })
    expect(checkReading('```json\n' + reply() + '\n```', trace(), d())?.name).toBe('Docs and tests')
  })
  // Beyond the plan's tests: the rules it states but does not pin.
  test('the request gives the steps, the lead skills, the start of a script and of each brief, and how many labels and roles', () => {
    const draft = readWorkflow({ msgs: [you('go'), lead(call('a1', { prompt: `Line one\n\n${'p'.repeat(400)}` }), call('a2', { description: 'Add tests' }))],
      records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p', lead: {} })!
    const q = readingRequest({ ...draft, lead: { ...draft.lead, skills: ['redmanager'] } }, [...trace(), { n: 0, line: '… 5 earlier steps left out' }], 's'.repeat(7000))
    expect(q.system).toBe(READING_SYSTEM)
    expect(q.prompt).toContain('#1 you: "Build the store, 3 rounds of review at most"\n#2 lead started 2 × general-purpose together\n… 5 earlier steps left out\n')
    expect(q.prompt).toContain('Lead skills: redmanager')
    expect(q.prompt).toContain(`Workflow script:\n${'s'.repeat(6000)}\n`)
    expect(q.prompt).not.toContain('s'.repeat(6001))
    expect(q.prompt).toContain(`Give 2 labels, one per agent:\n1. Write the docs — brief: Line one ${'p'.repeat(291)}\n2. Add tests — brief: Write docs/api.md`)
    expect(q.prompt).toContain('Give 1 role, one per role:\n1. general-purpose, ran 2×, agents 1, 2')
    expect(READING_CALL).toEqual({ model: 'sonnet', effort: 'low', maxTokens: 1500, timeoutMs: 30_000 })
  })
  test('the line of steps left out is no step; a number must be one you said; one bad label falls back; nothing kept is no reading', () => {
    const t = [...trace(), { n: 0, line: '… 5 earlier steps left out' }]
    const c = (over: any) => checkReading(reply(over), t, d())!
    expect(c({ playbook: [{ when: 'Always', do: 'x', evidence: [0] }] }).playbook).toEqual([])
    expect(c({ playbook: [{ when: 'When a review fails', do: 'review again, 30 rounds at most', evidence: [1] }] }).playbook).toEqual([])
    expect(c({ playbook: [{ when: 'Always', do: 'x', evidence: [2, 2, 99] }] }).evidence).toEqual([[2]])
    expect(c({ labels: ['Docs', 'x'.repeat(17)] }).labels).toEqual(['Docs', 'Add tests'])
    expect(c({ roles: [{ label: 'Writer', role: 'x'.repeat(91) }] }).roles).toEqual([{ label: 'Writer', role: '' }])
    expect(checkReading(JSON.stringify({ name: 'x'.repeat(41), labels: [], roles: [], playbook: [] }), t, d())).toBeUndefined()
    expect(checkReading('Sorry, I cannot read this.', t, d())).toBeUndefined()
  })
  test('a number in words is a number too: it survives only when a cited prompt of yours holds it', () => {
    const p = (doing: string, evidence: number[]) => checkReading(reply({ playbook: [{ when: 'When a review fails', do: doing, evidence }] }), trace(), d())!.playbook
    expect(p('review three rounds', [2])).toEqual([])
    expect(p('review twice', [2])).toEqual([])
    expect(p('Review Three rounds', [2])).toEqual([]) // any case
    expect(p('start one reader per file', [2])).toHaveLength(1) // "one" mostly means "each"
    expect(p('review often', [2])).toHaveLength(1) // whole words: "often" holds no "ten"
    expect(p('review again, three rounds at most', [1])).toHaveLength(1) // your prompt said "3 rounds"
    expect(p('Three rounds at most, then stop', [1])).toHaveLength(1)
  })
  test('a reading without a name is named from its labels; a fallback name is cut to 40 at a word', () => {
    expect(applyReading(d(), checkReading(reply({ name: undefined }), trace(), d()), trace())).toMatchObject({ name: 'Docs, Tests', read: 'done' })
    const four = readWorkflow({ msgs: [you('go'), lead(call('a1', { description: 'Review the whole store' }), call('a2', { description: 'Check every type here' }),
      call('a3', { description: 'Write the new docs' }), call('a4', { description: 'Extra' }))], records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p', lead: {} })!
    expect(applyReading(four, undefined, []).name).toBe('Review the whole, Check every type')
  })
})
