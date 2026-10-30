import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, Register, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { Agent, Draft, Guard, Note, Placement, Release, SavedType, SavedWorkflow, SetupItem, WorkflowMode, WorkflowSheet as SheetState } from '../types'
import { DEFAULTS, LINES, activity, appearance, capital, fromConversation, isNewer, looksLikeQuestion, tidyPaths, type Said, handleOf, handles, base, changedFile, excerpt, kilo, kindOf, relative, remember, settings, short, span, staleTarget, type Settings } from './model'
import { HEADLINE_EVERY_MS, headlineInput, headlineKey, labeler, titleInput, type Complete } from './labels'
import { laneNames, workspaces, type Io } from './sources'
import { PALETTES, RIPPLE_S, animates, backdrop, type Ripple } from './backdrop'
import { BUCKET_MS, BUCKETS, burst, isMoving, record, spectrum, traceRaster, type Burst } from './trace'
import { Alert, Backdropped, Panel, Sheet, WorkflowSheet, WorkflowsSection, clockFace, hue, type Actions, type Els, type TraceSpec, type View } from './view'
import { READING_CALL, agentCalls, applyReading, checkReading, compact, leadTrace, readingRequest, readWorkflow, runCalls, stretches, toolKey, usedIn, widen,
  type Call, type Msg, type Reading, type Stretch, type TraceEvent, type Used } from './workflows'
import { EDIT_CALL, applyOps, checkOps, editRequest, itemCount, listed, parseEdit, parseSaved, planText, projectKey, runText, slug, toSaved, uniqueName,
  type Op } from './library'
import { agentSpec, typeName } from './agentfile'

type $ = EngineInterface

const PANE = 'redhelm'
/** The agent sheet: a second pane, opened as a dialog over one agent. */
const SHEET = 'redhelm-agent'
/** The bottom bar's Workflows: Save and Load, and the sheet a Save opens, in a pane of their own. */
const WORKFLOW_PANE = 'redhelm-workflow'
const TITLE = 'REDhelm'

const AGENTS = { plugin: 'redhelm', key: 'agents' } as const
const WORKSPACES = { plugin: 'redhelm', key: 'workspaces' } as const
const GUARD = { plugin: 'redhelm', key: 'guard' } as const
const PLACEMENT = { plugin: 'redhelm', key: 'placement' } as const
const SETUP = { plugin: 'redhelm', key: 'setup' } as const
const USAGE = { plugin: 'redhelm', key: 'usage' } as const

const agents = atom(AGENTS, {})
const showDone = atom({ plugin: 'redhelm', key: 'showDone' } as const, false)
const DRAFT = { plugin: 'redhelm', key: 'draft' } as const
const draftKept = atom(DRAFT, null)
const notes = atom({ plugin: 'redhelm', key: 'notes' } as const, [])
const inbox = atom({ plugin: 'redhelm', key: 'inbox' } as const, [])
const spaces = atom(WORKSPACES, [])
const guard = atom(GUARD, {})
const INSPECTING = { plugin: 'redhelm', key: 'inspecting' } as const
const inspecting = atom(INSPECTING, null)
const briefOpen = atom({ plugin: 'redhelm', key: 'briefOpen' } as const, false)
const COMPOSING = { plugin: 'redhelm', key: 'composing' } as const
const composing = atom(COMPOSING, null)
const now = atom({ plugin: 'redhelm', key: 'now' } as const, 0)
const placement = atom(PLACEMENT, 'right' as Placement)
const collapsed = atom({ plugin: 'redhelm', key: 'collapsed' } as const, false)
const setup = atom(SETUP, [] as SetupItem[])
const usage = atom(USAGE, {})
const release = atom({ plugin: 'redhelm', key: 'release' } as const, null as Release | null)
const workflowSheet = atom({ plugin: 'redhelm', key: 'workflowSheet' } as const, null as SheetState | null)
const workflowList = atom({ plugin: 'redhelm', key: 'workflowList' } as const, null as { workflows: SavedWorkflow[]; unreadable: number } | null)
const workflowMode = atom({ plugin: 'redhelm', key: 'workflowMode' } as const, null as WorkflowMode)

const ENDED = new Set(['completed', 'failed', 'killed'])
const LIVE = new Set(['pending', 'running', 'waiting'])
/** How long an agent may be missing from Claude Code's list before REDhelm counts it as finished. */
const GRACE_MS = 20_000
/** How long a question stays after its agent ended. */
const QUESTION_OUTLIVES_MS = 30 * 60_000

/** Bookkeeping never gets in the way of the call it watches. */
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {}
}

const blank = (id: string, at: number): Agent => ({
  id, name: '', type: 'agent', description: '', status: 'running',
  context: 0, startedAt: at, recent: [], files: [], edits: 0, fails: 0, steps: [],
})

/** Change one agent, creating it if its first event beat the spawn hook. */
async function patch($: $, id: string, fn: (a: Agent) => Partial<Agent>) {
  const at = await $.clock.now()
  await update($, agents, all => {
    const a = all[id] ?? blank(id, at)
    return { ...all, [id]: { ...a, ...fn(a) } }
  })
}

/**
 * Whether a loop's events belong to an agent REDhelm shows: one it saw start, or one Claude Code
 * lists. The engine's own forks (compaction, memory, suggestions) carry ids no list names; without
 * this they turned up as an unnamed agent that never did anything.
 */
async function ourAgent($: $, id: string) {
  if ((await $.state.get(AGENTS)).value?.[id]) return true
  return (await $.agent.list()).some(a => a.id === id)
}

async function note($: $, n: Omit<Note, 'at'>) {
  const at = await $.clock.now()
  await update($, notes, list => [...list, { ...n, at }].slice(-40))
}

/** What an agent is called in REDhelm's messages and in the "→ name:" address. */
const labelOf = (a?: Agent) => a?.name || excerpt(a?.description, 24) || a?.type || 'agent'

const nameOf = async ($: $, id: string) => labelOf((await $.state.get(AGENTS)).value?.[id])

/** A prompt addressed to an agent: "→ handle: message". */
const ADDRESS = /^→ ([^:\n]+): ([\s\S]*)$/

/** An edit of the open workflow draft: "✎ Workflow: the change". The mark alone asks for none. */
const EDIT_MARK = /^✎ Workflow:(?:\s([\s\S]*))?$/
const EDITING = '✎ Workflow: '

/** Your notes after a run's mark, `▶ <name>: `: matched by the name Run chose, so a name may hold colons. Undefined without the mark. */
function runNotes(text: string, name: string) {
  const mark = `▶ ${name}:`
  if (!text.startsWith(mark)) return undefined
  const rest = text.slice(mark.length)
  return !rest || /^\s/.test(rest) ? rest.trim() : undefined
}

/** Whether the box holds the mode's mark: then it is REDhelm's to replace, and no draft of yours. */
const marked = (text: string, mode: NonNullable<WorkflowMode>) => (mode.kind === 'edit' ? EDIT_MARK.test(text) : runNotes(text, mode.name) !== undefined)

/** Prompts that reach the hook without being typed in your box: they never end a workflow's mode or take its mark. */
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator',
  'observer', 'observer-activity', 'auto-continuation', 'slack-ping', 'bridge', 'plugin'])

/** The agent an address names, preferring one still running. */
async function agentNamed($: $, name: string) {
  const all = Object.values((await $.state.get(AGENTS)).value ?? {})
  const hs = handles(all)
  const wanted = name.trim().toLowerCase()
  const replying = (await $.state.get(COMPOSING)).value
  if (replying && hs[replying]?.toLowerCase() === wanted) return replying
  const named = all.filter(a => hs[a.id]!.toLowerCase() === wanted)
  return (named.find(a => LIVE.has(a.status)) ?? named[0])?.id
}

/** The sources' window on the host: the session root and $.fs. */
async function io($: $): Promise<Io> {
  return {
    root: await $.session.root(),
    read: path => $.fs.read(path),
    stat: path => $.fs.stat(path),
    list: dir => $.fs.list(dir),
    exists: path => $.fs.exists(path),
  }
}

/** Agents whose end REDhelm has already announced, so each is announced once. */
const told = new Set<string>()

/** "✓ docs finished": a note and, when wanted, a pop-up. */
async function announce($: $, id: string, failed: boolean, said = '') {
  if (told.has(id)) return
  told.add(id)
  const name = await nameOf($, id)
  await note($, { kind: failed ? 'fail' : 'done', text: `${name}  ${excerpt(said, 60)}`, agentId: id })
  if (cfg.agentToasts) $.ui.toast(`${failed ? '✕' : '✓'} ${name} ${failed ? 'failed' : 'finished'}`)
}

/** Agents whose conversation REDhelm has already read back, so each is read once. */
const readBack = new Set<string>()

/** Fills in an agent REDhelm did not watch from the start, from what Claude Code kept of its conversation. */
async function backfill($: $, id: string) {
  if (readBack.has(id)) return
  readBack.add(id)
  const said = await $.session.messages({ agentId: id })
  if (!Array.isArray(said)) return
  const got = fromConversation(said.map(m => ({ ...m, text: tidy(m.text) })) as Said[], root)
  // What REDhelm saw itself wins; the conversation only fills what is missing.
  await patch($, id, a => ({
    brief: a.brief ?? got.brief,
    thinking: a.thinking ?? got.thinking,
    ...(!a.steps?.length && { steps: got.steps, recent: got.recent }),
    ...(!a.files.length && { files: got.files, edits: got.edits }),
    fails: a.fails || got.fails,
  }))
}

