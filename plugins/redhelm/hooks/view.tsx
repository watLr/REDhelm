import type { Elements } from 'claude-code'

import type { Agent, Guard, Message, Note, Release, SetupItem, Workspace } from '../types'
import { age, capital, excerpt, firstAsk, grouped, headlineOf, isStale, kilo, looksLikeQuestion, modelWords, overlaps, short, stateOf, type State } from './model'
import { bars, buckets, isMoving, rasterCells, spectrum, svgTrace, tail } from './trace'

/**
 * Every agent is a live signal. Each row carries a trace of its tool calls: the trace moves while
 * the agent works and flattens when it goes quiet, and a question turns the edge amber. State is
 * a glyph, not a sentence; the few words left say what the agent is on.
 */

/** The elements every surface has (typed, so a prop no surface takes fails tsc), plus each surface's trace. */
type Table = Elements['terminal']
export type Els = Pick<Table, 'Box' | 'Text' | 'Button'> & {
  Input?: Table['Input']
  /** Terminal: a trace repainted in place. */
  Raster?: Table['Raster']
  /** Desktop, VS Code, mobile: the trace as a drawing. */
  Svg?: Elements['desktop']['Svg']
}

export type Actions = {
  inspect: (id: string | null) => void
  compose: (id: string | null) => void
  /** Leaves the reply: the prompt gets back what you were writing to Claude. */
  cancelCompose: () => void
  stop: (id: string) => void
  /** Puts away what an agent asked you, unanswered. */
  dismiss: (agentId: string) => void
  open: () => void
  toggleDone: () => void
  toggleBrief: () => void
  applySetup: () => void
  skipSetup: () => void
  /** Installs the newer REDhelm through Claude Code's plugin update. */
  update: () => void
}

/** A trace drawn as a Raster, for the frame loop to repaint: whose, how big, its colours moving and flat, the cells it holds. */
export type TraceSpec = { agentId: string; cells: number; rows: number; moving: number[]; quiet: number; bg?: number; sent?: string }

export type View = {
  now: number
  agents: Agent[]
  notes: Note[]
  inbox: Message[]
  workspaces: Workspace[]
  guard: Guard
  composing: string | null
  inspecting: string | null
  briefOpen: boolean
  setup: SetupItem[]
  showDone: boolean
  aside: boolean
  /** A newer REDhelm, when one is published. */
  release: Release | null
  handles: Record<string, string>
  root: string
  /** 'light' or 'dark', from the person's Claude Code theme. */
  theme: 'light' | 'dark'
  lanes: Record<string, string>
  /** Each agent's recent tool call times, for its trace. */
  traces: Record<string, readonly number[]>
  /** The clock when this was drawn: where the traces end. */
  at: number
  /** Moving traces and the question flash; off, Rasters give way to still text. */
  motion: boolean
  /** Told of every Raster drawn, so the frame loop repaints it. */
  mount?: (key: string, spec: TraceSpec) => void
  /**
   * The backdrop's colour, when REDhelm draws one: rows, the header and loose lines sit on plates of
   * it, so text never lands on the pattern. Absent, the pane's own colour shows.
   */
  field?: string
}

// Tokens: surfaces follow the theme; meaning colours are the theme's own keys

const PALETTE = {
  dark: { card: '#1c1c21', chip: '#2c2c33', chipHover: '#3a3a42', primary: '#d6363c', primaryHover: '#e5484d', rule: '#2c2c33', hover: '#232329', quiet: 0x4c4c55, svgQuiet: '#4c4c55' },
  light: { card: '#f2f2f5', chip: '#e2e2e7', chipHover: '#d4d4db', primary: '#fbd5d6', primaryHover: '#f8c1c3', rule: '#e2e2e7', hover: '#ececf0', quiet: 0xbdbdc6, svgQuiet: '#bdbdc6' },
} as const

const tone = (v: View) => PALETTE[v.theme] ?? PALETTE.dark

/** Each agent's own colour, the same everywhere it appears: its stripe and its trace. No orange: that is a question's amber. */
const HUES = ['#4f8ff7', '#a777f2', '#22b8a6', '#e8659a', '#8cc152', '#5bc0eb']

