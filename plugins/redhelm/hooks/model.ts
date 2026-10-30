import type { Agent, Lane, Phase, Placement, Run, StageRow } from '../types'

// The person's REDhelm settings (/config rows from the manifest's userConfig), defaults filled in

export type Settings = {
  placement: Placement
  statusLine: 'problems' | 'always' | 'off'
  guard: 'hold' | 'warn' | 'off'
  notifyAfter: number
  autoOpen: boolean
  agentToasts: boolean
  /** Traces that move and a question's edge that flashes; off, everything stays still between redraws. */
  motion: 'on' | 'off'
  /** Headlines and question titles from the small model, or REDhelm's plain words only. */
  labels: 'haiku' | 'plain'
  /** A Save's reading and Edit, from Claude Code's Sonnet; off, Save keeps only what it saw and Edit is not offered. */
  workflowReading: 'sonnet' | 'off'
  /** What REDhelm draws behind itself in the sidebar (terminal): see hooks/backdrop.ts. */
  backdrop: 'ripples' | 'lattice' | 'field' | 'ember' | 'none'
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T) =>
  allowed.includes(value as T) ? (value as T) : fallback

export const settings = (o: Record<string, unknown> = {}): Settings => ({
  placement: pick(o.placement, ['right', 'bottom'] as const, 'right'),
  statusLine: pick(o.statusLine, ['problems', 'always', 'off'] as const, 'off'),
  guard: pick(o.guard, ['hold', 'warn', 'off'] as const, 'hold'),
  notifyAfter: typeof o.notifyAfter === 'number' && o.notifyAfter >= 0 ? o.notifyAfter : 120,
  autoOpen: o.autoOpen !== false,
  agentToasts: o.agentToasts !== false,
  motion: pick(o.motion, ['on', 'off'] as const, 'on'),
  labels: pick(o.labels, ['haiku', 'plain'] as const, 'haiku'),
  workflowReading: pick(o.workflowReading, ['sonnet', 'off'] as const, 'sonnet'),
  backdrop: pick(o.backdrop, ['ripples', 'lattice', 'field', 'ember', 'none'] as const, 'ripples'),
})

/**
 * The desktop's light or dark appearance. macOS stores a key only when dark (absent, `defaults`
 * exits 1: light); GNOME says 'prefer-dark', 'prefer-light' or 'default'. Unknown: dark.
 */
export async function appearance(ask: (argv: string[]) => Promise<{ exitCode: number; stdout: string } | undefined>): Promise<'light' | 'dark'> {
  const mac = await ask(['defaults', 'read', '-g', 'AppleInterfaceStyle'])
  if (mac?.exitCode === 0) return /dark/i.test(mac.stdout) ? 'dark' : 'light'
  if (mac?.exitCode === 1) return 'light'
  const gnome = await ask(['gsettings', 'get', 'org.gnome.desktop.interface', 'color-scheme'])
  if (gnome?.exitCode === 0) return /dark/i.test(gnome.stdout) ? 'dark' : 'light'
  return 'dark'
}

// Models: the same rules as ~/.claude/model-guard/mg_common.py

export const base = (model = '') => (model.split('[')[0] ?? '').replace(/-\d{8}$/, '')

const parts = (model?: string) => base(model).split('-')

export const family = (model?: string) => parts(model)[1] ?? ''

const version = (model?: string) => parts(model).slice(2).filter(p => /^\d+$/.test(p)).map(Number)