/** The person's home folder, so what agents say never shows it in full. */
let homeDir = ''
const tidy = (text = '') => tidyPaths(text, root, homeDir)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Merges the engine's agent list; writes only on change, and ticks the clock only while agents are live. */
async function sync($: $) {
  const at = await $.clock.now()
  const list = await $.agent.list()
  const merge = (all: Record<string, Agent>) => {
    const next = { ...all }
    for (const info of list) {
      const a = next[info.id] ?? blank(info.id, at)
      next[info.id] = {
        ...a,
        name: info.name ?? a.name,
        type: info.type,
        description: info.description || a.description,
        status: info.status,
        endedAt: ENDED.has(info.status) ? a.endedAt ?? at : undefined,
      }
    }
    // Claude Code drops an agent from its list once it is done; one REDhelm still shows as live,
    // gone from the list past a short grace, has finished (no ghosts "running" for hours).
    // A workflow run's agents are never listed: each ends on its own turn.complete instead.
    const listed = new Set(list.map(i => i.id))
    for (const a of Object.values(next)) {
      if (LIVE.has(a.status) && !a.run && !listed.has(a.id) && at - a.startedAt > GRACE_MS) {
        next[a.id] = { ...a, status: 'completed', endedAt: a.endedAt ?? at, activity: undefined }
      }
    }
    const finished = Object.values(next).filter(a => ENDED.has(a.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    for (const a of finished.slice(20)) delete next[a.id]
    return next
  }
  const current = (await $.state.get(AGENTS)).value ?? {}
  const merged = merge(current)
  if (!same(current, merged)) await update($, agents, merge)
  for (const info of list) if (!current[info.id] && LIVE.has(info.status)) void quietly(() => backfill($, info.id))
  // An agent whose turn ended while work it started was still running ends later; say so then.
  // A ghost (dropped from the list unseen) is announced only if it had answered.
  const listed = new Set(list.map(i => i.id))
  for (const [id, a] of Object.entries(merged)) {
    const was = current[id]
    if (was && LIVE.has(was.status) && ENDED.has(a.status) && (listed.has(id) || was.answer)) await announce($, id, a.status === 'failed', was.answer)
  }
  // A question outlives its agent for a while: a reply still resumes a finished agent, even one gone from the list.
  // Long after the agent ended it has gone stale and stops asking for you (its words stay in the agent's notes).
  const answerable = (id: string) => {
    const a = merged[id]
    return listed.has(id) || (!!a && (LIVE.has(a.status) || at - (a.endedAt ?? at) < QUESTION_OUTLIVES_MS))
  }
  const asks = await read($, inbox)
  if (asks.some(m => !answerable(m.agentId))) await update($, inbox, list => list.filter(m => answerable(m.agentId)))
}

// What agents send you

/** The labels the model picks between; the first means the agent waits on you. */
const ASKS = ['asks the person a question or for a decision', 'reports or informs, needs no answer'] as const

/** Whether a message waits on an answer: the session's small model reads it; its words alone decide when it cannot. */
async function isQuestion($: $, text: string) {
  const label = await $.model.classify(text, ASKS).catch(() => undefined)
  return label ? label === ASKS[0] : looksLikeQuestion(text)
}

/** When the main conversation last wrote to each agent, so a question it answered while REDhelm was still reading it is not shown. */
const answeredAt = new Map<string, number>()

/** A question asks for you; a report becomes what the agent last said. */
async function received($: $, from: string, raw: string) {
  const at = await $.clock.now()
  const text = tidy(raw)
  const name = await nameOf($, from)
  if (await isQuestion($, text)) {
    const answered = answeredAt.get(from)
    if (answered !== undefined && answered >= at) return
    await update($, inbox, list => [...list, { id: `${from}-${at}`, agentId: from, text, at, ask: true }].slice(-20))
    await note($, { kind: 'ask', text: `${name}: ${excerpt(text, 60)}`, agentId: from })
    if (cfg.agentToasts) $.ui.toast(`⚑ ${name} asks you something`)
    // The card's edge flashes a few times as it arrives: six redraws a quarter second apart.
    if (cfg.motion === 'on') {
      for (let k = 1; k <= 6; k++) $.clock.after(k * 250, () => void quietly(async () => {
        const t = await $.clock.now()
        await update($, now, () => t)
      }))
    }
  } else {
    await patch($, from, () => ({ answer: text }))
    await note($, { kind: 'report', text: `${name}: ${excerpt(text, 60)}`, agentId: from })
    if (cfg.agentToasts) $.ui.toast(`${name}: ${excerpt(text, 70)}`)
  }
}

// A newer REDhelm

/** Where the published REDhelm says its version. */
const MANIFEST = 'https://raw.githubusercontent.com/watLr/redhelm/main/plugins/redhelm/.claude-plugin/plugin.json'
/** REDhelm's own marketplace, the one that publishes MANIFEST: `redhelm@redhelm`. */
const MARKET = 'redhelm'
const fromMarket = (id: string) => id.split('@')[1] ?? ''
const CHECK_EVERY = 6 * 3_600_000
const CHECK_SHARED_MS = 3_600_000

/**
 * Compares the installed REDhelm with the published one. Only a copy from REDhelm's own marketplace
 * is offered it: a local folder is its own source, and another marketplace (the plugin directory)
 * ships the version it chose and updates it itself.
 */
async function checkRelease($: $) {
  // One check serves every open session for an hour: they share REDhelm's store.
  const at = await $.clock.now()
  const kept = (await $.store.get('release')) as { at: number; id: string; installed: string; latest: string } | undefined
  let seen = kept && at - kept.at < CHECK_SHARED_MS ? kept : undefined
  if (!seen) {
    const listed = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 20_000 })
    const mine = (JSON.parse(listed.stdout) as { id: string; version: string }[]).find(p => p.id.startsWith('redhelm@'))
    if (!mine) return update($, release, () => null)
    let latest = ''
    if (fromMarket(mine.id) === MARKET) {
      const got = await $.http.fetch(MANIFEST)
      if (!got.ok) return
      latest = String((JSON.parse(got.text) as { version?: unknown }).version ?? '')
    }
    seen = { at, id: mine.id, installed: mine.version, latest }
    await $.store.set('release', seen)
  }
  const { id, installed, latest } = seen
  if (fromMarket(id) !== MARKET) return update($, release, () => null)
  await update($, release, was =>
    was?.state === 'updated' || was?.state === 'updating' ? was
      : isNewer(latest, installed) ? { id, installed, latest } : null)
}

/** Runs Claude Code's own plugin update; the new version loads on /reload-plugins or a restart. */
async function updateNow($: $): Promise<string> {
  const rel = await read($, release)
  if (!rel) {
    const kept = (await $.store.get('release')) as { id?: string } | undefined
    const market = fromMarket(kept?.id ?? '')
    if (market === 'inline') return 'REDhelm runs from a local folder · update it there'
    if (market && market !== MARKET) return `REDhelm comes from ${market}, which keeps it up to date · claude plugin update ${kept!.id}`
    return 'REDhelm is up to date'
  }
  if (rel.state === 'updating') return `REDhelm is already updating to ${rel.latest}`
  if (rel.state === 'updated') return `REDhelm ${rel.latest} is installed · run /reload-plugins to load it`
  await update($, release, (r): Release | null => r && { ...r, state: 'updating', detail: undefined })
  const market = rel.id.split('@')[1]!
  await $.process.run(['claude', 'plugin', 'marketplace', 'update', market], { timeoutMs: 120_000 }).catch(() => undefined)
  const r = await $.process.run(['claude', 'plugin', 'update', rel.id], { timeoutMs: 120_000 })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const ok = r.exitCode === 0
  if (ok) await $.store.delete('release').catch(() => undefined) // the next check reads the new version
  await update($, release, (x): Release | null => x && { ...x, state: ok ? 'updated' : 'failed', detail: ok ? undefined : excerpt(r.stderr || r.stdout, 120) })
  return ok
    ? `REDhelm ${rel.latest} is installed · run /reload-plugins to load it`
    : `REDhelm could not update: ${excerpt(r.stderr || r.stdout, 120) || 'unknown reason'} · try claude plugin update ${rel.id}`
}

// The model guard: what the person chose, what actually answers, and whether the session fell behind

/** The person's REDhelm settings (/config); a change there reloads the module with the new values. */
let cfg: Settings = settings()
/** A draft meant for Claude, held while you message an agent and put back after. */
/** The person's theme, so REDhelm's surfaces match it. */
let theme: 'light' | 'dark' = 'dark'
/** The session's project root (set at session start). */
let root = ''
/** Off in sessions nobody watches (claude -p, SDK, spawned runs): every hook passes straight through. */
let active = false
/** The pane opens by itself at most once a session, and never after the person used /redhelm. */
let autoOpened = false
/** The model the person chose for the main thread: the first to answer, then each /model. */
let chosen: string | undefined
/** The stale default the person was already told about; they are told once. */
let staleTold: string | undefined
/** null until the first call, so a reload always re-pins (or clears) the line. */
let shownStatus: string | undefined | null = null
/** Whether python3 runs here (the shipped status lines need it); undefined until asked. */
let hasPython: boolean | undefined
/** The command that worked for desktop notifications here; null when none does. */
let notifier: string[] | null | undefined

const statusText = (g: Guard) => {
  const model = [short(g.model), g.effort].filter(Boolean).join(' · ')
  if (g.fallback) return `✕ Model switched on its own: ${g.fallback} · /model to choose`
  if (g.stale) return `⚠ ${model} · your default is now ${short(g.stale)} · /model to switch`
  return model ? `● ${model}` : undefined
}