export const hue = (id: string) => HUES[[...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]!

const rgb = (hex: string) => parseInt(hex.slice(1), 16)

/** One glyph per state, the same in every row, card, sheet and count. */
const GLYPH: Record<State, { glyph: string; color?: string }> = {
  working: { glyph: '▶' },
  quiet: { glyph: '▷', color: 'subtle' },
  waiting: { glyph: '◆', color: 'subtle' },
  asks: { glyph: '⚑', color: 'warning' },
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✕', color: 'error' },
}

const LIVE = new Set<Agent['status']>(['pending', 'running', 'waiting'])

type Strip = { agent: Agent; messages: Message[]; cocked: boolean }

/** An agent's name in REDhelm; one with no name or task gets a unique one ("Agent a169"), which is also its address. */
export const label = (a: Agent, lanes: Record<string, string>) =>
  capital(lanes[a.id] || a.name || excerpt(a.description, 28) || `agent ${a.id.slice(0, 4)}`)

/** Who needs you next: agents asking you something, then live ones by start, then the most recently finished. */
export function rack(v: View): Strip[] {
  const strips = v.agents.map(agent => {
    // Only a question asks for you; a report is what the agent last said.
    const messages = v.inbox.filter(m => m.agentId === agent.id && (m.ask ?? looksLikeQuestion(m.text)))
    return { agent, messages, cocked: messages.length > 0 }
  })
  const rank = (s: Strip) => (s.cocked ? 0 : LIVE.has(s.agent.status) ? 1 : 2)
  return strips.sort((a, b) =>
    rank(a) - rank(b) ||
    (rank(a) === 2 ? (b.agent.endedAt ?? 0) - (a.agent.endedAt ?? 0) : a.agent.startedAt - b.agent.startedAt))
}

/** A workspace's name, short: "Demo app (web folder) — beta" → "Demo app". */
export const shortName = (name: string) => name.split(/\s[(—–-]\s?/)[0]!.trim() || name

/** A name cut to the columns the grid leaves it. */
const fit = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1)).trimEnd()}…`)

/** The time column: how long it has run, how long ago it ended, or the state that matters more. */
function when(a: Agent, v: View) {
  const state = stateOf(a, v.now)
  if (!LIVE.has(a.status)) return age(v.now - (a.endedAt ?? v.now))
  return state === 'quiet' ? 'quiet' : state === 'waiting' ? 'waits' : age(v.now - a.startedAt)
}

/**
 * Every time REDhelm shows, as one string: when it changes, a redraw is due. An agent past its first
 * minute changes it once a minute, so its trace moves by repaints alone, with no redraw between.
 */
export function clockFace(agents: Agent[], inbox: Message[], now: number, traces: Record<string, readonly number[]> = {}) {
  const v = { now } as View
  const live = new Set(agents.filter(a => LIVE.has(a.status)).map(a => a.id))
  const busy = spectrum(Object.fromEntries(Object.entries(traces).filter(([id]) => live.has(id))), now, 40).map(p => `${p.id}=${p.cells}`)
  return [...agents.map(a => `${a.id}:${when(a, v)}`), ...inbox.map(m => `${m.id}:${age(now - m.at)}`), ...busy].join(' ')
}

// Primitives

function Brand({ els }: { els: Els }) {
  const { Text } = els
  return <Text><Text bold color="error">RED</Text><Text bold>helm</Text></Text>
}

function Glyph({ els, state }: { els: Els; state: State }) {
  const { Box, Text } = els
  const g = GLYPH[state]
  return <Box width={2} flexShrink={0}><Text color={g.color}>{g.glyph}</Text></Box>
}

/** A filled button: the primary one in REDhelm red, the rest quiet. */
function Chip({ els, v, k, text, primary, compact, onPress }: { els: Els; v: View; k: string; text: string; primary?: boolean; compact?: boolean; onPress: () => void }) {
  const { Box, Button } = els
  const t = tone(v)
  return (
    <Box backgroundColor={primary ? t.primary : t.chip} paddingX={compact ? 1 : 2} flexShrink={0}>
      <Button key={k} plain label={text} hover={{ bold: true, backgroundColor: primary ? t.primaryHover : t.chipHover, scope: k }} onPress={onPress} />
    </Box>
  )
}

/** A filled surface with a coloured edge down its left side: a question, a model notice. */
function EdgeCard({ els, v, k, edge, children }: { els: Els; v: View; k?: string; edge: string; children: any }) {
  const { Box } = els
  return (
    <Box key={k} backgroundColor={tone(v).card}>
      <Box width={1} flexShrink={0} backgroundColor={edge} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={1} paddingY={1}>{children}</Box>
    </Box>
  )
}

/** A filled surface: what makes a group read as one thing. */
function Card({ els, v, children }: { els: Els; v: View; children: any }) {
  const { Box } = els
  return <Box flexDirection="column" backgroundColor={tone(v).card} paddingX={2} paddingY={1}>{children}</Box>
}

/**
 * An agent's tool calls over the last half minute (a row) or minute (the sheet), as bars.
 * Terminal: a Raster the frame loop repaints in place while it moves. Elsewhere, a drawing.
 */
function Trace({ els, v, a, k, cells, rows = 1 }: { els: Els; v: View; a: Agent; k: string; cells: number; rows?: number }) {
  const { Box, Text, Raster, Svg } = els
  const t = tone(v)
  const times = v.traces[a.id] ?? []
  const counts = buckets(times, v.at, cells)
  const moving = isMoving(times, v.at)
  if (Raster && v.motion) {
    const comet = tail(rgb(hue(a.id)), t.quiet, cells)
    // On the backdrop's colour, so the trace sits on its row's plate.
    const bg = v.field ? rgb(v.field) : undefined
    const drawn = rasterCells(bars(counts, rows), moving ? comet : t.quiet, bg)
    v.mount?.(k, { agentId: a.id, cells, rows, moving: comet, quiet: t.quiet, bg, sent: drawn })
    return <Box width={cells} flexShrink={0}><Raster key={k} columns={cells} rows={rows} cells={drawn} /></Box>
  }
  if (Svg) {
    return <Box flexShrink={0}><Svg source={svgTrace(counts, cells * 8, rows * 14, rows, moving ? hue(a.id) : t.svgQuiet, t.svgQuiet)} alt={moving ? 'Working' : 'Quiet'} width={cells * 8} height={rows * 14} /></Box>
  }
  return (
    <Box width={cells} flexShrink={0} flexDirection="column">
      {bars(counts, rows).map((line, i) => <Text key={`${k}-${i}`} color={moving ? undefined : 'subtle'}>{line}</Text>)}
    </Box>
  )
}

/** Message and Stop, revealed over the row's right side while the pointer is on it; no hook runs. */
function HoverActions({ els, v, a, act, right }: { els: Els; v: View; a: Agent; act: Actions; right: number }) {
  const { Box, Button } = els
  const t = tone(v)
  const scope = `row-${a.id}`
  return (
    <Box position="absolute" right={right} top={0} display="none" hover={{ display: 'flex', scope }} backgroundColor={t.hover} columnGap={1} paddingLeft={1}>
      <Box backgroundColor={t.chip} paddingX={1}>
        <Button key={`compose-${a.id}`} plain label="Message" hover={{ bold: true, backgroundColor: t.chipHover, scope: `compose-${a.id}` }} onPress={() => act.compose(a.id)} />
      </Box>
      <Box backgroundColor={t.chip} paddingX={1}>
        <Button key={`stop-${a.id}`} plain label="Stop" hover={{ bold: true, backgroundColor: t.chipHover, scope: `stop-${a.id}` }} onPress={() => act.stop(a.id)} />
      </Box>
    </Box>
  )
}

// The list

/** Under the header: each working agent's share of the last minute's tool calls, in its own colour. */
function Spectrum({ els, v, width }: { els: Els; v: View; width: number }) {
  const { Text } = els
  const live = new Set(v.agents.filter(a => LIVE.has(a.status)).map(a => a.id))
  const parts = spectrum(Object.fromEntries(Object.entries(v.traces).filter(([id]) => live.has(id))), v.at, width)
  if (!parts.length) return null
  return <Text>{parts.map(p => <Text key={`sp-${p.id}`} color={hue(p.id)}>{'━'.repeat(p.cells)}</Text>)}</Text>
}

function Header({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  const strips = rack(v)
  const asks = strips.filter(s => s.cocked).length
  const live = strips.filter(s => !s.cocked && LIVE.has(s.agent.status)).length
  const failed = strips.filter(s => !s.cocked && !LIVE.has(s.agent.status) && stateOf(s.agent, v.now) === 'failed').length
  const done = strips.length - asks - live - failed
  const counts = ([['asks', asks], ['working', live], ['done', done], ['failed', failed]] as const).filter(([, n]) => n > 0)
  return (
    <Box justifyContent="space-between" gap={2}>
      <Brand els={els} />
      <Box columnGap={2} flexShrink={0}>
        {counts.length
          ? counts.map(([state, n]) => <Text key={`count-${state}`} color={GLYPH[state].color}>{`${GLYPH[state].glyph} ${n}`}</Text>)
          : <Text color="subtle">No agents yet</Text>}
      </Box>
    </Box>
  )
}

/**
 * One agent on the grid: edge, glyph, name, trace, time, ›; under it, what it is on. Pointing at
 * a live one reveals Message and Stop over its right side.
 */
function Row({ els, s, v, act, columns, cells }: { els: Els; s: Strip; v: View; act: Actions; columns: number; cells: number }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const ended = !LIVE.has(a.status)
  const older = isStale(a.model, v.guard.stale ?? v.guard.model)
  const scope = `row-${a.id}`
  // stripe and its gap 2, glyph 2, trace and its gap, time 6, gap and › 2
  const room = columns - 2 - 2 - (cells + 1) - 6 - 2 - (older ? 2 : 0)
  return (
    <Box key={scope} position="relative" backgroundColor={v.field} hover={{ backgroundColor: tone(v).hover, scope }}>
      {/* Its colour, down both lines: how you tell agents apart at a glance. Finished agents go grey. */}
      <Box width={1} flexShrink={0} backgroundColor={ended ? tone(v).chip : hue(a.id)} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1}>
      <Box>
        <Glyph els={els} state={stateOf(a, v.now)} />
        <Box flexGrow={1} flexShrink={1} minWidth={6}>
          <Button key={`sel-${a.id}`} plain dimColor={ended} label={fit(label(a, v.lanes), Math.max(6, room))} hover={{ underline: true, scope }} onPress={() => act.inspect(a.id)} />
        </Box>
        {older && <Box width={2} flexShrink={0} justifyContent="flex-end"><Text color="warning">◷</Text></Box>}
        <Box marginLeft={1} flexShrink={0}>
          {ended ? <Box width={cells} /> : <Trace els={els} v={v} a={a} k={`trace-${a.id}`} cells={cells} />}
        </Box>
        <Box width={6} flexShrink={0} justifyContent="flex-end"><Text color="subtle">{when(a, v)}</Text></Box>
        <Box marginLeft={1} flexShrink={0}>
          <Button key={`open-${a.id}`} plain dimColor label="›" hover={{ bold: true, scope }} onPress={() => act.inspect(a.id)} />
        </Box>
      </Box>
      <Box paddingLeft={2} paddingRight={2}>
        <Text color="subtle" wrap="truncate-end">{headlineOf(a, v.now)}</Text>
      </Box>
      </Box>
      {!ended && v.composing !== a.id && <HoverActions els={els} v={v} a={a} act={act} right={2} />}
    </Box>
  )
}

/**
 * An agent that asked you something: the amber edge, who, how long ago, the question in a line,
 * and Reply. The edge flashes a few times when the question arrives, then holds.
 */
function QuestionCard({ els, s, v, act, columns }: { els: Els; s: Strip; v: View; act: Actions; columns: number }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const ask = s.messages.at(-1)!
  const since = v.now - ask.at
  // Narrow: the flag already says it asks; the time alone keeps the name its room.
  const roomy = columns >= 34
  const compact = columns < 30
  const time = age(since)
  const pill = roomy ? ' Asks you ' : ''
  const flash = v.motion && since >= 0 && since < 1500 && Math.floor(since / 250) % 2 === 1
  return (
    <EdgeCard els={els} v={v} k={`ask-${a.id}`} edge={flash ? tone(v).chip : 'warning'}>
      <Box justifyContent="space-between" columnGap={1}>
        <Box flexShrink={1} minWidth={6}>
          <Glyph els={els} state="asks" />
          <Button key={`sel-${a.id}`} plain label={fit(label(a, v.lanes), columns - 1 - 2 - 2 - pill.length - time.length - 2)} hover={{ underline: true, scope: `sel-${a.id}` }} onPress={() => act.inspect(a.id)} />
        </Box>
        <Box flexShrink={0} columnGap={1}>
          {pill && <Text bold color="inverseText" backgroundColor="warning">{pill}</Text>}
          <Text color="subtle">{time}</Text>
        </Box>
      </Box>
      <Box paddingLeft={2}>
        <Text bold wrap="wrap">{ask.title ?? firstAsk(ask.text)}</Text>
      </Box>
      <Box paddingLeft={2} marginTop={1} justifyContent="space-between" columnGap={1} flexWrap="wrap">
        <Box columnGap={1} flexWrap="wrap">
          {v.composing === a.id
            ? <Text color="warning">↓ type below</Text>
            : <Chip els={els} v={v} k={`compose-${a.id}`} text="Reply" primary compact={compact} onPress={() => act.compose(a.id)} />}
          {!LIVE.has(a.status) && <Chip els={els} v={v} k={`dismiss-${a.id}`} text="Dismiss" compact={compact} onPress={() => act.dismiss(a.id)} />}
        </Box>
        <Box flexShrink={0}>
          <Button key={`more-${a.id}`} plain dimColor label="Details ›" hover={{ bold: true, scope: `more-${a.id}` }} onPress={() => act.inspect(a.id)} />
        </Box>
      </Box>
    </EdgeCard>
  )
}

/** Finished agents fold into one line until you ask for them. */
function Finished({ els, v, act, strips, columns, cells }: { els: Els; v: View; act: Actions; strips: Strip[]; columns: number; cells: number }) {
  const { Box, Text, Button } = els
  if (!strips.length) return null
  return (
    <Box flexDirection="column" backgroundColor={v.field}>
      <Box justifyContent="space-between" gap={2}>
        <Text color="subtle">{`Finished · ${strips.length}`}</Text>
        <Button key="toggle-done" plain dimColor label={v.showDone ? 'Hide' : 'Show'} hover={{ bold: true, scope: 'toggle-done' }} onPress={act.toggleDone} />
      </Box>
      {v.showDone && strips.slice(0, 8).map(s => <Row key={`d-${s.agent.id}`} els={els} s={s} v={v} act={act} columns={columns} cells={cells} />)}
    </Box>
  )
}

/** Only a problem with the model earns space; the status line shows the model otherwise. */
function ModelNotice({ els, v }: { els: Els; v: View }) {
  const { Text } = els
  const g = v.guard
  if (!g.fallback && !g.stale) return null
  return (
    <EdgeCard els={els} v={v} edge={g.fallback ? 'error' : 'warning'}>
      <Text bold color={g.fallback ? 'error' : 'warning'}>{g.fallback ? '✕ Model changed' : '◷ Older model'}</Text>
      <Text wrap="wrap">
        {g.fallback ? `Claude Code switched models without you (${g.fallback}).` : `This session runs ${short(g.model)}; your default is now ${short(g.stale)}.`} Run /model to choose.
      </Text>
    </EdgeCard>
  )
}

/** While you write to an agent: who it goes to, and the way back. One line, at the top of REDhelm. */
function Composer({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text } = els
  const a = v.agents.find(x => x.id === v.composing)
  if (!a) return null
  return (
    <Box justifyContent="space-between" gap={2}>
      <Box flexShrink={1}>
        <Box flexShrink={0}><Text color="warning">Writing to {label(a, v.lanes)}</Text></Box>
        <Text color="subtle" wrap="truncate-end"> · Enter sends{v.aside ? ' · draft kept' : ''}</Text>
      </Box>
      <Box flexShrink={0}>
        <Chip els={els} v={v} k="cancel-compose" text="Cancel" onPress={act.cancelCompose} />
      </Box>
    </Box>
  )
}

/** Two agents editing one file is the one thing about files worth interrupting you for. */
function Overlaps({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  const clash = overlaps(v.agents)
  if (!clash.length) return null
  const names = (ids: string[]) =>
    ids.map(id => v.agents.find(a => a.id === id)).filter(Boolean).map(a => label(a!, v.lanes)).join(' and ')
  return (
    <Box flexDirection="column">
      {clash.map(c => (
        <Box key={`c-${c.file}`}>
          <Box width={2} flexShrink={0}><Text color="warning">⚠</Text></Box>
          <Text wrap="wrap">{names(c.ids)} both edit {c.file.split('/').pop()}</Text>
        </Box>
      ))}
    </Box>
  )
}

function SetupCard({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text } = els
  if (!v.setup.length) return null
  return (
    <Card els={els} v={v}>
      <Text bold>Finish setting up REDhelm</Text>
      <Box flexDirection="column" marginY={1}>
        {v.setup.map(item => <Text key={`s-${item.key}`} color="subtle" wrap="wrap">{item.label}</Text>)}
      </Box>
      <Box gap={1}>
        <Chip els={els} v={v} k="setup-apply" text="Apply" primary onPress={act.applySetup} />
        <Chip els={els} v={v} k="setup-skip" text="Not now" onPress={act.skipSetup} />
      </Box>
    </Card>
  )
}

// Workflows: only this session's, and only what is still open

const FINISHED_RUN = /^(complete|completed|cancelled|canceled|cleared)\b/i

/**
 * The workflows worth showing: this session's project (the folder or one above it) or one an
 * agent here is changing files in; finished runs and boards with nothing open stay quiet.
 */
export function relevant(v: View): Workspace[] {
  const inside = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`)
  return v.workspaces
    .filter(ws => inside(ws.dir, v.root) || v.agents.some(a => a.files.some(f => inside(ws.dir, f.startsWith('/') ? f : `${v.root}/${f}`))))
    .map(ws => ({ ...ws, runs: ws.runs?.filter(r => r.status && !FINISHED_RUN.test(r.status)) }))
    .filter(ws => (ws.lanes ?? []).some(l => l.total > l.done) || (ws.board?.rows.length ?? 0) > 0 || (ws.runs?.length ?? 0) > 0)
}