export const newer = (a: string, b: string) => {
  const [x, y] = [version(a), version(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** Another version of the same family: Opus 5 while the default is Opus 5.5. */
export const isStale = (actual?: string, wanted?: string) =>
  !!actual && !!wanted && family(actual) === family(wanted) && base(actual) !== base(wanted)

/** claude-opus-5-5[1m] → Opus 5.5 */
export const short = (model?: string) => {
  if (!model?.startsWith('claude-')) return model ?? ''
  const [, name = '', ...rest] = parts(model)
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${rest.filter(p => /^\d+$/.test(p)).join('.')}`.trim()
}

/** The newest version of each family seen so far, so a picker alias ("opus") resolves to a version. */
export const remember = (seen: Record<string, string>, model?: string) => {
  if (!model?.startsWith('claude-')) return seen
  const fam = family(model)
  const cur = seen[fam]
  return cur && !newer(model, cur) ? seen : { ...seen, [fam]: base(model) }
}

/** The default this session has fallen behind, if any: the saved model (alias resolved), or a newer one seen since. */
export const staleTarget = (model: string, wanted: string | undefined, seen: Record<string, string>) => {
  if (!wanted) return undefined
  const resolved = wanted.startsWith('claude-') ? wanted : seen[wanted]
  if (!resolved) return undefined
  const newest = seen[family(resolved)]
  const target = newest && newer(newest, resolved) ? newest : resolved
  return isStale(model, target) ? base(target) : undefined
}

// The Claude Code settings REDhelm brings, as /config rows (applied only when the person presses Apply)

export type Default = { key: string; label: string; want: (options?: readonly string[]) => string | boolean | undefined }

export const DEFAULTS: Default[] = [
  { key: 'switchModelsOnFlag', label: 'Pause instead of switching models when safeguards flag a message', want: o => o?.find(x => !/switch/i.test(x)) },
  { key: 'turnDuration', label: 'Show how long each turn took', want: () => true },
  { key: 'timestamps', label: 'Timestamp every message', want: () => true },
  { key: 'inputNeededNotifEnabled', label: 'Push to your phone when a question is waiting', want: () => true },
]

/** The status lines REDhelm ships (statusline/ in its folder), written into settings.json: no /config row exists for them. */
export const LINES = [
  { key: 'statusLine', script: 'statusline.py', label: 'Show the model that actually answers, with its effort, under the prompt' },
  { key: 'subagentStatusLine', script: 'agents.py', label: "Show each agent's model and effort in Claude Code's agent panel" },
] as const

// States and plain words: a glyph says what state an agent is in, a few words what it is on

/** Live, but no action for this long: quiet. */
const QUIET_MS = 15 * 60_000

export type State = 'working' | 'quiet' | 'waiting' | 'asks' | 'done' | 'failed'

/** An agent's state: `asks` when it has a question for you, else from its status and its last action. */
export function stateOf(a: Agent, now: number, asks = false): State {
  if (asks) return 'asks'
  if (a.status === 'completed') return 'done'
  if (a.status === 'failed' || a.status === 'killed') return 'failed'
  if (a.waitingOn || a.status === 'waiting') return 'waiting'
  const last = a.steps?.[0]?.at
  if (a.status === 'idle' || (last !== undefined && now - last > QUIET_MS)) return 'quiet'
  return 'working'
}

/** "now", "12s", "3m", "1h", "2d": a time column, never wider than five. */
export const age = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** What an agent is on, in plain words: its current action, what it waits on, or its last words once it ended. */
export function plainHeadline(a: Agent, now: number): string {
  const state = stateOf(a, now)
  if (state === 'waiting') return a.waitingOn ? `Waiting for ${capital(a.waitingOn)}` : 'Waiting on work it started'
  if (state === 'quiet') {
    const last = a.steps?.[0]?.at
    return last === undefined ? 'Idle' : `No action for ${age(now - last)}`
  }
  if (state === 'done' || state === 'failed') {
    return excerpt(a.answer, 120) || (a.status === 'killed' ? 'Stopped' : state === 'failed' ? 'Failed' : 'Finished')
  }
  return a.activity || a.steps?.[0]?.text || 'Getting started'
}

/** The model's headline while the agent works; the plain words in every other state, and until one arrives. */
export const headlineOf = (a: Agent, now: number) =>
  (stateOf(a, now) === 'working' && a.headline) || plainHeadline(a, now)

/** A question in a line: its first sentence that asks, else its first sentence. */
export function firstAsk(text: string, size = 90) {
  const line = excerpt(text, 2000)
  const sentences = line.match(/[^.?!]+[.?!]*/g)?.map(x => x.trim()).filter(Boolean) ?? [line]
  return excerpt(sentences.find(x => x.endsWith('?')) ?? sentences[0] ?? line, size)
}

const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra-high', max: 'maximum' }

/** "Opus 5.5 · extra-high effort" */
export const modelWords = (model?: string, effort?: string) =>
  [short(model), effort && `${EFFORT[effort] ?? effort} effort`].filter(Boolean).join(' · ')

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The name an address uses: the agent's own name, else the first words of its task, with no
 * colon or ellipsis in it, so "→ handle: message" always reads back to the same agent.
 */
export const handleOf = (a?: Agent) => {
  const words = (a?.name || a?.description || (a ? `agent ${a.id.slice(0, 4)}` : 'agent')).replace(/[:\n…]+/g, ' ').trim().split(/\s+/)
  let out = words[0]!.slice(0, 24)
  for (const w of words.slice(1)) {
    if (`${out} ${w}`.length > 24) break
    out = `${out} ${w}`
  }
  return out
}

/** Every agent's address, kept unique: a second "asker" becomes "asker aee7". */
export const handles = (agents: Agent[]) => {
  const isLive = (a: Agent) => a.status === 'running' || a.status === 'waiting' || a.status === 'pending'
  const key = (a: Agent) => handleOf(a).toLowerCase()
  const all = new Map<string, number>()
  const live = new Map<string, number>()
  for (const a of agents) {
    all.set(key(a), (all.get(key(a)) ?? 0) + 1)
    if (isLive(a)) live.set(key(a), (live.get(key(a)) ?? 0) + 1)
  }
  // A name stays plain for the one live agent that has it; finished namesakes, or live twins, get a tag.
  return Object.fromEntries(agents.map(a => {
    const h = handleOf(a)
    const tagged = all.get(key(a))! > 1 && (!isLive(a) || live.get(key(a))! > 1)
    return [a.id, tagged ? `${h} ${a.id.slice(0, 4)}` : h]
  })) as Record<string, string>
}

// Numbers and time

export const kilo = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

// Text

const MARKUP = /[#*`_>|]+/g

/** The first line worth reading, without markdown. */
export const excerpt = (text = '', size = 120) => {
  const line = text.split('\n').map(l => l.replace(MARKUP, '').trim()).find(Boolean) ?? ''
  return line.length > size ? `${line.slice(0, size - 1)}…` : line
}

const leaf = (path = '') => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** One tool call as a few words: "Edit server.ts", "Bash npm test". */
export const activity = (tool: string, input: Record<string, unknown>) => {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const file = leaf(str('file_path') || str('notebook_path') || str('path'))
  // The agent's own few words ("Wait for the build") read better than the start of a shell command.
  if (!file && str('description')) return excerpt(str('description'), 48)
  const target =
    file ||
    str('command').trim().split(/\s+/).slice(0, 2).join(' ') ||
    str('pattern') ||
    (str('to') && `to ${str('to')}`) ||
    str('url')
  const name = tool === 'SendMessage' ? 'Message' : tool.startsWith('mcp__') ? tool.split('__').pop()! : tool
  return excerpt(`${name} ${target}`, 48)
}

// What agents do, read from their tool calls (works with no workflow at all)

const KINDS: Record<string, Phase> = {
  Edit: 'building', Write: 'building', NotebookEdit: 'building', MultiEdit: 'building',
  Bash: 'checking', PowerShell: 'checking',
  Agent: 'delegating', Task: 'delegating', SendMessage: 'delegating',
}

export const kindOf = (tool: string): Phase => KINDS[tool] ?? 'exploring'

/** The phase its last few calls point at; the newest call wins a tie. */
export const phase = (recent: Phase[]): Phase | undefined => {
  const last = recent.slice(-5)
  let best: Phase | undefined
  let most = 0
  for (const p of [...last].reverse()) {
    const n = last.filter(q => q === p).length
    if (n > most) [best, most] = [p, n]
  }
  return best
}

export const changedFile = (tool: string, input: Record<string, unknown>) =>
  KINDS[tool] === 'building' && typeof (input.file_path ?? input.notebook_path) === 'string'
    ? ((input.file_path ?? input.notebook_path) as string)
    : undefined

export const relative = (path: string, root: string) =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

/** Files two or more live agents are changing at once. */
export const overlaps = (agents: Agent[]) => {
  const live = agents.filter(a => a.status === 'running' || a.status === 'waiting')
  const owners = new Map<string, string[]>()
  for (const a of live) for (const f of new Set(a.files)) owners.set(f, [...(owners.get(f) ?? []), a.id])
  return [...owners].filter(([, ids]) => ids.length > 1).map(([file, ids]) => ({ file, ids }))
}

// Workspace formats

const lines = (text: string) =>
  text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line)
      return row && typeof row === 'object' ? [row] : []
    } catch {
      return []
    }
  })