/** Pins the guard's line under the prompt; only redraws when the line changes. */
async function status($: $) {
  const g = (await $.state.get(GUARD)).value ?? {}
  const problem = !!(g.fallback || g.stale)
  const text = cfg.statusLine === 'off' || (cfg.statusLine === 'problems' && !problem) ? undefined : statusText(g)
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

/** Is this session behind the default new sessions get? A picker alias resolves to the newest version seen. */
async function checkStale($: $) {
  const g = (await $.state.get(GUARD)).value ?? {}
  const model = g.model ?? (await $.session.model())
  if (!model.startsWith('claude-')) return status($)
  const recorded = ((await $.store.get('newest')) ?? {}) as Record<string, string>
  const known = remember(recorded, model)
  if (known !== recorded) await $.store.set('newest', known)
  const wanted = (await $.settings.read()).model
  const stale = cfg.guard === 'off' ? undefined : staleTarget(model, typeof wanted === 'string' ? wanted : undefined, known)
  if (g.model !== model || g.stale !== stale) await update($, guard, x => ({ ...x, model: x.model ?? model, stale }))
  await status($)
}

/** The system's appearance, read at most once a minute, for Claude Code's `auto` theme (whose own reading plugins cannot see). */
let system: { at: number; theme: 'light' | 'dark' } | undefined
async function systemTheme($: $): Promise<'light' | 'dark'> {
  const at = await $.clock.now()
  if (system && at - system.at < 60_000) return system.theme
  const ask = async (argv: string[]) => $.process.run(argv, { timeoutMs: 3000 }).catch(() => undefined)
  system = { at, theme: await appearance(ask) }
  return system.theme
}

/** Re-reads workspaces and the stale check; writes only on change, so idle polling never redraws. */
async function refresh($: $) {
  const t = (await $.settings.read()).theme
  const was = theme
  theme = typeof t === 'string' && t.includes('light') ? 'light' : t === 'auto' ? await systemTheme($) : 'dark'
  // The theme is no state REDhelm keeps: a change redraws it, background and all.
  if (theme !== was) $.ui.invalidate('ui.render')
  const list = await workspaces(await io($))
  if (!same((await $.state.get(WORKSPACES)).value, list)) await $.state.set(WORKSPACES, list)
  await checkStale($)
}

/** A desktop notification where the platform has one (macOS, Linux), else nothing beyond the toast. */
async function notify($: $, title: string, subtitle: string, body: string) {
  if (notifier === null) return
  const q = (s: string) => `"${s.replace(/[\\"]/g, m => `\\${m}`)}"`
  const tries = notifier
    ? [notifier]
    : [['osascript', '-e'], ['notify-send']]
  for (const cmd of tries) {
    const argv = cmd[0] === 'osascript'
      ? [...cmd, `display notification ${q(body)} with title ${q(title)} subtitle ${q(subtitle)} sound name "Glass"`]
      : [...cmd, title, `${subtitle}\n${body}`]
    try {
      if ((await $.process.run(argv)).exitCode === 0) {
        notifier = cmd
        return
      }
    } catch {}
  }
  notifier = null
}

// The setup card: the Claude Code settings REDhelm brings, applied only when the person presses Apply

const LINE_KEYS = new Set<string>(LINES.map(l => l.key))

const home = async ($: $) => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''

/**
 * Where REDhelm's status line scripts run from once applied: copies beside their state, not the
 * plugin's own folder, whose path names its version and goes away after an update.
 */
const linesDir = async ($: $) => `${await home($)}/.claude/redhelm/statusline`
const SCRIPTS = ['statusline.py', 'agents.py', 'common.py']

/** The command for one of REDhelm's status lines. */
const lineCommand = (dir: string, script: string) => `python3 "${dir}/${script}"`

/** A status line an earlier REDhelm set up inside Claude Code's versioned plugin folder. */
const STRANDED = /^python3 "[^"]*[\\/]plugins[\\/]cache[\\/][^"]*[\\/]statusline[\\/](statusline|agents)\.py"$/

/** Makes the kept copies of the status line scripts this version's; writes only what changed. */
async function shipLines($: $) {
  const from = `${$.plugin.root.replace(/[\\/]\.claude-plugin$/, '')}/statusline`
  const to = await linesDir($)
  for (const name of SCRIPTS) {
    const text = await $.fs.read(`${from}/${name}`)
    const was = (await $.fs.exists(`${to}/${name}`)) ? await $.fs.read(`${to}/${name}`) : undefined
    if (was !== text) await $.fs.write(`${to}/${name}`, text)
  }
}

/**
 * Keeps REDhelm's status lines working across updates: refreshes the copies they run, and moves a
 * line an earlier REDhelm set up inside the versioned plugin folder to them. Lines of your own stay.
 */
async function keepLines($: $) {
  const path = `${await home($)}/.claude/settings.json`
  if (!(await $.fs.exists(path))) return
  const json = JSON.parse((await $.fs.read(path)) || '{}') as Record<string, { command?: unknown } | undefined>
  const dir = await linesDir($)
  const command = (key: string) => (typeof json[key]?.command === 'string' ? (json[key]!.command as string) : '')
  const kept = LINES.filter(l => command(l.key) === lineCommand(dir, l.script))
  const stranded = LINES.filter(l => STRANDED.exec(command(l.key))?.[1] === l.script.replace('.py', ''))
  if (!kept.length && !stranded.length) return
  await shipLines($)
  await writeLines($, stranded.map(l => ({ key: l.key, label: l.label, value: lineCommand(dir, l.script) })))
}

async function pythonRuns($: $) {
  if (hasPython === undefined) {
    try {
      hasPython = (await $.process.run(['python3', '--version'])).exitCode === 0
    } catch {
      hasPython = false
    }
  }
  return hasPython
}

/** Settings already applied or set aside; the card offers each one once, and /redhelm setup offers them all again. */
async function setupHandled($: $) {
  const keys = (await $.store.get('setupSeen')) as string[] | undefined
  if (keys) return keys
  return (await $.store.get('setup')) ? DEFAULTS.map(d => d.key) : [] // before v0.3: one flag for all
}

async function setupItems($: $, all = false): Promise<SetupItem[]> {
  const skip = all ? [] : await setupHandled($)
  const rows = await $.config.list()
  const items: SetupItem[] = DEFAULTS.flatMap(d => {
    const row = rows.find(r => r.key === d.key)
    const value = row && !row.isLocked ? d.want(row.options) : undefined
    return row && value !== undefined && row.value !== value && !skip.includes(d.key) ? [{ key: d.key, label: d.label, value }] : []
  })
  if (await pythonRuns($)) {
    const current = (await $.settings.read()) as Record<string, { command?: string } | undefined>
    const dir = await linesDir($)
    for (const line of LINES) {
      const command = lineCommand(dir, line.script)
      if (current[line.key]?.command === command || skip.includes(line.key)) continue
      items.push({ key: line.key, label: current[line.key] ? `${line.label} (replaces your current one)` : line.label, value: command })
    }
  }
  return items
}

/** Writes REDhelm's status lines into the person's settings.json, keeping everything else in it. */
async function writeLines($: $, lines: SetupItem[]) {
  if (!lines.length) return
  const path = `${await home($)}/.claude/settings.json`
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : '{}'
  const json = JSON.parse(text || '{}') as Record<string, unknown>
  for (const l of lines) json[l.key] = { type: 'command', command: l.value }
  await $.fs.write(path, `${JSON.stringify(json, null, 2)}\n`)
}

async function applySetup($: $) {
  const items = (await $.state.get(SETUP)).value ?? []
  let applied = 0
  for (const item of items.filter(i => !LINE_KEYS.has(i.key))) {
    try {
      const r = await $.config.set({ key: item.key, value: item.value } as Parameters<$['config']['set']>[0])
      if (!r.deny) applied++
    } catch {}
  }
  const lines = items.filter(i => LINE_KEYS.has(i.key))
  try {
    if (lines.length) await shipLines($)
    await writeLines($, lines)
    applied += lines.length
  } catch {}
  await $.store.set('setupSeen', [...new Set([...(await setupHandled($)), ...items.map(i => i.key)])])
  await update($, setup, () => [])
  $.ui.toast(applied === items.length ? `REDhelm settings applied` : `Applied ${applied} of ${items.length} settings`)
}

async function skipSetup($: $) {
  const items = (await $.state.get(SETUP)).value ?? []
  await $.store.set('setupSeen', [...new Set([...(await setupHandled($)), ...items.map(i => i.key)])])
  await update($, setup, () => [])
}

/** /redhelm models: what actually answered this session, the latest model switches, and what REDhelm's own model calls used. */
async function modelsReport($: $) {
  const use = (await $.state.get(USAGE)).value ?? {}
  const switches = ((await $.store.get('switches')) ?? []) as { at: number; from: string; to: string; source: string }[]
  const at = await $.clock.now()
  const rows = Object.entries(use).sort((a, b) => b[1].requests - a[1].requests)
  const lines = [
    'Models this session (what actually answered):',
    ...(rows.length
      ? rows.map(([m, u]) => `  ${short(m).padEnd(12)} ${String(u.requests).padStart(5)} requests   ${kilo(u.output).padStart(6)} output   ${u.agents} by agents`)
      : ['  none yet']),
    '',
    'Recent model switches:',
    ...(switches.length
      ? switches.slice(-5).reverse().map(s => `  ${span(at - s.at).padStart(4)} ago  ${short(s.from)} → ${short(s.to)}  (${s.source === 'auto' ? 'on its own' : s.source})`)
      : ['  none']),
    '',
    // Labels, and a workflow's reading and edits: each has its own setting.
    `REDhelm's own model calls (labels: ${cfg.labels === 'haiku' ? 'Haiku, low effort' : 'off'}; workflows: ${cfg.workflowReading === 'sonnet' ? 'Sonnet, low effort' : 'off'}): ${spent.calls} ${spent.calls === 1 ? 'request' : 'requests'}, ${kilo(spent.input)} in, ${kilo(spent.output)} out`,
  ]
  return lines.join('\n')
}

/** Leaves a reply unsent: an addressed prompt goes back to what you were writing to Claude (or empty). */
async function leaveReply($: $) {
  const draft = (await takeDraft($)) ?? ''
  await update($, composing, () => null)
  // Only an addressed prompt is REDhelm's to replace; anything else you have typed since is yours.
  if (ADDRESS.test((await $.prompt.read()).text)) await $.prompt.fill({ text: draft, mode: 'replace' })
}

/** The draft kept while you write to an agent, handed back once and forgotten. */
async function takeDraft($: $) {
  const draft = (await $.state.get(DRAFT)).value ?? null
  if (draft !== null) await update($, draftKept, () => null)
  return draft
}

/**
 * Your draft back in the prompt box, once Claude Code has let go of the prompt it just took or dropped
 * (it keeps a dropped prompt's text, so filling at once would lose to it).
 */
function fillBack($: $, draft: string) {
  $.clock.after(100, () => void quietly(() => $.prompt.fill({ text: draft, mode: 'replace' })))
}

// Motion: traces, the clock in the time columns, and the small model's labels

/** Each agent's tool call times over the last minute: its trace. Visual only; a reload starts it flat. */
const traces = new Map<string, number[]>()
/** Each agent's responses over the last minute, timed: how fast its tokens arrive. A reload starts it empty. */
const bursts = new Map<string, Burst[]>()
/** The Rasters each site drew, by key, with the cells last sent: the frame loop repaints only what changed. */
const sites = new Map<string, Map<string, TraceSpec>>()
/** Whether REDhelm is on screen (its pane shown, or the bar above the prompt); checked once a second. */
let visible = false
let framing = false
const labels = labeler()
/** Cancels label calls in flight when the session ends. */
let stopLabels = new AbortController()

async function onScreen($: $) {
  if ((await $.ui.panes()).some(p => p.id === PANE && p.isShown)) return true
  return (await read($, placement)) === 'bottom' && !(await read($, collapsed))
}

/** One label from the small model, the way /btw asks a side question: low effort, a few words, six seconds at most. */
const askHaiku = ($: $): Complete => async ({ system, prompt }) => {
  const r = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 30, timeoutMs: 6000, system, prompt }, { signal: stopLabels.signal })
  counted(r)
  return r.isAnswered ? r.text : undefined
}

/** What REDhelm's own model calls (labels, and a workflow's reading) have cost this session, for /redhelm models. */
const spent = { calls: 0, input: 0, output: 0 }

/** One more call in the tally. */
const counted = (r: { usage?: { input_tokens?: number; output_tokens?: number } }) => {
  spent.calls++
  spent.input += r.usage?.input_tokens ?? 0
  spent.output += r.usage?.output_tokens ?? 0
}

/** Titles for questions first (they are what you read), then headlines for agents at work; written only when they change. */
async function labelAll($: $) {
  const at = await $.clock.now()
  for (const m of await read($, inbox)) {
    if (m.title || !(m.ask ?? looksLikeQuestion(m.text))) continue
    const title = await labels.ask(askHaiku($), 'title', m.id, titleInput(m.text), at)
    if (title) await update($, inbox, list => list.map(x => (x.id === m.id ? { ...x, title } : x)))
  }
  for (const a of Object.values(await read($, agents))) {
    if (a.status !== 'running' || a.waitingOn || !(a.steps?.length || a.brief)) continue
    // Kept in the agent's own record, so a headline holds until its work changes, whoever wrote it.
    const key = headlineKey(a)
    if (a.headlineFor === key || at - (a.headlineAt ?? -Infinity) < HEADLINE_EVERY_MS) continue
    const headline = await labels.ask(askHaiku($), 'headline', a.id, headlineInput(a), at, key)
    if (!headline) continue
    await patch($, a.id, cur =>
      cur.headlineFor === key || at - (cur.headlineAt ?? -Infinity) < HEADLINE_EVERY_MS ? {} : { headline, headlineFor: key, headlineAt: at })
  }
}

/** The times last drawn (clockFace). */
let shownFace = ''

/** Once a second: whether REDhelm is on screen; if so, a time it shows that changed redraws it, and labels are asked for. */
async function tick($: $) {
  const was = visible
  visible = await onScreen($)
  await pace($)
  if (!visible) return
  const at = await $.clock.now()
  const face = clockFace(Object.values(await read($, agents)), await read($, inbox), at, Object.fromEntries(traces), Object.fromEntries(bursts))
  if (!was || face !== shownFace) {
    shownFace = face
    await update($, now, () => at)
  }
  if (cfg.labels === 'haiku') void quietly(() => labelAll($))
}

/** The frame loop runs only while REDhelm is on screen and a trace still moves (the sheet's spans a minute). */
let frames: { cancel: () => void } | undefined
async function pace($: $) {
  const at = await $.clock.now()
  const moving = [...traces.values()].some(times => times.some(t => at - t < BUCKET_MS * BUCKETS + BUCKET_MS)) || backdropMoves(at)
  if (visible && moving && cfg.motion === 'on') frames ??= $.clock.every(125, () => void quietly(() => frame($)))
  else {
    frames?.cancel()
    frames = undefined
  }
}