/** "Game 28 of 36 done", "Demo app 4 tasks open", "demo-run active" */
export const summary = (ws: Workspace) => {
  const lanes = (ws.lanes ?? []).filter(l => l.total)
  const total = lanes.reduce((n, l) => n + l.total, 0)
  const open = ws.board?.rows.length ?? 0
  const run = ws.runs?.[0]
  return [
    total ? `${shortName(ws.name)} ${lanes.reduce((n, l) => n + l.done, 0)} of ${total} done`
      : ws.board ? `${shortName(ws.name)} ${open} ${open === 1 ? 'task' : 'tasks'} open`
      : ws.studio ? `${shortName(ws.name)} ${ws.studio.standards} standards` : '',
    run && run.status ? `${run.name} ${run.status.split(/\s/)[0]!.toLowerCase()}` : '',
  ].filter(Boolean).join(' · ')
}

function Progress({ els, done, total }: { els: Els; done: number; total: number }) {
  const { Text } = els
  const width = 14
  const n = total ? Math.round((done / total) * width) : 0
  return <Text><Text color="success">{'━'.repeat(n)}</Text><Text color="subtle">{'━'.repeat(width - n)}</Text>  <Text color="subtle">{done} of {total}</Text></Text>
}

function Workflows({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  const list = relevant(v)
  if (!list.length) return null
  return (
    <Card els={els} v={v}>
      {list.map(ws => {
        const lanes = (ws.lanes ?? []).filter(l => l.total)
        const done = lanes.reduce((n, l) => n + l.done, 0)
        const total = lanes.reduce((n, l) => n + l.total, 0)
        const open = ws.board?.rows.length ?? 0
        const run = ws.runs?.[0]
        return (
          <Box key={`ws-${ws.dir}`} flexDirection="column">
            <Box justifyContent="space-between" gap={2}>
              <Text bold wrap="truncate-end">{shortName(ws.name)}</Text>
              {total ? <Progress els={els} done={done} total={total} />
                : ws.board ? <Text color="subtle">{open} {open === 1 ? 'task' : 'tasks'} open</Text> : null}
            </Box>
            {run && <Text color="subtle" wrap="truncate-end">Run {run.name} is {run.status.split(/\s/)[0]!.toLowerCase()}{run.next ? ` · next: ${run.next}` : ''}</Text>}
          </Box>
        )
      })}
    </Card>
  )
}

// The agent sheet: everything about one agent, opened from any row

/** A labelled part of the sheet; `stacked` puts the label above, for a narrow sidebar. */
function Field({ els, name, stacked, children }: { els: Els; name: string; stacked?: boolean; children: any }) {
  const { Box, Text } = els
  if (stacked) {
    return (
      <Box flexDirection="column">
        <Text color="subtle">{name}</Text>
        {children}
      </Box>
    )
  }
  return (
    <Box gap={2}>
      <Box width={9} flexShrink={0}><Text color="subtle">{name}</Text></Box>
      <Box flexDirection="column" flexShrink={1}>{children}</Box>
    </Box>
  )
}

/**
 * One agent in full. `back`: drawn inside REDhelm's panel, with Back to the list; without it the sheet
 * is its own pane, closed with Esc.
 */
export function Sheet({ els, v, act, columns, back }: { els: Els; v: View; act: Actions; columns: number; back?: () => void }) {
  const { Box, Text, Button } = els
  const a = v.agents.find(x => x.id === v.inspecting)
  const backButton = back && <Button key="back" plain label="← Back" hover={{ bold: true, scope: 'back' }} onPress={back} />
  if (!a) {
    return (
      <Box flexDirection="column" gap={1} width={columns}>
        {backButton}
        <Text color="subtle">This agent is no longer listed.</Text>
      </Box>
    )
  }
  const s = rack(v).find(x => x.agent.id === a.id)!
  const ask = s.messages.at(-1)
  const live = LIVE.has(a.status)
  const stacked = columns < 50
  const older = isStale(a.model, v.guard.stale ?? v.guard.model)
  const brief = (a.brief || a.description || '').trim()
  // Two lines of the task, then More.
  const room = Math.max(60, (columns - (stacked ? 0 : 11)) * 2 - 4)
  const long = brief.length > room
  const said = a.answer || a.thinking
  // A sheet longer than the pane scrolls, and its scrollbar takes the last column.
  return (
    <Box flexDirection="column" gap={1} width={columns} paddingRight={1}>
      {backButton}
      <Box flexDirection="column">
        <Box justifyContent="space-between" columnGap={2}>
          <Box flexShrink={1} minWidth={6}>
            <Box width={1} flexShrink={0} marginRight={1} backgroundColor={live ? hue(a.id) : tone(v).chip} />
            <Glyph els={els} state={stateOf(a, v.now, !!ask)} />
            <Text bold wrap="truncate-end">{label(a, v.lanes)}</Text>
          </Box>
          <Box flexShrink={0}><Text color="subtle">{when(a, v)}</Text></Box>
        </Box>
        <Box paddingLeft={2}><Text color="subtle" wrap="truncate-end">{headlineOf(a, v.now)}</Text></Box>
      </Box>

      {/* What you can do comes first, so a long sheet never pushes it out of sight. */}
      {(live || ask || !back) && (
        <Box justifyContent="space-between" columnGap={2} flexWrap="wrap">
          <Box columnGap={1} flexWrap="wrap">
            {v.composing === a.id
              ? <Text color="warning">↓ type below</Text>
              : (live || ask) && <Chip els={els} v={v} k={`compose-${a.id}`} text={ask ? 'Reply' : 'Message'} primary onPress={() => act.compose(a.id)} />}
            {live && <Chip els={els} v={v} k={`stop-${a.id}`} text="Stop" onPress={() => act.stop(a.id)} />}
            {!live && ask && <Chip els={els} v={v} k={`dismiss-${a.id}`} text="Dismiss" onPress={() => act.dismiss(a.id)} />}
          </Box>
          {!back && <Box flexShrink={0}><Text color="subtle">Esc to close</Text></Box>}
        </Box>
      )}

      {ask && (
        <EdgeCard els={els} v={v} edge="warning">
          <Text color="subtle">{`asks · ${age(v.now - ask.at)}`}</Text>
          <Text wrap="wrap">{ask.text.trim().slice(0, 1200)}</Text>
        </EdgeCard>
      )}

      {/* One row: stacked rows of bars break apart at the terminal's line spacing. */}
      {live && <Trace els={els} v={v} a={a} k={`trace-big-${a.id}`} cells={16} />}

      <Box flexDirection="column" gap={1}>
        {brief && (
          <Field els={els} stacked={stacked} name="Task">
            <Text wrap="wrap">{v.briefOpen || !long ? brief : `${brief.slice(0, room).trimEnd()}…`}</Text>
            {long && <Button key="brief-more" plain dimColor label={v.briefOpen ? 'Less' : 'More'} hover={{ bold: true, scope: 'brief-more' }} onPress={act.toggleBrief} />}
          </Field>
        )}
        {a.steps?.length > 0 && (
          <Field els={els} stacked={stacked} name="Steps">
            {grouped(a.steps).slice(0, 6).map((st, i) => (
              <Box key={`st-${i}`} justifyContent="space-between" gap={2}>
                <Text wrap="truncate-end">{st.text}{st.count > 1 ? <Text color="subtle"> ×{st.count}</Text> : ''}</Text>
                {st.at !== undefined && <Box flexShrink={0}><Text color="subtle">{age(v.now - st.at)}</Text></Box>}
              </Box>
            ))}
          </Field>
        )}
        {!brief && !a.steps?.length && !said && (
          <Text color="subtle" wrap="wrap">This agent started before REDhelm, and Claude Code has no record of its work to show.</Text>
        )}
        <Field els={els} stacked={stacked} name="Files">
          <Text wrap="truncate-end">{a.files.length ? a.files.slice(-4).map(f => f.split('/').pop()).join(', ') + (a.files.length > 4 ? ` +${a.files.length - 4}` : '') : 'none yet'}</Text>
        </Field>
        {a.model && (
          <Field els={els} stacked={stacked} name="Model">
            <Text>{modelWords(a.model, a.effort)}{older ? <Text color="warning"> ◷ older</Text> : ''}</Text>
          </Field>
        )}
        {a.context > 0 && <Field els={els} stacked={stacked} name="Context"><Text>{kilo(a.context)} tokens</Text></Field>}
        {said && <Field els={els} stacked={stacked} name="Last said"><Text color="subtle" wrap="wrap">{said}</Text></Field>}
      </Box>
    </Box>
  )
}

/** A newer REDhelm: one quiet line, never a pop-up. */
function Update({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const r = v.release
  if (!r) return null
  if (r.state === 'updating') return <Text color="subtle">Updating REDhelm to {r.latest}…</Text>
  if (r.state === 'updated') return <Text color="subtle" wrap="truncate-end">REDhelm {r.latest} installed · /reload-plugins to load it</Text>
  return (
    <Box gap={1}>
      <Text color="subtle" wrap="truncate-end">{r.state === 'failed' ? 'Update failed' : `REDhelm ${r.latest} is out`}</Text>
      <Box flexShrink={0}>
        <Button key="update" plain dimColor label={r.state === 'failed' ? 'Retry' : 'Update'} hover={{ bold: true, scope: 'update' }} onPress={act.update} />
      </Box>
    </Box>
  )
}

/** On the classic screen the terminal keeps the mouse, so no button here can be pressed. */
function NoClicks({ els }: { els: Els }) {
  const { Text } = els
  return <Text color="warning" wrap="truncate-end">Buttons need the fullscreen layout: run /tui fullscreen</Text>
}

// Shapes

/** Right dock: tall and narrow. Below 30 columns the trace halves so names and times keep their room. */
function Tall({ els, v, act, columns, classic }: { els: Els; v: View; act: Actions; columns: number; classic: boolean }) {
  const { Box } = els
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked)
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status))
  const done = strips.filter(s => !s.cocked && !LIVE.has(s.agent.status))
  const cells = columns < 30 ? 4 : 8
  // A plate of the backdrop's colour under a loose line, so its text never lands on the pattern.
  const plate = (child: any) => (v.field ? <Box backgroundColor={v.field} flexDirection="column">{child}</Box> : child)
  return (
    <Box flexDirection="column" gap={1} width={columns}>
      <Box flexDirection="column" backgroundColor={v.field}>
        <Header els={els} v={v} />
        <Spectrum els={els} v={v} width={columns} />
      </Box>
      {classic && plate(<NoClicks els={els} />)}
      {v.composing && plate(<Composer els={els} v={v} act={act} />)}
      <ModelNotice els={els} v={v} />
      <SetupCard els={els} v={v} act={act} />
      {needs.map(s => <QuestionCard key={`n-${s.agent.id}`} els={els} s={s} v={v} act={act} columns={columns} />)}
      {working.length > 0 && (
        <Box flexDirection="column" rowGap={1}>
          {working.map(s => <Row key={s.agent.id} els={els} s={s} v={v} act={act} columns={columns} cells={cells} />)}
        </Box>
      )}
      <Finished els={els} v={v} act={act} strips={done} columns={columns} cells={cells} />
      {overlaps(v.agents).length > 0 && plate(<Overlaps els={els} v={v} />)}
      <Workflows els={els} v={v} />
      {v.release && plate(<Update els={els} v={v} act={act} />)}
    </Box>
  )
}