const SETTLED = new Set(['yes', 'skip'])

/** status-board: fold events.jsonl into rows; keep the ones not yet through every stage. */
export const foldStatusBoard = (text: string, stages: string[]) => {
  const rows = new Map<string, StageRow>()
  for (const e of lines(text)) {
    if (typeof e.id !== 'string') continue
    const row = rows.get(e.id) ?? { id: e.id, stages: {}, note: '', at: 0 }
    Object.assign(row.stages, e.stages ?? {})
    if (e.note) row.note = e.note
    row.at = Date.parse(e.t) || row.at
    rows.set(e.id, row)
  }
  const all = [...rows.values()]
  const isOpen = (r: StageRow) => stages.some(s => !SETTLED.has(r.stages[s] ?? ''))
  return { rows: all.filter(isOpen).sort((a, b) => b.at - a.at), total: all.length }
}

const PIPELINE = ['cause', 'fix', 'looked', 'checked', 'gated', 'closed']
const CHECKED = PIPELINE.indexOf('checked')

/** Lane board: lanes.json plus each lane's events, as progress per lane. */
export const foldLanes = (spec: any, events: Record<string, string>) =>
  (Array.isArray(spec?.lanes) ? spec.lanes : []).map((lane: any): Lane => {
    const items: any[] = lane.items ?? []
    const last = new Map<string, { stage: string; status?: string }>()
    for (const e of lines(events[lane.id] ?? '')) if (e.item) last.set(String(e.item), e)
    const rank = (id: unknown) => PIPELINE.indexOf(last.get(String(id))?.stage ?? '')
    // Finished once independently checked and marked done; nothing on these boards reaches "closed".
    const isDone = (id: unknown) => rank(id) >= CHECKED && (last.get(String(id))?.status === 'done' || rank(id) === PIPELINE.length - 1)
    const done = items.filter(i => isDone(i.id)).length
    const active = items.filter(i => rank(i.id) >= 0 && !isDone(i.id)).sort((a, b) => rank(b.id) - rank(a.id))[0]
    return { id: lane.id, title: lane.title ?? lane.id, done, total: items.length, active: active?.title, agent: lane.agent }
  })