/** Eight times a second: every trace on screen whose cells changed is repainted in place, with no redraw. */
async function frame($: $) {
  if (!visible || cfg.motion !== 'on' || framing || (!sites.size && !backdropSite)) return
  framing = true
  try {
    const at = await $.clock.now()
    frameCount++
    // The backdrop: rings at eight frames a second; the field and the ember at four.
    const site = backdropSite
    if (site && backdropMoves(at) && (cfg.backdrop === 'ripples' || frameCount % 2 === 0)) {
      const cells = await backdropCells($, at, site.columns, site.rows)
      if (cells !== site.sent) {
        site.sent = cells
        const r = (await $.ui.blit({ requestId: site.requestId, key: 'backdrop', cells }).catch(() => ({ deny: 'failed' }))) as { deny?: string }
        if (r.deny && backdropSite === site) backdropSite = undefined
      }
    }
    for (const [requestId, keys] of sites) {
      for (const [key, spec] of keys) {
        const times = traces.get(spec.agentId) ?? []
        const cells = traceRaster(times, at, spec.cells, spec.rows, isMoving(times, at) ? spec.moving : spec.quiet, spec.bg)
        if (cells === spec.sent) continue
        spec.sent = cells
        const r = (await $.ui.blit({ requestId, key, cells }).catch(() => ({ deny: 'failed' }))) as { deny?: string }
        // Not drawn there any more (the agent finished, the sheet closed): stop repainting it.
        if (r.deny) keys.delete(key)
      }
      if (!keys.size) sites.delete(requestId)
    }
  } finally {
    framing = false
  }
}

// The backdrop behind the sidebar

/** Tool calls, newest last: each sends a ring through the backdrop from its agent's place on the activity line. */
const ripples: { agentId: string; at: number }[] = []
/** The backdrop the pane last drew, and the cells it holds: the frame loop repaints it while it moves. */
let backdropSite: { requestId: string; columns: number; rows: number; sent?: string } | undefined
let frameCount = 0

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

/** Whether the backdrop changes now: the field and the ember always; ripples while a ring (and its last frame) is in flight. */
const backdropMoves = (at: number) =>
  !!backdropSite && cfg.motion === 'on' &&
  animates(cfg.backdrop, ripples.map(r => ({ x: 0, y: 0, color: 0, at: r.at / 1000 })), at / 1000 - 0.3)

/** A still backdrop (the lattice, ripples between rings, anything with motion off), drawn once and reused. */
let stillCells: { key: string; cells: string } | undefined

/** One frame of the backdrop. Rings start where their agent sits on the activity line under REDhelm's name. */
async function backdropCells($: $, at: number, columns: number, rows: number) {
  if (!backdropMoves(at) && cfg.backdrop !== 'field' && cfg.backdrop !== 'ember' || cfg.motion !== 'on') {
    const key = `${cfg.backdrop}|${cfg.motion}|${theme}|${columns}x${rows}`
    if (stillCells?.key !== key) stillCells = { key, cells: await drawBackdrop($, at, columns, rows) }
    return stillCells.cells
  }
  return drawBackdrop($, at, columns, rows)
}

async function drawBackdrop($: $, at: number, columns: number, rows: number) {
  const all = Object.values(await read($, agents))
  const live = new Set(all.filter(a => LIVE.has(a.status)).map(a => a.id))
  const parts = spectrum(Object.fromEntries([...traces].filter(([id]) => live.has(id))), at, columns)
  const centre: Record<string, number> = {}
  let x = 0
  for (const p of parts) {
    centre[p.id] = x + p.cells / 2
    x += p.cells
  }
  const rings: Ripple[] = ripples
    .filter(r => at - r.at < RIPPLE_S * 1000 && centre[r.agentId] !== undefined)
    .map(r => ({ x: centre[r.agentId]!, y: 1, at: r.at / 1000, color: parseInt(hue(r.agentId).slice(1), 16) }))
  const calls = [...traces.values()].reduce((n, times) => n + times.filter(t => at - t < 60_000).length, 0)
  // Motion off: the same picture, held still.
  const still = cfg.motion !== 'on'
  return backdrop(cfg.backdrop, columns, rows, still ? 0 : at / 1000, PALETTES[theme], Math.min(1, calls / 40), still ? [] : rings)
}

// Workflows: Save reads the session into a sheet, the reading names it, Save on the sheet keeps it

/** Where a project keeps its own agent types, and how far into it Save looks. */
const AGENT_DIR = '.claude/agents'
const AGENT_DEPTH = 4
const AGENT_FILES = 200

/** Each Save and Earlier takes a new token, and closing the sheet moves it on: a reading lands only on the sheet it was asked for. */
let sheetToken = 0
/** A keep under way: a second press while it writes writes nothing. */
let keeping = false

/** The session's rows as Save reads them: text, tool uses and their outcomes, tool results; every brief as given, never tidied. */
const asMsgs = (rows: readonly SessionMessage[]): Msg[] =>
  rows.map(m => compact({
    role: m.role,
    text: m.text ?? '',
    toolUses: (m.toolUses ?? []).map(u => compact({ tool: u.tool, input: u.input ?? {}, isError: u.isError, agentId: u.agentId, result: u.result })),
    toolResults: m.toolResults,
  }))

/** The scripts of the built-in workflow runs the lead started in the stretch: evidence of how it led, for the reading, never saved. */
function scriptsIn(msgs: readonly Msg[], s: Stretch) {
  const scripts = msgs.slice(s.from, s.to).flatMap(m => (m.role === 'assistant' ? m.toolUses : []))
    .flatMap(u => (u.tool === 'Workflow' && !u.isError && typeof u.input.script === 'string' ? [u.input.script] : []))
  return scripts.join('\n\n') || undefined
}

/** The project's agent files by the type name each gives, subfolders too (as Claude Code finds them); the first file to give a name has it. A file that cannot be read is passed over. */
async function projectTypes($: $, dir: string) {
  const found = new Map<string, string>()
  const folders: [path: string, depth: number][] = [[dir, 0]]
  let files = 0
  while (folders.length && files < AGENT_FILES) {
    const [at, depth] = folders.shift()!
    const entries = (await $.fs.list(at).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const f of entries) {
      const path = `${at}/${f.name}`
      if (f.kind === 'dir' && depth < AGENT_DEPTH) folders.push([path, depth + 1])
      // A symbolic link to an agent file is the file: `$.fs.list` reports a link as `other`, and a read follows it.
      const isFile = f.kind === 'file' || (f.kind === 'other' && f.isLink)
      if (!isFile || !f.name.endsWith('.md') || files++ >= AGENT_FILES) continue
      const text = await $.fs.read(path).catch(() => undefined)
      const name = typeof text === 'string' ? typeName(text) : undefined
      if (name && !found.has(name)) found.set(name, text as string)
    }
  }
  return found
}

/**
 * The project's own types the agents ran as, copied whole, and those whose file Save could not find or
 * read ("type not copied"). Where REDhelm saw a type come from at spawn decides: a project's is looked
 * for in `.claude/agents/`; a person's, a plugin's or a built-in travels by its name only. An agent
 * REDhelm holds no record of (it ran before REDhelm, or its record was let go) is looked for too, and
 * copied only when its file is there.
 */
async function copyTypes($: $, calls: readonly Call[], records: Record<string, Agent>, at: string): Promise<{ types: SavedType[]; notCopied: string[] }> {
  const origins = new Map<string, string | undefined>()
  for (const c of calls) {
    const type = c.input.subagent_type || 'general-purpose'
    const origin = Object.hasOwn(records, c.agentId) ? records[c.agentId]!.origin : undefined
    const was = origins.get(type)
    origins.set(type, was === 'project' ? was : origin ?? was)
  }
  // A plugin's type is named `<plugin>:<name>`, which no project file gives.
  const wanted = [...origins].filter(([type, o]) => o === 'project' || (o === undefined && !type.includes(':'))).map(([type]) => type)
  const files = wanted.length ? await projectTypes($, `${at}/${AGENT_DIR}`) : new Map<string, string>()
  return {
    types: wanted.flatMap(name => (files.has(name) ? [{ name, definition: files.get(name)! }] : [])),
    notCopied: wanted.filter(name => origins.get(name) === 'project' && !files.has(name)),
  }
}

/** What a Save or Earlier read: the draft of the stretch `back` widens to (none without agent work), and what its reading is given. */
type SaveRead = { draft?: Draft; trace: TraceEvent[]; script?: string }

/**
 * The session as Save reads it: the main conversation; REDhelm's records; the own conversation of each
 * top-level agent that started agents (its team), and of each whose record holds no tools (REDhelm did not
 * watch it, or let its record go), for what it used and its team; one it cannot read counting as none; the
 * lead's model and effort from the guard; and the project's types the agents ran as. A run's agent whose
 * record was let go is not among them: only its record names it.
 */
async function readForSave($: $, back: number): Promise<SaveRead> {
  const msgs = asMsgs(await $.session.messages())
  const records = await read($, agents)
  const list = stretches(msgs)
  const s = widen(list, back)
  const calls = [...agentCalls(msgs, s), ...runCalls(msgs, s, records)]
  const recordOf = (id: string) => (Object.hasOwn(records, id) ? records[id] : undefined)
  // Read side by side, kept in the calls' order.
  const owns = await Promise.all(calls.map(async c => {
    const r = recordOf(c.agentId)
    if (r?.parent || (r?.tools && !r.tools.Agent)) return undefined
    const own = await $.session.messages({ agentId: c.agentId }).catch(() => undefined)
    return Array.isArray(own) ? asMsgs(own) : undefined
  }))
  const teams: Record<string, Msg[]> = {}
  const used: Record<string, Used> = {}
  calls.forEach((c, k) => {
    const own = owns[k]
    if (!own) return
    teams[c.agentId] = own
    if (!recordOf(c.agentId)?.tools) used[c.agentId] = usedIn(own)
  })
  const g = await read($, guard)
  const at = root || (await $.session.root())
  const draft = readWorkflow({ msgs, records, teams, used, list, back, root: at, lead: { model: g.model, effort: g.effort } })
  if (!draft) return { trace: [] }
  const theirs = Object.values(teams).flatMap(own => agentCalls(own, { from: 0, to: own.length, led: false }))
  return { draft: { ...draft, ...(await copyTypes($, [...calls, ...theirs], records, at)) }, trace: leadTrace(msgs, s), script: scriptsIn(msgs, s) }
}

/**
 * Save (`back` 0) and Earlier: the sheet at once with what was seen, then the reading, which never holds it up.
 * With Workflow reading off nothing is asked: what was seen is the whole draft. An edit of the draft it replaces ends.
 */
async function startSave($: $, back: number) {
  await leaveEdit($)
  const token = ++sheetToken
  let got: SaveRead
  try {
    got = await readForSave($, back)
  } catch {
    if (token === sheetToken) await update($, workflowSheet, () => ({ mode: 'review' as const, error: "Couldn't read this session", undo: [], token }))
    return
  }
  // A newer Save or Earlier, or the sheet closed, while the session was read.
  if (token !== sheetToken) return
  const { draft, trace, script } = got
  const off = cfg.workflowReading === 'off'
  await update($, workflowSheet, () => ({ mode: 'review' as const, draft: draft && off ? { ...applyReading(draft, undefined, []), read: 'off' as const } : draft, undo: [], token }))
  if (draft && !off) void quietly(() => readLead($, token, draft, trace, script))
}