/**
 * The backdrop behind REDhelm: a Raster the size of the pane, drawn first so everything else sits on
 * top, and a floor of its colour so a short panel or a sheet never shows the pane's own grey.
 */
export function Backdropped({ els, v, backdrop, columns, rows, children }: { els: Els; v: View; backdrop?: string; columns: number; rows: number; children: any }) {
  const { Box, Raster } = els
  if (!v.field) return <Box flexDirection="column">{children}</Box>
  return (
    <Box flexDirection="column" position="relative" width={columns} minHeight={rows} backgroundColor={v.field}>
      {backdrop && Raster && (
        <Box position="absolute" top={0} left={0}>
          <Raster key="backdrop" columns={columns} rows={rows} cells={backdrop} />
        </Box>
      )}
      {children}
    </Box>
  )
}

/** One line for an agent that asked you something, for the short bottom bar. */
function NeedsLine({ els, s, v, act, name }: { els: Els; s: Strip; v: View; act: Actions; name: number }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const ask = s.messages.at(-1)!
  return (
    <Box>
      <Box width={1} flexShrink={0} backgroundColor="warning" />
      <Box width={1} flexShrink={0} />
      <Glyph els={els} state="asks" />
      <Box width={name} flexShrink={0}>
        <Button key={`sel-${a.id}`} plain label={fit(label(a, v.lanes), name - 1)} hover={{ underline: true, scope: `sel-${a.id}` }} onPress={() => act.inspect(a.id)} />
      </Box>
      <Box flexShrink={0} marginRight={1}><Text bold color="inverseText" backgroundColor="warning"> Asks you </Text></Box>
      <Box flexGrow={1} flexShrink={1}><Text bold wrap="truncate-end">{ask.title ?? firstAsk(ask.text, 160)}</Text></Box>
      <Box flexShrink={0} columnGap={1} marginLeft={2}>
        {v.composing === a.id
          ? <Text color="warning">↓ type below</Text>
          : <Chip els={els} v={v} k={`compose-${a.id}`} text="Reply" primary onPress={() => act.compose(a.id)} />}
        {!LIVE.has(a.status) && <Chip els={els} v={v} k={`dismiss-${a.id}`} text="Dismiss" onPress={() => act.dismiss(a.id)} />}
        <Button key={`more-${a.id}`} plain dimColor label="Details ›" hover={{ bold: true, scope: `more-${a.id}` }} onPress={() => act.inspect(a.id)} />
      </Box>
    </Box>
  )
}