/** REDManager: a v2 current.json or a v1 state.md ledger. */
export const parseRun = (name: string, text: string): Run => {
  if (text.trimStart().startsWith('{')) {
    try {
      const run = JSON.parse(text)
      return {
        name: run.run_id ?? name,
        status: run.status ?? '',
        next: run.next_action,
        open: run.open_attempts?.length ?? 0,
      }
    } catch {}
  }
  const field = (re: RegExp) => text.match(re)?.[1]?.replace(/[`*]/g, '').trim()
  return {
    name,
    status: field(/^\s*-?\s*(?:Run status|Status)\s*:\s*(.+)$/im) ?? '',
    next: field(/^\s*-?\s*Next(?: action)?\s*:\s*(.+)$/im),
    open: (text.match(/^\|.*`(?:DISPATCHED|ACTIVE)`/gm) ?? []).length,
  }
}

/** REDStudio standards.md: how many, and the newest one's title. */
export const parseStandards = (text: string) => {
  const titles = [...text.matchAll(/^- \*\*S\d+ · [^·]+· ([^*]+?)\.?\*\*/gm)].map(m => (m[1] ?? '').trim())
  return { standards: titles.length, latest: titles.at(-1) }
}

/** One message of an agent's conversation, as Claude Code hands it back. */
export type Said = { role: 'user' | 'assistant'; text: string; toolUses: { tool: string; input: Record<string, unknown>; isError?: true }[] }

/**
 * What an agent REDhelm did not watch from the start has done, read from its conversation:
 * its brief, its latest steps (no times; the conversation keeps none), the files it changed and its latest words.
 */
export const fromConversation = (said: Said[], root: string): Partial<Agent> => {
  const calls = said.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))
  const changed = calls.map(c => changedFile(c.tool, c.input)).filter((f): f is string => !!f).map(f => relative(f, root))
  const spoke = said.filter(m => m.role === 'assistant' && m.text.trim()).at(-1)
  return {
    brief: said.find(m => m.role === 'user' && m.text.trim())?.text.slice(0, 2000),
    steps: calls.slice(-8).reverse().map(c => ({ text: activity(c.tool, c.input) })),
    recent: calls.slice(-8).map(c => kindOf(c.tool)),
    files: [...new Set(changed.reverse())].reverse().slice(-30),
    edits: changed.length,
    fails: calls.filter(c => c.isError && kindOf(c.tool) === 'checking').length,
    thinking: spoke && excerpt(spoke.text, 300),
  }
}

/** Steps in a row that read the same fold into one line with a count ("Edit review.md ×6"). */
export const grouped = (steps: Agent['steps']) =>
  steps.reduce<(Agent['steps'][number] & { count: number })[]>((out, s) => {
    const last = out.at(-1)
    if (last && last.text === s.text) last.count++
    else out.push({ ...s, count: 1 })
    return out
  }, [])

/** Agents' words name files by full path; inside the project the path is enough, and home reads as ~. */
export const tidyPaths = (text: string, root: string, home: string) => {
  let out = text
  if (root) out = out.split(`${root}/`).join('')
  if (home) out = out.split(`${home}/`).join('~/')
  return out
}

/**
 * Whether an agent's message waits on an answer, from its words alone: the fallback when the model
 * cannot be asked. A question mark counts outside code and links; so do the plain ways of asking.
 */
export function looksLikeQuestion(text: string) {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/\bhttps?:\/\/\S+/g, ' ')
  return /\?(?=\s|$|["')\]*_])/.test(plain) ||
    /\b(should I|shall I|do you want|would you like|want me to|let me know|your (call|decision|approval|go-ahead|input|choice)|waiting (for|on) (you|your)|need (you|your)|please (confirm|approve|decide|choose|advise|review))\b/i.test(plain)
}

/** Whether version `a` is newer than `b`, number by number ("0.10.0" beats "0.9.9"); one unreadable never is. */
export function isNewer(a: string, b: string) {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split('.').map(Number) : null)
  const x = parse(a), y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