/**
 * The reading: one call per Save or Earlier, Sonnet at low effort, whatever the labels setting (that is
 * for the dashboard's labels; Workflow reading turns this one off), counted with them. It lands only
 * while the sheet still holds the draft it was asked of, unread; a call that fails or times out leaves
 * the fallbacks and says so.
 */
async function readLead($: $, token: number, asked: Draft, trace: readonly TraceEvent[], script?: string) {
  let reading: Reading | undefined
  try {
    const r = await $.model.complete({ ...READING_CALL, ...readingRequest(asked, trace, script) }, { signal: stopLabels.signal })
    counted(r)
    reading = r.isAnswered ? checkReading(r.text, trace, asked) : undefined
  } catch {}
  await update($, workflowSheet, s =>
    s?.mode === 'review' && s.token === token && s.draft?.read === 'pending' ? { ...s, draft: applyReading(s.draft, reading, trace) } : s)
}

/** Where the library is kept, under the home folder: one file a workflow, beside REDhelm's status lines. */
const LIBRARY = '.claude/redhelm/workflows'

/** Why something failed, for a toast: one line, paths without the home folder, as everything REDhelm shows. */
const failure = (err: unknown) => excerpt(tidy(err instanceof Error ? err.message : String(err)), 80) || 'unknown reason'

/**
 * The library's folder and its `.json` files, each with its text, undefined when it could not be read.
 * A folder not made yet holds none; one that is there but cannot be listed is an error, never taken for empty.
 */
async function libraryFiles($: $) {
  const h = await home($)
  if (!h) throw new Error('no home folder to keep it in')
  const dir = `${h}/${LIBRARY}`
  const entries = await $.fs.list(dir).catch(async (err: unknown) => {
    if (await $.fs.exists(dir).catch(() => true)) throw err
    return []
  })
  const names = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json')).map(f => f.name)
  const files = await Promise.all(names.map(async name => ({ name, text: await $.fs.read(`${dir}/${name}`).then(t => (typeof t === 'string' ? t : undefined), () => undefined) })))
  return { dir, files }
}

/** The draft written to the library: under a name no saved workflow has ("<name> 2"), as a file no file in the folder has, so nothing is overwritten. */
async function writeWorkflow($: $, d: Draft) {
  const { dir, files } = await libraryFiles($)
  const names = files.map(f => f.name)
  const name = uniqueName(d.name.trim() || 'Workflow', listed(files.map(f => ({ name: f.name, text: f.text ?? '' })), d.projectKey).workflows.map(w => w.name))
  const ids = new Set(names.map(n => n.slice(0, -'.json'.length).toLowerCase()))
  const base = slug(name)
  let id = base
  for (let k = 2; ids.has(id); k++) id = `${base}-${k}`
  await $.fs.write(`${dir}/${id}.json`, `${JSON.stringify(toSaved({ ...d, name }, await $.clock.now(), id), null, 2)}\n`)
  return name
}

/**
 * Save on the sheet. Pressed while the reading is out, it keeps what was seen; while an edit applies it
 * waits for you to press it again, so the edit you asked for is never dropped. A write that fails says
 * why and leaves the sheet open. A form with no items is never saved (the sheet offers no Save for either).
 * A library list on show is read again, so it holds what was just saved.
 */
async function keepWorkflow($: $) {
  const s = await read($, workflowSheet)
  if (keeping || s?.mode !== 'review' || !s.draft || s.busy || !itemCount(s.draft)) return
  keeping = true
  let name: string
  try {
    name = await writeWorkflow($, s.draft.read === 'pending' ? applyReading(s.draft, undefined, []) : s.draft)
  } catch (err) {
    $.ui.toast(`Couldn't save · ${failure(err)}`)
    return
  } finally {
    keeping = false
  }
  sheetToken++
  await update($, workflowSheet, cur => (cur?.mode === 'review' && cur.token === s.token ? null : cur))
  await leaveEdit($)
  $.ui.toast(`Saved · ${name}`)
  if (await read($, workflowList)) await listLibrary($, true)
}

/**
 * Cancel, Back, Esc, the panel closing: the sheet goes, a reading or an edit still out is dropped, and an
 * edit of its draft ends with your draft back in the box. A run waiting in the box is the box's, and stays.
 */
async function closeWorkflow($: $) {
  sheetToken++
  await update($, workflowSheet, () => null)
  await leaveEdit($)
}

// Workflows: Edit and Run hold the prompt box the way Reply does, one mode at a time

/**
 * Ends a workflow's mode, as leaveReply ends a reply: what you were writing to Claude comes back, when the
 * box still holds the mark (anything else typed there since is yours). `ends`: which modes this ends.
 */
async function leaveMode($: $, ends: (m: NonNullable<WorkflowMode>) => boolean) {
  const mode = await read($, workflowMode)
  if (!mode || !ends(mode)) return
  await update($, workflowMode, () => null)
  const draft = (await takeDraft($)) ?? ''
  if (marked(await $.prompt.read().then(p => p.text, () => ''), mode)) await $.prompt.fill({ text: draft, mode: 'replace' })
}

const leaveEdit = ($: $) => leaveMode($, m => m.kind === 'edit')

/** An open reply ends before Edit or Run takes the box: its draft goes back into the box, to be kept again. */
async function endReply($: $) {
  if (await read($, composing)) await leaveReply($)
}

/**
 * Edit or Run takes the prompt box: what it holds is kept as your draft (unless it is another mode's
 * mark, whose kept draft is handed on), and `text` goes in. False, with a toast, where there is no box.
 */
async function takeBox($: $, text: string) {
  const mode = await read($, workflowMode)
  const box = await $.prompt.read().then(p => p.text, () => '')
  const filled = await $.prompt.fill({ text, mode: 'replace' }).then(r => r.isFilled, () => false)
  if (!filled) {
    $.ui.toast('Could not reach the prompt')
    return false
  }
  if (!(mode && marked(box, mode)) && box.trim()) await update($, draftKept, () => box)
  return true
}

/** Set while REDhelm closes the bottom bar's Workflows pane for an edit: that close keeps the sheet and the edit. */
let handingKeys = false

/** The bottom bar's Workflows pane, opened as the person asks for it, and again when an edit made from it lands. */
const openWorkflowPane = ($: $) => $.ui.open({ id: WORKFLOW_PANE, title: 'Workflows', focus: true, closeOnEscape: true, rows: 24 }).catch(() => {})

/**
 * Edit: `✎ Workflow: ` in the box. Not while the reading is out: it names the items as they were when it
 * was asked; and never with Workflow reading off, which offers no Edit (a press left from before takes
 * nothing). `pane`: pressed in the bottom bar's Workflows pane, which holds the keys, so REDhelm closes
 * it for them to reach the prompt (as Reply closes the agent sheet) and opens it again once the edit lands.
 */
async function startEdit($: $, pane: boolean) {
  const s = await read($, workflowSheet)
  if (cfg.workflowReading === 'off' || s?.mode !== 'review' || !s.draft || s.draft.read === 'pending') return
  await endReply($)
  if (!(await takeBox($, EDITING))) return
  await update($, workflowMode, (): WorkflowMode => (pane ? { kind: 'edit', pane: true } : { kind: 'edit' }))
  if (!pane) return
  handingKeys = true
  try {
    await $.ui.close({ id: WORKFLOW_PANE })
  } catch {} finally {
    handingKeys = false
  }
}

/** Edits apply one after another: a second ✎ while one applies waits for it, and is asked of the draft it left. */
let editing: Promise<void> = Promise.resolve()
/** Edits asked for and not yet applied: the sheet shows `Applying…` until none is left. */
let edits = 0
/** Moves on at each session start: an edit chain from before it lands nothing and counts nothing when it ends. */
let generation = 0

/**
 * One ✎: the sheet is busy at once (nothing else on it changes until the edits are in), and the change is
 * asked after the edits before it. `pane`: asked from the bottom bar's Workflows pane, which opens again when it lands.
 */
async function queueEdit($: $, token: number, ask: string, pane: boolean) {
  const gen = generation
  await update($, workflowSheet, s => (s?.mode === 'review' && s.token === token ? { ...s, busy: 'applying' as const, error: undefined } : s))
  edits++
  editing = editing.then(() => quietly(async () => {
    try {
      if (await applyEdit($, gen, token, ask) && pane) await openWorkflowPane($)
    } finally {
      if (gen === generation && --edits === 0) await update($, workflowSheet, s => (s?.mode === 'review' && s.busy ? { ...s, busy: undefined } : s))
    }
  }))
}

/** An edit call that failed, timed out, or answered neither ops nor a reason. */
const EDIT_FAILED = "Couldn't apply that edit"

/**
 * The edit call: Sonnet at low effort, answering ops, never a rewritten workflow; counted with the
 * labels. Ops that all pass the checks apply, and the draft before them goes on the Undo stack; one that
 * does not leaves the draft and says why in one line, as a refusal (`cannot`) does. No ops change
 * nothing and leave nothing to undo. It lands only on the sheet it was asked of, in the session it was
 * asked in; whether it landed (applied, refused or failed) is the answer. None is made with Workflow reading off.
 */
async function applyEdit($: $, gen: number, token: number, ask: string) {
  const s = await read($, workflowSheet)
  if (cfg.workflowReading === 'off' || gen !== generation || s?.mode !== 'review' || s.token !== token || !s.draft || s.draft.read === 'pending') return false
  let why: string | undefined
  let ops: readonly Op[] = []
  try {
    const r = await $.model.complete({ ...EDIT_CALL, ...editRequest(s.draft, ask) }, { signal: stopLabels.signal })
    counted(r)
    const answer = r.isAnswered ? parseEdit(r.text) : undefined
    if (!answer) why = EDIT_FAILED
    else if ('cannot' in answer) why = answer.cannot
    else ops = answer.ops
  } catch {
    why = EDIT_FAILED
  }
  let landed = false
  await update($, workflowSheet, cur => {
    if (gen !== generation || cur?.mode !== 'review' || cur.token !== token || !cur.draft) return cur
    landed = true
    const fault = why ?? checkOps(cur.draft, ops)
    if (fault) return { ...cur, error: fault }
    if (!ops.length) return { ...cur, error: undefined }
    return { ...cur, draft: applyOps(cur.draft, ops), undo: [...cur.undo, cur.draft], detail: undefined, error: undefined }
  })
  return landed
}

/** Load: the library listed; pressed again, the list goes. */
async function loadLibrary($: $) {
  if (await read($, workflowList)) await update($, workflowList, () => null)
  else await listLibrary($)
}

/**
 * The library as its folder holds it now, this project's first, then newest. A file that cannot be read
 * counts with those that do not parse; a blank (deleted) one does not. `again`: only a list still on show
 * is replaced, so one put away while the folder was read stays away.
 */
async function listLibrary($: $, again = false) {
  try {
    const { files } = await libraryFiles($)
    const got = listed(files.flatMap(f => (f.text === undefined ? [] : [{ name: f.name, text: f.text }])), projectKey(root || (await $.session.root())))
    await update($, workflowList, cur => (again && !cur ? cur : { ...got, unreadable: got.unreadable + files.filter(f => f.text === undefined).length }))
  } catch (err) {
    $.ui.toast(`Couldn't read the library · ${failure(err)}`)
  }
}