/** One line for a working agent in the bottom bar: the same grid laid flat, names in one aligned column. */
function WideRow({ els, s, v, act, name }: { els: Els; s: Strip; v: View; act: Actions; name: number }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const scope = `row-${a.id}`
  const older = isStale(a.model, v.guard.stale ?? v.guard.model)
  return (
    <Box key={scope} position="relative" hover={{ backgroundColor: tone(v).hover, scope }}>
      <Box width={1} flexShrink={0} backgroundColor={hue(a.id)} />
      <Box width={1} flexShrink={0} />
      <Glyph els={els} state={stateOf(a, v.now)} />
      <Box width={name} flexShrink={0}>
        <Button key={`sel-${a.id}`} plain label={fit(label(a, v.lanes), name - (older ? 3 : 1))} hover={{ underline: true, scope }} onPress={() => act.inspect(a.id)} />
        {older && <Text color="warning"> ◷</Text>}
      </Box>
      <Trace els={els} v={v} a={a} k={`trace-${a.id}`} cells={8} />
      <Box flexGrow={1} flexShrink={1} marginLeft={2}><Text color="subtle" wrap="truncate-end">{headlineOf(a, v.now)}</Text></Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end"><Text color="subtle">{when(a, v)}</Text></Box>
      <Box marginLeft={1} flexShrink={0}>
        <Button key={`open-${a.id}`} plain dimColor label="›" hover={{ bold: true, scope }} onPress={() => act.inspect(a.id)} />
      </Box>
      {v.composing !== a.id && <HoverActions els={els} v={v} a={a} act={act} right={9} />}
    </Box>
  )
}