/** A saved workflow's sheet, from the library list. A review sheet it replaces goes, with its reading and any edit of it. */
async function openWorkflow($: $, id: string) {
  sheetToken++
  await leaveEdit($)
  await update($, workflowSheet, () => ({ mode: 'saved' as const, id }))
}

/**
 * Run, before the box is filled: each copied type this project lacks, registered for the session as
 * `redhelm:<name>`, with what of its file stays behind. What is here wins: a type of that name in the
 * project's agent folder (subfolders too) or yours registers nothing, and the plan names it as it is. A
 * file that does not parse or a spec the engine refuses is toasted, and the plan runs it as general-purpose.
 */
async function registerTypes($: $, w: SavedWorkflow) {
  const registered: [string, string][] = []
  const leftBehind: [string, string[]][] = []
  if (w.types.length) {
    const h = await home($)
    const here = new Set([...(await projectTypes($, `${root || (await $.session.root())}/${AGENT_DIR}`)).keys(),
      ...(h ? (await projectTypes($, `${h}/${AGENT_DIR}`)).keys() : [])])
    for (const t of w.types) {
      if (here.has(t.name) || registered.some(([name]) => name === t.name)) continue
      const r = agentSpec(t.definition)
      try {
        if ('error' in r) throw new Error(r.error)
        const { agent } = await $.agent.register({ ...r.spec })
        registered.push([t.name, agent])
        leftBehind.push([t.name, r.leftBehind])
      } catch (err) {
        $.ui.toast(`Couldn't add ${t.name} · ${failure(err)}`)
        registered.push([t.name, 'general-purpose'])
      }
    }
  }
  // Built from entries: a type named like an Object method is still a type.
  return { registered: Object.fromEntries(registered), leftBehind: Object.fromEntries(leftBehind) }
}

/** A Run under way: a second press while it registers and fills is ignored, so its mark is never kept as your draft. */
let running = false

/** Run: copied types registered, then `▶ <name>: ` in the box, where your Enter is the go-ahead. A saved workflow's sheet steps aside for it. */
async function runWorkflow($: $, id: string) {
  if (running) return
  running = true
  try {
    const w = (await read($, workflowList))?.workflows.find(x => x.id === id)
    if (!w) return
    await endReply($)
    const { registered, leftBehind } = await registerTypes($, w)
    if (!(await takeBox($, `▶ ${w.name}: `))) return
    await update($, workflowMode, (): WorkflowMode => ({ kind: 'run', id, name: w.name, registered, leftBehind }))
    await update($, workflowSheet, s => (s?.mode === 'saved' ? null : s))
  } finally {
    running = false
  }
}

/** The workflow a run names: as Load listed it, or read again from its file once the list was put away. */
async function savedFor($: $, id: string) {
  const w = (await read($, workflowList))?.workflows.find(x => x.id === id)
  if (w) return w
  const h = await home($)
  const got = h ? parseSaved(await $.fs.read(`${h}/${LIBRARY}/${id}.json`).catch(() => '')) : undefined
  return got && { ...got, id }
}

/**
 * Delete on a saved workflow's sheet: the first press asks, the second empties its file (the engine has no
 * delete, and Load passes a blank file over). The list loses it, the sheet goes, and a run of it ends.
 */
async function deleteWorkflow($: $, id: string) {
  const s = await read($, workflowSheet)
  if (s?.mode !== 'saved' || s.id !== id) return
  if (!s.armed) {
    await update($, workflowSheet, cur => (cur?.mode === 'saved' && cur.id === id ? { ...cur, armed: true } : cur))
    return
  }
  try {
    const h = await home($)
    if (!h) throw new Error('no home folder')
    await $.fs.write(`${h}/${LIBRARY}/${id}.json`, '')
  } catch (err) {
    $.ui.toast(`Couldn't delete · ${failure(err)}`)
    return
  }
  await update($, workflowList, l => l && { ...l, workflows: l.workflows.filter(w => w.id !== id) })
  await update($, workflowSheet, cur => (cur?.mode === 'saved' && cur.id === id ? null : cur))
  await leaveMode($, m => m.kind === 'run' && m.id === id)
}

// Drawing

/**
 * `inPane`: pressed in REDhelm's own panel, where an agent's sheet is drawn in place with Back.
 * Elsewhere (the bar above the prompt) there is no panel to draw in, so the sheet opens as its own pane.
 */
function actions($: $, inPane = false): Actions {
  const open = () => void $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => {})
  return {
    open,
    inspect: id =>
      void (async () => {
        if (!id) {
          await update($, inspecting, () => null)
          return inPane ? undefined : $.ui.close({ id: SHEET })
        }
        if (inPane) {
          // In place: a second pane would only be a tab behind this one, which Claude Code will not bring forward.
          await update($, briefOpen, () => false)
          await update($, inspecting, () => id)
          return quietly(() => backfill($, id))
        }
        // Opened first, inside the press: Claude Code places a pane the person asked for at any width,
        // while one a plugin opens on its own waits for a wide terminal.
        const opening = $.ui.open({ id: SHEET, title: 'Agent', focus: true, closeOnEscape: true, rows: 24 })
        await update($, briefOpen, () => false)
        await update($, inspecting, () => id)
        await opening
        await quietly(() => backfill($, id))
        await $.ui.open({ id: SHEET, title: await nameOf($, id), closeOnEscape: true, rows: 24 })
      })().catch(() => {}),
    toggleBrief: () => void update($, briefOpen, x => !x),
    compose: id =>
      void (async () => {
        if (!id) return update($, composing, () => null)
        // From the sheet, back to the panel, where "Writing to" shows the way back.
        if ((await $.state.get(INSPECTING)).value === id) {
          await update($, inspecting, () => null)
          if (!inPane) await $.ui.close({ id: SHEET }).catch(() => {})
        }
        // What you were typing to Claude is set aside, never sent to the agent; it comes back after.
        const text = (await $.prompt.read()).text
        const already = text.match(ADDRESS)
        // One mode owns the box: a workflow's edit or run gives way. Its mark is no draft of yours; the draft it kept is handed on.
        const mode = await read($, workflowMode)
        const handle = handles(Object.values((await $.state.get(AGENTS)).value ?? {}))[id] ?? 'agent'
        const { isFilled } = await $.prompt.fill({ text: `→ ${handle}: ${already ? already[2] : ''}`, mode: 'replace' })
        if (isFilled) {
          if (mode) await update($, workflowMode, () => null)
          await update($, composing, () => id)
          if (!already && !(mode && marked(text, mode)) && text.trim()) await update($, draftKept, () => text)
        }
        else $.ui.toast('Could not reach the prompt; type → name: your message')
      })(),
    cancelCompose: () => void quietly(() => leaveReply($)),
    dismiss: agentId => void update($, inbox, list => list.filter(m => m.agentId !== agentId)),
    stop: id =>
      void (async () => {
        const name = await nameOf($, id)
        // Typed narrowly: the full tool.call union is deeper than tsc will instantiate here.
        await ($.tool.call as unknown as (input: { tool: 'TaskStop'; task_id: string }) => Promise<unknown>)({ tool: 'TaskStop', task_id: id })
        await note($, { kind: 'fail', text: `${name} stopped by you`, agentId: id })
      })(),
    toggleDone: () => void update($, showDone, x => !x),
    applySetup: () => void quietly(() => applySetup($)),
    skipSetup: () => void quietly(() => skipSetup($)),
    update: () => void quietly(async () => $.ui.toast(await updateNow($))),
    wfSave: () => void quietly(() => startSave($, 0)),
    wfEarlier: () => void quietly(async () => {
      const s = await read($, workflowSheet)
      // An edit applying would land on nothing: Earlier waits for it, as Save, Undo and Save as do.
      if (s?.mode === 'review' && s.draft?.more && !s.busy) await startSave($, s.draft.back + 1)
    }),
    // An edit applying was asked of the form shown: the form waits for it.
    wfForm: form => void quietly(() => update($, workflowSheet, s => (s?.mode === 'review' && s.draft && !s.busy ? { ...s, draft: { ...s.draft, form }, detail: undefined } : s))),
    wfDetail: d => void quietly(() => update($, workflowSheet, s => (s ? { ...s, detail: d ?? undefined } : s))),
    wfRemove: item => void quietly(() => update($, workflowSheet, s => {
      // Nothing is removed while the reading is out (it names the agents and roles as they were when it was asked)
      // or an edit applies, and the last item stays: a workflow of none is never saved.
      if (s?.mode !== 'review' || !s.draft || s.draft.read === 'pending' || s.busy || itemCount(s.draft) <= 1) return s
      const next = applyOps(s.draft, [{ op: 'remove', item }])
      return next === s.draft ? s : { ...s, draft: next, undo: [...s.undo, s.draft], detail: undefined, error: undefined }
    })),
    wfKeep: () => void quietly(() => keepWorkflow($)),
    wfClose: () => void quietly(() => closeWorkflow($)),
    // Opened inside the press, as the agent sheet is: a pane the person asked for is placed at any width.
    wfBar: () => void openWorkflowPane($),
    // Off the panel, Edit is pressed in the bottom bar's Workflows pane: the one other place the review sheet draws.
    wfEdit: () => void quietly(() => startEdit($, !inPane)),
    wfUndo: () => void quietly(() => update($, workflowSheet, s => {
      if (s?.mode !== 'review' || !s.draft || s.draft.read === 'pending' || s.busy || !s.undo.length) return s
      return { ...s, draft: s.undo[s.undo.length - 1]!, undo: s.undo.slice(0, -1), detail: undefined, error: undefined }
    })),
    wfLoad: () => void quietly(() => loadLibrary($)),
    wfOpen: id => void quietly(() => openWorkflow($, id)),
    wfRun: id => void quietly(() => runWorkflow($, id)),
    wfDelete: id => void quietly(() => deleteWorkflow($, id)),
  }
}

/**
 * The surface's elements: Input only where the surface takes typing (mobile does not), the Raster
 * only on the terminal and Svg everywhere else. A table names every element on every surface, and
 * one the surface lacks draws nothing, so the choice is made here, by surface.
 */
const elements = (table: unknown, surface: string): Els => {
  const els = table as Els
  return surface === 'terminal'
    ? { ...els, Svg: undefined }
    : { ...els, Raster: undefined, Input: surface === 'mobile' ? undefined : els.Input }
}

async function view($: $, site?: string): Promise<View> {
  // A site drawn again starts its list of Rasters afresh: the frame loop repaints only what this drawing holds.
  const mounted = new Map<string, TraceSpec>()
  if (site) sites.set(site, mounted)
  const list = await read($, spaces)
  const all = Object.values(await read($, agents)).sort((a, b) => a.startedAt - b.startedAt)
  const hs = handles(all)
  // Agents sharing a name are told apart on screen exactly as in their address.
  const tagged = Object.fromEntries(all.filter(a => hs[a.id] !== handleOf(a)).map(a => [a.id, capital(hs[a.id]!)]))
  return {
    now: await read($, now),
    agents: all,
    handles: hs,
    notes: await read($, notes),
    inbox: await read($, inbox),
    workspaces: list,
    guard: await read($, guard),
    inspecting: await read($, inspecting),
    briefOpen: await read($, briefOpen),
    theme,
    composing: await read($, composing),
    setup: await read($, setup),
    showDone: await read($, showDone),
    aside: (await read($, draftKept)) !== null,
    release: await read($, release),
    root,
    lanes: { ...tagged, ...laneNames(list) },
    traces: Object.fromEntries(traces),
    bursts: Object.fromEntries(bursts),
    at: await $.clock.now(),
    motion: cfg.motion === 'on',
    reading: cfg.workflowReading === 'sonnet',
    mount: site ? (key, spec) => void mounted.set(key, spec) : undefined,
    workflow: await read($, workflowSheet),
    library: await read($, workflowList),
  }
}

/**
 * An agent's response, passed on piece by piece and timed from its first piece (a thinking block's
 * start counts: its tokens do) to its stop, less any time the API spent running its own tools.
 * The clock is read without waiting on it, so nothing streams slower.
 */
async function* timed($: $, agentId: string, stream: HookStream<TurnStepChunk, TurnStepResult>) {
  let first: Promise<number> | undefined
  let stop: Promise<number> | undefined
  for await (const chunk of stream) {
    first ??= $.clock.now()
    if (chunk.kind === 'stop') stop ??= $.clock.now()
    yield chunk
  }
  const result = await stream.result
  await quietly(async () => {
    const tokens = result.usage?.output_tokens ?? 0
    if (!tokens || !first || !stop) return
    const [from, to] = await Promise.all([first, stop])
    const aside = (result.serverToolUses ?? []).reduce((n, u) => n + (u.endedAt === undefined ? 0 : Math.max(0, u.endedAt - u.startedAt)), 0)
    const ms = to - from - aside
    if (ms > 0) bursts.set(agentId, burst(bursts.get(agentId) ?? [], { at: to, tokens, ms }))
  })
  return result
}

async function show($: $) {
  if (!cfg.autoOpen || autoOpened || (await $.state.get(PLACEMENT)).value === 'bottom') return
  autoOpened = true
  void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
}