/** Bottom: wide and short. The same pieces, one line each; nothing wraps. */
function Wide({ els, v, act, columns, rows, rule, classic }: { els: Els; v: View; act: Actions; columns: number; rows: number; rule: boolean; classic: boolean }) {
  const { Box, Text } = els
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked)
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status))
  const room = Math.max(0, rows - (rule ? 2 : 1) - (classic ? 1 : 0) - (v.composing ? 1 : 0) - (v.setup.length ? v.setup.length + 4 : 0)) // the rule, the header, the hint, the composer
  const shownNeeds = needs.slice(0, room)
  const shownWorking = working.slice(0, Math.max(0, room - shownNeeds.length))
  const hidden = needs.length + working.length - shownNeeds.length - shownWorking.length
  const right = v.guard.fallback || v.guard.stale ? null : relevant(v).map(summary).filter(Boolean).join('   ')
  // One name column for every line, as wide as the longest name shown (within reason).
  const name = Math.min(22, Math.max(8, ...[...shownNeeds, ...shownWorking].map(s => label(s.agent, v.lanes).length + 3)))
  return (
    <Box flexDirection="column" width={columns}>
      {rule && <Text color={tone(v).rule}>{'─'.repeat(Math.max(1, columns))}</Text>}
      <Box justifyContent="space-between" gap={3}>
        <Box flexShrink={0} gap={3}>
          <Header els={els} v={v} />
          <Spectrum els={els} v={v} width={20} />
          <Update els={els} v={v} act={act} />
        </Box>
        {right ? <Text color="subtle" wrap="truncate-end">{right}</Text> : <WideNotice els={els} v={v} />}
      </Box>
      {classic && <NoClicks els={els} />}
      <Composer els={els} v={v} act={act} />
      <SetupCard els={els} v={v} act={act} />
      {shownNeeds.map(s => <NeedsLine key={`n-${s.agent.id}`} els={els} s={s} v={v} act={act} name={name} />)}
      {shownWorking.map(s => <WideRow key={s.agent.id} els={els} s={s} v={v} act={act} name={name} />)}
      {hidden > 0 && <Text color="subtle">{`+${hidden} more · /redhelm right shows them all`}</Text>}
    </Box>
  )
}

/** The model notice as one line, for the bar. */
function WideNotice({ els, v }: { els: Els; v: View }) {
  const { Text } = els
  const g = v.guard
  if (!g.fallback && !g.stale) return null
  return g.fallback
    ? <Text wrap="truncate-end"><Text bold color="error">✕ Model changed</Text><Text color="subtle"> {g.fallback} · /model to choose</Text></Text>
    : <Text wrap="truncate-end"><Text bold color="warning">◷ Older model</Text><Text color="subtle"> default is now {short(g.stale)} · /model</Text></Text>
}

/**
 * `rule`: draw the divider (the band above the prompt has no border of its own; a pane does).
 * `classic`: drawn on the main screen, not fullscreen, where the mouse never reaches the buttons.
 */
export type Shape = { kind: 'tall' | 'wide'; columns: number; rows: number; rule?: boolean; classic?: boolean }

export function Panel({ els, v, act, shape }: { els: Els; v: View; act: Actions; shape: Shape }) {
  return shape.kind === 'tall'
    ? <Tall els={els} v={v} act={act} columns={shape.columns} classic={!!shape.classic} />
    : <Wide els={els} v={v} act={act} columns={shape.columns} rows={shape.rows} rule={!!shape.rule} classic={!!shape.classic} />
}

/** With the panel closed: one line above the prompt, only when something needs you. */
export function Alert({ els, v, act }: { els: Els; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const first = rack(v).find(s => s.cocked)
  const ask = first?.messages.at(-1)
  const body = v.guard.fallback
    ? <Text wrap="truncate-end"><Text bold color="error">✕ Model changed</Text><Text color="subtle"> · run /model to choose</Text></Text>
    : first && ask
      ? (
        <Box flexShrink={1}>
          <Glyph els={els} state="asks" />
          <Box flexShrink={0} marginRight={2}><Text bold>{label(first.agent, v.lanes)}</Text></Box>
          <Text wrap="truncate-end">{ask.title ?? firstAsk(ask.text)}</Text>
        </Box>
      )
      : v.setup.length
        ? <Text wrap="truncate-end"><Text bold>Finish setting up REDhelm</Text><Text color="subtle"> · {v.setup.length} settings to review</Text></Text>
        : null
  if (!body) return null
  return (
    <Box justifyContent="space-between" gap={2}>
      {body}
      <Box flexShrink={0}>
        <Button key="open-redhelm" plain label="Open REDhelm" hover={{ bold: true, scope: 'open-redhelm' }} onPress={act.open} />
      </Box>
    </Box>
  )
}