export const register: Register = (on, options) => {
  cfg = settings(options as Record<string, unknown>)
  let timers: { cancel: () => void }[] = []

  on('session.start', async ($, e, next) => {
    active = e.isInteractive
    if (!active) return next(e)
    hasPython = undefined
    answeredAt.clear()
    traces.clear()
    bursts.clear()
    sites.clear()
    ripples.length = 0
    backdropSite = undefined
    frames?.cancel()
    frames = undefined
    visible = false
    stopLabels = new AbortController()
    Object.assign(spent, { calls: 0, input: 0, output: 0 })
    editing = Promise.resolve()
    edits = 0
    generation++
    running = false
    // An edit still out when the last session ended never lands: the sheet is not left busy for it.
    await quietly(() => update($, workflowSheet, s => (s?.mode === 'review' && s.busy ? { ...s, busy: undefined } : s)))
    shownStatus = null
    root = await $.session.root()
    homeDir = await home($).catch(() => '')
    await update($, placement, () => cfg.placement)
    await $.command.register({
      name: 'redhelm',
      description: 'Your agents, their work and what needs you',
      argumentHint: 'right | bottom | setup | models | update',
    })
    timers.forEach(t => t.cancel())
    timers = [
      $.clock.every(1500, () => void quietly(() => sync($))),
      $.clock.every(5000, () => void quietly(() => refresh($))),
      $.clock.every(CHECK_EVERY, () => void quietly(() => checkRelease($))),
      $.clock.every(1000, () => void quietly(() => tick($))),
    ]
    $.clock.after(2000, () => void quietly(() => checkRelease($)))
    void quietly(async () => {
      const items = await setupItems($)
      await update($, setup, () => items)
      await refresh($)
      const ws = (await $.state.get(WORKSPACES)).value ?? []
      if (ws.length || ((await $.state.get(SETUP)).value ?? []).length) await show($)
    })
    void quietly(() => keepLines($))
    return next(e)
  })

  on('session.end', ($, e, next) => {
    stopLabels.abort()
    frames?.cancel()
    frames = undefined
    timers.forEach(t => t.cancel())
    timers = []
    return next(e)
  })

  on('command.run', { command: 'redhelm' }, async ($, e) => {
    autoOpened = true
    const arg = e.args.trim().toLowerCase()
    if (arg === 'models') return { text: await modelsReport($) }
    if (arg === 'update') {
      if (!(await read($, release))) await quietly(() => checkRelease($))
      return { text: await updateNow($) }
    }
    if (arg === 'setup') {
      const items = await setupItems($, true)
      await update($, setup, () => items)
      if (!items.length) return { text: 'Claude Code already has every REDhelm setting' }
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
      return { text: `REDhelm setup: ${items.length} ${items.length === 1 ? 'setting' : 'settings'} to review` }
    }
    if (arg === 'right' || arg === 'bottom') {
      // Saved as the person's REDhelm setting, the same row /config shows.
      await quietly(async () => {
        const row = (await $.config.list()).find(r => /^redhelm(@inline)?\.placement$/.test(r.key))
        if (row) await $.config.set({ key: row.key, value: arg } as Parameters<$['config']['set']>[0])
      })
      await update($, placement, () => arg)
      await update($, collapsed, () => false)
      if (arg === 'bottom') await $.ui.close({ id: PANE })
      else await $.ui.open({ id: PANE, title: TITLE, focus: true })
      return { text: `REDhelm now lives ${arg === 'right' ? 'on the right' : 'at the bottom'}` }
    }
    if ((await $.state.get(PLACEMENT)).value === 'bottom') {
      const folded = await update($, collapsed, c => !c)
      return { text: folded ? 'REDhelm folded' : 'REDhelm open' }
    }
    const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
    if (shown) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: shown ? 'REDhelm closed' : 'REDhelm open' }
  })

  /** The guard at the door: a prompt waits while the model is not the one chosen, and once when the session fell behind. */
  on('prompt.submit', async ($, e, next) => {
    if (!active) return next(e)
    /** The guard: why a prompt for Claude waits, or undefined to let it in. */
    const held = async () => {
      if (cfg.guard !== 'hold') return undefined
      const g = (await $.state.get(GUARD)).value ?? {}
      if (g.fallback) return `REDhelm: this session switched models on its own (${g.fallback}). Run /model to choose, then send again.`
      if (g.stale && staleTold !== g.stale) {
        staleTold = g.stale
        return `REDhelm: this session runs ${short(g.model)}, but your default is now ${short(g.stale)}. Send again to keep ${short(g.model)}, or /model to switch.`
      }
      return undefined
    }
    // A workflow's mode owns the box: only a prompt you typed there answers it, never a notification or a peer's message.
    const typed = !e.isMeta && !BACKGROUND.has(e.origin?.kind ?? '')
    const mode = typed ? await read($, workflowMode) : null
    // ✎ edits the open draft and never reaches Claude; the change applies off this hook.
    const edit = typed ? EDIT_MARK.exec(e.text) : null
    // With Workflow reading off no edit is asked: a ✎ mode left from before ends, your draft back, and ✎ text is
    // still never Claude's while the review sheet is open.
    if (edit && cfg.workflowReading === 'off' && (mode?.kind === 'edit' || (await read($, workflowSheet))?.mode === 'review')) {
      if (mode?.kind === 'edit') await quietly(async () => {
        await update($, workflowMode, () => null)
        fillBack($, (await takeDraft($)) ?? '')
      })
      return { drop: 'REDhelm: Edit is off · Workflow reading is off in /config' }
    }
    if (edit && mode?.kind === 'edit') {
      const ask = (edit[1] ?? '').trim()
      // The mode stays, and Claude Code keeps the dropped text: the change can still be typed.
      if (!ask) return { drop: 'REDhelm: nothing to change' }
      await quietly(async () => {
        await update($, workflowMode, () => null)
        // Claude Code keeps a dropped prompt's text: what you were writing to Claude goes back once it has.
        fillBack($, (await takeDraft($)) ?? '')
        const s = await read($, workflowSheet)
        if (s?.mode === 'review') await queueEdit($, s.token, ask, mode.pane === true)
      })
      return { drop: '✎ Workflow: applying' }
    }
    // ✎ text while an edit is still out, or the review sheet is open, is never Claude's: for the 100 ms before your
    // draft comes back the box still holds the edit just sent, and an Enter there must not send it on. Typed by
    // hand with no edit out, nothing applies it: Edit is how one starts.
    if (edit && edits > 0) return { drop: '✎ Workflow: applying' }
    if (edit && (await read($, workflowSheet))?.mode === 'review') return { drop: 'REDhelm: press Edit first' }
    // ▶ runs the saved workflow Run chose: your notes as the prompt, the workflow as a plan written out under them.
    // Nothing goes in `context`, which you never see: the conversation shows everything Claude got.
    const notes = mode?.kind === 'run' ? runNotes(e.text, mode.name) : undefined
    if (mode?.kind === 'run' && notes !== undefined) {
      const w = await savedFor($, mode.id)
      const why = w ? await held() : undefined
      // Held by the guard, the run waits for you to send it again.
      if (why) return { drop: why }
      await update($, workflowMode, () => null)
      const draft = await takeDraft($)
      if (draft !== null) fillBack($, draft)
      if (!w) return { drop: `REDhelm: couldn't read "${mode.name}" · Load it and press Run again` }
      return next({ ...e, text: runText(mode.name, notes, planText(w, mode.registered, mode.leftBehind)) })
    }
    // A prompt addressed "→ name: …" goes to that agent instead of Claude.
    const address = e.text.match(ADDRESS)
    const to = address && (await agentNamed($, address[1]!))
    if (address && to) {
      // Reply takes the box from a workflow's mode, whose mark was replaced by the address.
      if (mode) await update($, workflowMode, () => null)
      const name = address[1]!.trim()
      const text = address[2]!.trim()
      if (!text) return { drop: `REDhelm: nothing to send to ${name}` }
      // Said as yours: the agent then reports your answer as yours, not as Claude's.
      const { isDelivered, reason } = await $.session.send({ to: { agentId: to }, text: `From the user (via REDhelm): ${text}` })
      await update($, composing, () => null)
      if (!isDelivered) return { drop: `REDhelm: not delivered to ${name} (${reason ?? 'unknown reason'})` }
      await update($, inbox, list => list.filter(m => m.agentId !== to))
      await note($, { kind: 'reply', text: `you → ${name}: ${excerpt(text, 60)}`, agentId: to })
      // Claude Code keeps a dropped prompt's text: put back what you were writing to Claude, or nothing.
      fillBack($, (await takeDraft($)) ?? '')
      return { drop: `→ ${name}: sent` }
    }
    // Bound for Claude: the guard first. Held, nothing changes: Claude Code keeps the prompt in the box for you to send
    // again, and an open reply or workflow mode stays open, its draft still kept.
    const why = await held()
    if (why) return { drop: why }
    // A prompt you typed to Claude while a reply or a workflow's mode was open (its mark was deleted): it is over.
    // A notification or a peer's message is not yours: an open reply stays, and its kept draft is not put back over it.
    const replyOver = typed && !address && !!(await $.state.get(COMPOSING)).value
    if (replyOver || mode) {
      const draft = await takeDraft($)
      if (replyOver) await update($, composing, () => null)
      if (mode) await update($, workflowMode, () => null)
      // The draft set aside still comes back, once Claude Code has taken this prompt.
      if (draft !== null) fillBack($, draft)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (active && id) {
      await quietly(async () => {
        await patch($, id, () => ({
          model: r.model, type: e.subagentType, name: e.name ?? '', description: e.description, status: 'running',
          brief: tidy(e.prompt).slice(0, 2000),
          // Every spawn names its provider; a host that left it out still gets the rest of the record.
          run: e.workflow?.runId, parent: e.parentAgentId, teammate: e.isTeammate === true, origin: e.provider?.plugin,
        }))
        await note($, { kind: 'spawn', text: `${e.name || e.description}  ${short(r.model)}`, agentId: id })
        await show($)
      })
    }
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('turn.step', async function* ($, e, next) {
    if (!active) return yield* next(e)
    const result = e.agentId ? yield* timed($, e.agentId, next(e)) : yield* next(e)
    await quietly(async () => {
      const u = result.usage
      const context = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
      const effort = e.effort === undefined ? undefined : String(e.effort)
      await update($, usage, all => {
        const m = base(e.model)
        const row = all[m] ?? { requests: 0, output: 0, agents: 0 }
        return { ...all, [m]: { requests: row.requests + 1, output: row.output + (u?.output_tokens ?? 0), agents: row.agents + (e.agentId ? 1 : 0) } }
      })
      if (e.agentId) {
        if (!(await ourAgent($, e.agentId))) return
        const said = excerpt(tidy(result.answer), 300)
        return patch($, e.agentId, a => ({ model: e.model, effort: effort ?? a.effort, context: context || a.context, thinking: said || a.thinking }))
      }
      chosen ??= e.model
      const switched = cfg.guard !== 'off' && base(e.model) !== base(chosen) ? `${short(chosen)} → ${short(e.model)}` : undefined
      const before = (await $.state.get(GUARD)).value ?? {}
      await update($, guard, g => ({ ...g, model: e.model, effort: effort ?? g.effort, fallback: switched ?? g.fallback }))
      if (switched && before.fallback !== switched) {
        await note($, { kind: 'guard', text: `answered by ${short(e.model)}, not ${short(chosen)}` })
        $.ui.toast(`✕ ${short(e.model)} answered instead of ${short(chosen)}`)
      }
      if (before.model !== e.model) await checkStale($)
      else await status($)
    })
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (!active) return next(e)
    const id = e.agentId
    if (!id) {
      const g = (await $.state.get(GUARD)).value ?? {}
      return g.fallback && cfg.guard === 'hold'
        ? { deny: `REDhelm: held because the session switched models on its own (${g.fallback}). Ask the person to run /model.` }
        : next(e)
    }
    if (!(await ourAgent($, id))) return next(e)
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    traces.set(id, record(traces.get(id) ?? [], now))
    ripples.push({ agentId: id, at: now })
    if (ripples.length > 40) ripples.splice(0, ripples.length - 40)
    if (visible && !frames) void quietly(() => pace($))
    await quietly(() => {
      const file = changedFile(e.tool, input)
      const path = file && relative(file, root)
      const key = toolKey(e.tool)
      return patch($, id, a => ({
        waitingOn: undefined,
        steps: [{ text: activity(e.tool, input), at: now }, ...(a.steps ?? [])].slice(0, 8),
        activity: activity(e.tool, input),
        recent: [...a.recent, kindOf(e.tool)].slice(-8),
        ...(path && { files: [...a.files.filter(f => f !== path), path].slice(-30), edits: a.edits + 1 }),
        tools: { ...a.tools, [key]: (a.tools?.[key] ?? 0) + 1 },
        ...(e.tool === 'Skill' && e.skill && !a.skills?.includes(e.skill) && { skills: [...(a.skills ?? []), e.skill] }),
      }))
    })
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true && kindOf(e.tool) === 'checking') {
      await quietly(() => patch($, id, a => ({ fails: a.fails + 1 })))
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!active) return r
    const id = e.agentId
    await quietly(async () => {
      if (!id) {
        if (cfg.notifyAfter > 0 && e.durationMs >= cfg.notifyAfter * 1000) {
          const project = root.split(/[\\/]/).filter(Boolean).pop() ?? 'Claude Code'
          await notify($, `Claude Code · ${project}`, `Finished after ${span(e.durationMs)}`, excerpt(e.answer, 140) || 'Turn finished')
        }
        return
      }
      if (!(await ourAgent($, id))) return
      const failed = e.reason === 'error' || e.reason === 'refusal'
      // A turn can end while work the agent started still runs (Claude Code lists it as waiting): not finished yet.
      const held = (await $.agent.list()).find(i => i.id === id)
      if (held && LIVE.has(held.status) && !e.isAborted && !failed) return patch($, id, () => ({ answer: excerpt(tidy(e.answer), 160), activity: undefined }))
      const at = await $.clock.now()
      await patch($, id, () => ({
        answer: excerpt(tidy(e.answer), 160), endedAt: at,
        status: e.isAborted ? 'killed' : failed ? 'failed' : 'completed', activity: undefined,
      }))
      await announce($, id, failed, e.answer)
    })
    return r
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    const from = e.agentId
    // The main conversation writing to an agent that asked something: Claude answered it, so it no longer waits on you.
    if (active && !from && r.isDelivered) await quietly(async () => {
      const to = (await $.agent.list()).find(p => p.id === e.to || p.name === e.to || p.teammateId === e.to)?.id ?? (await agentNamed($, e.to))
      if (!to) return
      answeredAt.set(to, await $.clock.now())
      if (!(await read($, inbox)).some(m => m.agentId === to)) return
      await update($, inbox, list => list.filter(m => m.agentId !== to))
      if (e.origin.kind === 'model') await note($, { kind: 'reply', text: `Claude → ${await nameOf($, to)}: ${excerpt(tidy(e.text), 60)}`, agentId: to })
    })
    if (active && from && r.isDelivered) await quietly(async () => {
      const peers = await $.agent.list()
      const peer = peers.find(p => p.id === e.to || p.name === e.to || p.teammateId === e.to)
      if (peer) await patch($, from, () => ({ waitingOn: peer.name || excerpt(peer.description, 24) || 'another agent' }))
      // Telling a question from a report takes a model call: the agent's send is not held for it.
      if (!peer) void quietly(() => received($, from, e.text))
    })
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  /** Every model change: the person's choice resets the guard; Claude Code's own (auto) trips it. All are logged. */
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    if (!active) return r
    await quietly(async () => {
      const auto = e.source === 'auto'
      if (!auto) chosen = e.to_model
      const fallback = auto && cfg.guard !== 'off' ? `${short(e.from_model)} → ${short(e.to_model)}` : undefined
      await update($, guard, g => ({ ...g, model: e.to_model, fallback }))
      const at = await $.clock.now()
      const log = ((await $.store.get('switches')) ?? []) as unknown[]
      await $.store.set('switches', [...log, { at, from: e.from_model, to: e.to_model, source: e.source }].slice(-100))
      if (fallback) {
        await note($, { kind: 'guard', text: `Claude Code switched models: ${fallback}` })
        $.ui.toast(`✕ Model switched on its own: ${fallback}`)
      }
      await checkStale($)
    })
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = elements($.ui.resolve(e), e.surface)
    const v = await view($, e.requestId)
    const act = actions($, true)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    // The backdrop: the docked sidebar on the terminal, where a Raster can fill the pane.
    const fielded = e.surface === 'terminal' && e.props.placement === 'dock' && cfg.backdrop !== 'none'
    if (fielded) v.field = hex(PALETTES[theme].bg)
    // A workflow's sheet, and an agent's, take the panel's place until Back: on the backdrop's colour, without its pattern.
    if (v.workflow) {
      backdropSite = undefined
      return <Backdropped els={els} v={v} columns={columns} rows={rows}><WorkflowSheet els={els} v={v} act={act} columns={columns} back={act.wfClose} /></Backdropped>
    }
    if (v.inspecting) {
      backdropSite = undefined
      return <Backdropped els={els} v={v} columns={columns} rows={rows}><Sheet els={els} v={v} act={act} columns={columns} back={() => act.inspect(null)} /></Backdropped>
    }
    const cells = fielded ? await backdropCells($, await $.clock.now(), columns, rows) : undefined
    backdropSite = fielded ? { requestId: e.requestId, columns, rows, sent: cells } : undefined
    return (
      <Backdropped els={els} v={v} backdrop={cells} columns={columns} rows={rows}>
        <Panel
          els={els}
          v={v}
          act={act}
          shape={{ kind: e.props.placement === 'dock' ? 'tall' : 'wide', columns, rows: e.viewport?.rows ?? 12, classic: e.surface === 'terminal' && e.viewport?.isFullscreen === false }}
        />
      </Backdropped>
    )
  })

  /** The sheet closed by the person (Esc, its ✕) or by REDhelm: no agent is open any more, so its Details comes back. */
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    // The panel closing takes its sheet with it; reopened, it shows your agents.
    if (e.id === SHEET || e.id === PANE) await quietly(() => update($, inspecting, () => null))
    // The panel, or the bottom bar's Workflows pane, closing takes the workflow sheet with it, and an edit of its draft;
    // not when REDhelm closed the Workflows pane itself for an edit, to hand the keys to the prompt.
    const forEdit = e.id === WORKFLOW_PANE && handingKeys && e.origin?.kind !== 'person'
    if ((e.id === PANE || e.id === WORKFLOW_PANE) && !forEdit) await quietly(() => closeWorkflow($))
    return r
  }).catch(($, e, next) => next(e)) // fail open: an error in REDhelm never holds your work

  on('ui.render', { component: 'Pane', requestId: SHEET }, async ($, e) => (
    <Sheet els={elements($.ui.resolve(e), e.surface)} v={await view($, e.requestId)} act={actions($)} columns={e.props.bodyColumns} />
  ))

  /** The bottom bar's Workflows: Save and Load, and the sheet a Save opens, with Back to them. */
  on('ui.render', { component: 'Pane', requestId: WORKFLOW_PANE }, async ($, e) => {
    const els = elements($.ui.resolve(e), e.surface)
    const v = await view($, e.requestId)
    const act = actions($)
    return v.workflow
      ? <WorkflowSheet els={els} v={v} act={act} columns={e.props.bodyColumns} back={act.wfClose} />
      : <WorkflowsSection els={els} v={v} act={act} columns={e.props.bodyColumns} />
  })

  /** Above the prompt: the whole rack in bottom placement, otherwise only a pulled-out strip. */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!active || e.props.hasSurvey) return next(e)
    // One REDhelm on screen: while the pane is open, the band steps aside.
    const paneShown = await $.ui.panes().then(ps => ps.some(p => p.id === PANE && p.isShown), () => false)
    if (paneShown) return next(e)
    const els = elements($.ui.resolve(e), e.surface)
    const v = await view($, e.requestId)
    const act = actions($)
    if ((await read($, placement)) === 'bottom' && !(await read($, collapsed))) {
      return <Panel els={els} v={v} act={act} shape={{ kind: 'wide', columns: e.props.bodyColumns, rows: Math.min(e.props.maxRows, 6), rule: true, classic: e.viewport?.isFullscreen === false }} />
    }
    return Alert({ els, v, act }) ?? next(e)
  })
}
