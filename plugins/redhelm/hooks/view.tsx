import type { Elements } from 'claude-code'

import type { Agent, Guard, Message, Note, Release, SetupItem, Workspace } from '../types'
import { capital, doing, excerpt, grouped, isStale, kilo, looksLikeQuestion, minutes, modelWords, overlaps, short } from './model'

/**
 * REDhelm looks like an app, not a log: agents sit on cards with a colored initial, what needs
 * you carries a badge and filled buttons, and every agent opens into a sheet with its full
 * context. Plain sentences throughout; nothing to decode.
 */

/** The elements every surface has (typed, so a prop no surface takes fails tsc). */
type Table = Elements['terminal']
export type Els = Pick<Table, 'Box' | 'Text' | 'Button'> & { Input?: Table['Input'] }

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
}

// Tokens: surfaces follow the theme; meaning colors are the theme's own keys

const PALETTE = {
  dark: { card: '#1c1c21', chip: '#2c2c33', chipHover: '#3a3a42', primary: '#d6363c', primaryHover: '#e5484d', rule: '#2c2c33' },
  light: { card: '#f2f2f5', chip: '#e2e2e7', chipHover: '#d4d4db', primary: '#fbd5d6', primaryHover: '#f8c1c3', rule: '#e2e2e7' },
} as const

const AVATARS = ['#4f8ff7', '#a777f2', '#22b8a6', '#f0883e', '#e8659a', '#8cc152']

const tone = (v: View) => PALETTE[v.theme] ?? PALETTE.dark

/** The same color for an agent everywhere it appears. */
const avatarColor = (id: string) => AVATARS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATARS.length]!

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

/** "1 needs you · 2 working", "3 finished", "No agents running" */
const counts = (v: View) => {
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked).length
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status)).length
  const done = strips.length - needs - working
  const parts = [needs && `${needs} needs you`, working && `${working} working`, !needs && !working && done && `${done} finished`]
  return parts.filter(Boolean).join(' · ') || 'No agents running'
}

const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${minutes(ms)} ago`)

/** A workspace's name, short: "Demo app (web folder) — beta" → "Demo app". */
export const shortName = (name: string) => name.split(/\s[(—–-]\s?/)[0]!.trim() || name

// Primitives

function Brand({ els }: { els: Els }) {
  const { Text } = els
  return <Text><Text bold color="error">RED</Text><Text bold>helm</Text></Text>
}

/** A colored initial: how you recognize an agent at a glance. */
function Avatar({ els, a, v }: { els: Els; a: Agent; v: View }) {
  const { Text } = els
  return <Text bold color="inverseText" backgroundColor={avatarColor(a.id)}> {label(a, v.lanes).charAt(0)} </Text>
}

function Badge({ els, text, color }: { els: Els; text: string; color: string }) {
  const { Text } = els
  return <Text bold color="inverseText" backgroundColor={color} wrap="truncate-end"> {text} </Text>
}

/** A filled button: the primary one in REDhelm red, the rest quiet. */
function Chip({ els, v, k, text, primary, onPress }: { els: Els; v: View; k: string; text: string; primary?: boolean; onPress: () => void }) {
  const { Box, Button } = els
  const t = tone(v)
  return (
    <Box backgroundColor={primary ? t.primary : t.chip} paddingX={2} flexShrink={0}>
      <Button key={k} plain label={text} hover={{ bold: true, backgroundColor: primary ? t.primaryHover : t.chipHover, scope: k }} onPress={onPress} />
    </Box>
  )
}

/** A filled surface: what makes a group read as one thing. */
function Card({ els, v, children }: { els: Els; v: View; children: any }) {
  const { Box } = els
  return <Box flexDirection="column" backgroundColor={tone(v).card} paddingX={2} paddingY={1}>{children}</Box>
}

function Header({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  return (
    <Box justifyContent="space-between" gap={2}>
      <Brand els={els} />
      <Text color="subtle">{counts(v)}</Text>
    </Box>
  )
}

/** Only a problem with the model earns space; the status line shows the model otherwise. */
function ModelNotice({ els, v }: { els: Els; v: View }) {
  const { Box, Text } = els
  const g = v.guard
  if (!g.fallback && !g.stale) return null
  return (
    <Card els={els} v={v}>
      <Box gap={1}>
        <Badge els={els} text={g.fallback ? 'Model changed' : 'Older model'} color={g.fallback ? 'error' : 'warning'} />
        <Text wrap="wrap">
          {g.fallback ? `Claude Code switched models without you (${g.fallback}).` : `This session runs ${short(g.model)}; your default is now ${short(g.stale)}.`} Run /model to choose.
        </Text>
      </Box>
    </Card>
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

function AgentButtons({ els, s, v, act, primary }: { els: Els; s: Strip; v: View; act: Actions; primary: string }) {
  const { Box } = els
  const a = s.agent
  if (v.composing === a.id) return <els.Text color="warning">↓ type below</els.Text>
  // In a narrow sidebar a button moves to the next line rather than breaking its label.
  return (
    <Box gap={1} flexWrap="wrap">
      <Chip els={els} v={v} k={`compose-${a.id}`} text={primary} primary onPress={() => act.compose(a.id)} />
      {LIVE.has(a.status) && <Chip els={els} v={v} k={`stop-${a.id}`} text="Stop" onPress={() => act.stop(a.id)} />}
      {!LIVE.has(a.status) && s.cocked && <Chip els={els} v={v} k={`dismiss-${a.id}`} text="Dismiss" onPress={() => act.dismiss(a.id)} />}
      {v.inspecting !== a.id && <Chip els={els} v={v} k={`more-${a.id}`} text="Details" onPress={() => act.inspect(a.id)} />}
    </Box>
  )
}

/** An agent that asked you something: who, what it is on, the question, and what you can do. */
function NeedsCard({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const ask = s.messages.at(-1)!
  const name = label(a, v.lanes)
  const task = a.description && a.description.toLowerCase() !== name.toLowerCase() ? a.description : undefined
  return (
    <Card els={els} v={v}>
      {/* Narrow: the name wraps but keeps a few letters, and the time moves to the next line. */}
      <Box justifyContent="space-between" columnGap={2} flexWrap="wrap">
        <Box columnGap={1} flexShrink={1} flexWrap="wrap">
          <Box flexShrink={0}><Avatar els={els} a={a} v={v} /></Box>
          <Box flexShrink={1} minWidth={8}>
            <Button key={`sel-${a.id}`} plain label={name} hover={{ underline: true, scope: `sel-${a.id}` }} onPress={() => act.inspect(a.id)} />
          </Box>
          <Box flexShrink={0}><Badge els={els} text="Asks you" color="warning" /></Box>
        </Box>
        <Text color="subtle" wrap="truncate-end">{ago(v.now - ask.at)}</Text>
      </Box>
      {task && <Text color="subtle" wrap="truncate-end">{task}</Text>}
      <Box marginY={1}>
        <Text wrap="wrap">{ask.text.trim().slice(0, 600)}</Text>
      </Box>
      <AgentButtons els={els} s={s} v={v} act={act} primary="Reply" />
    </Card>
  )
}

/** A working agent: avatar, one plain sentence, how long; the whole row opens its sheet. */
function AgentRow({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const older = isStale(a.model, v.guard.stale ?? v.guard.model)
  return (
    <Box justifyContent="space-between" gap={2}>
      <Box gap={1} flexShrink={1}>
        <Box gap={1} flexShrink={0}>
          <Avatar els={els} a={a} v={v} />
          <Button key={`sel-${a.id}`} plain label={label(a, v.lanes)} hover={{ underline: true, scope: `row-${a.id}` }} onPress={() => act.inspect(a.id)} />
        </Box>
        <Text color="subtle" wrap="truncate-end">{doing(a, v.now)}</Text>
        {older && <Box flexShrink={0}><Badge els={els} text="Older model" color="warning" /></Box>}
      </Box>
      <Box gap={2} flexShrink={0}>
        <Text color="subtle">{minutes(v.now - a.startedAt)}</Text>
        <Button key={`open-${a.id}`} plain dimColor label="›" hover={{ bold: true, scope: `row-${a.id}` }} onPress={() => act.inspect(a.id)} />
      </Box>
    </Box>
  )
}

/** Finished agents fold into one line until you ask for them. */
function Finished({ els, v, act, strips }: { els: Els; v: View; act: Actions; strips: Strip[] }) {
  const { Box, Text, Button } = els
  if (!strips.length) return null
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" gap={2}>
        <Text color="subtle" wrap="truncate-end">{strips.length} finished · last: {label(strips[0]!.agent, v.lanes)}</Text>
        <Button key="toggle-done" plain dimColor label={v.showDone ? 'Hide' : 'Show'} onPress={act.toggleDone} />
      </Box>
      {v.showDone && strips.slice(0, 8).map(s => (
        <Box key={`d-${s.agent.id}`} gap={1}>
          <Avatar els={els} a={s.agent} v={v} />
          <Button key={`sel-${s.agent.id}`} plain dimColor label={label(s.agent, v.lanes)} onPress={() => act.inspect(s.agent.id)} />
          <Text color="subtle" wrap="truncate-end">{doing(s.agent, v.now)}{s.agent.answer ? `: ${excerpt(s.agent.answer, 80)}` : ''}</Text>
        </Box>
      ))}
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
        <Box key={`c-${c.file}`} gap={1}>
          <Badge els={els} text="Same file" color="warning" />
          <Text wrap="wrap">{names(c.ids)} are both editing {c.file.split('/').pop()}</Text>
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

/** One row of the sheet: a quiet label column and its value. */
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
      <Box width={13} flexShrink={0}><Text color="subtle">{name}</Text></Box>
      <Box flexDirection="column" flexShrink={1}>{children}</Box>
    </Box>
  )
}

export function Sheet({ els, v, act, columns }: { els: Els; v: View; act: Actions; columns: number }) {
  const { Box, Text, Button } = els
  const a = v.agents.find(x => x.id === v.inspecting)
  if (!a) return <Text color="subtle">This agent is no longer listed.</Text>
  const s = rack(v).find(x => x.agent.id === a.id)!
  const ask = s.messages.at(-1)
  const live = LIVE.has(a.status)
  const stacked = columns < 50
  const brief = a.brief?.trim()
  const long = !!brief && brief.length > 280
  return (
    <Box flexDirection="column" gap={1} width={columns}>
      <Box justifyContent="space-between" gap={2}>
        <Box gap={1} flexShrink={0}>
          <Avatar els={els} a={a} v={v} />
          <Text bold>{label(a, v.lanes)}</Text>
          {ask && <Badge els={els} text="Asks you" color="warning" />}
        </Box>
        <Text color="subtle" wrap="truncate-end">{doing(a, v.now)} · {minutes((a.endedAt ?? v.now) - a.startedAt)}</Text>
      </Box>

      {/* What you can do comes first, so a long sheet never pushes it out of sight. */}
      <Box justifyContent="space-between" gap={2}>
        {live || ask ? <AgentButtons els={els} s={s} v={v} act={act} primary={ask ? 'Reply' : 'Message'} /> : <Text color="subtle">This agent has finished.</Text>}
        <Text color="subtle">Esc to close</Text>
      </Box>

      {ask && (
        <Card els={els} v={v}>
          <Text color="subtle">Asks you · {ago(v.now - ask.at)}</Text>
          <Text wrap="wrap">{ask.text.trim().slice(0, 1200)}</Text>
        </Card>
      )}

      <Box flexDirection="column" gap={1}>
        {brief && (
          <Field els={els} stacked={stacked} name="Asked to">
            <Text wrap="wrap">{v.briefOpen || !long ? brief : `${brief.slice(0, 280).trimEnd()}…`}</Text>
            {long && <Button key="brief-more" plain dimColor label={v.briefOpen ? 'Less' : 'More'} onPress={act.toggleBrief} />}
          </Field>
        )}
        {!brief && a.description && <Field els={els} stacked={stacked} name="Working on"><Text wrap="wrap">{a.description}</Text></Field>}
        {a.steps?.length > 0 && (
          <Field els={els} stacked={stacked} name="Recent steps">
            {grouped(a.steps).slice(0, 6).map((st, i) => (
              <Box key={`st-${i}`} justifyContent="space-between" gap={2}>
                <Text wrap="truncate-end">{st.text}{st.count > 1 ? <Text color="subtle"> ×{st.count}</Text> : ''}</Text>
                {st.at !== undefined && <Box flexShrink={0}><Text color="subtle">{ago(v.now - st.at)}</Text></Box>}
              </Box>
            ))}
          </Field>
        )}
        {!brief && !a.description && !a.steps?.length && !a.thinking && !a.answer && (
          <Text color="subtle" wrap="wrap">This agent started before REDhelm, and Claude Code has no record of its work to show.</Text>
        )}
        {/* Once it has finished, its last words say it; thinking would only repeat them. */}
        {live && a.thinking && <Field els={els} stacked={stacked} name="Thinking"><Text color="subtle" wrap="wrap">{a.thinking}</Text></Field>}
        <Field els={els} stacked={stacked} name="Changed">
          <Text wrap="truncate-end">{a.files.length ? a.files.slice(-4).map(f => f.split('/').pop()).join(', ') + (a.files.length > 4 ? ` and ${a.files.length - 4} more` : '') : 'nothing yet'}</Text>
        </Field>
        {a.model && <Field els={els} stacked={stacked} name="Model"><Text>{modelWords(a.model, a.effort)}{a.context ? ` · ${kilo(a.context)} tokens of context` : ''}</Text></Field>}
        {(a.answer || (!live && a.thinking)) && <Field els={els} stacked={stacked} name="Last said"><Text color="subtle" wrap="wrap">{a.answer || a.thinking}</Text></Field>}
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

/** Right dock: tall and narrow. */
function Tall({ els, v, act, columns, classic }: { els: Els; v: View; act: Actions; columns: number; classic: boolean }) {
  const { Box, Text } = els
  const strips = rack(v)
  const needs = strips.filter(s => s.cocked)
  const working = strips.filter(s => !s.cocked && LIVE.has(s.agent.status))
  const done = strips.filter(s => !s.cocked && !LIVE.has(s.agent.status))
  return (
    <Box flexDirection="column" gap={1} width={columns}>
      <Header els={els} v={v} />
      {classic && <NoClicks els={els} />}
      <Composer els={els} v={v} act={act} />
      <ModelNotice els={els} v={v} />
      <SetupCard els={els} v={v} act={act} />
      {needs.map(s => <NeedsCard key={`n-${s.agent.id}`} els={els} s={s} v={v} act={act} />)}
      {working.length > 0 && (
        <Box flexDirection="column">
          {working.map(s => <AgentRow key={s.agent.id} els={els} s={s} v={v} act={act} />)}
        </Box>
      )}
      {!strips.length && <Text color="subtle">Agents you start show up here.</Text>}
      <Finished els={els} v={v} act={act} strips={done} />
      <Overlaps els={els} v={v} />
      <Workflows els={els} v={v} />
      <Update els={els} v={v} act={act} />
    </Box>
  )
}

/** One line for an agent that asked you something, for the short bottom bar. */
function NeedsLine({ els, s, v, act }: { els: Els; s: Strip; v: View; act: Actions }) {
  const { Box, Text, Button } = els
  const a = s.agent
  const ask = s.messages.at(-1)!
  return (
    <Box justifyContent="space-between" gap={2}>
      <Box gap={1} flexShrink={1}>
        <Box gap={1} flexShrink={0}>
          <Avatar els={els} a={a} v={v} />
          <Button key={`sel-${a.id}`} plain label={label(a, v.lanes)} hover={{ underline: true, scope: `sel-${a.id}` }} onPress={() => act.inspect(a.id)} />
          <Badge els={els} text="Asks you" color="warning" />
        </Box>
        <Text wrap="truncate-end">{excerpt(ask.text, 160)}</Text>
      </Box>
      <Box flexShrink={0}>
        <AgentButtons els={els} s={s} v={v} act={act} primary="Reply" />
      </Box>
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
  return (
    <Box flexDirection="column" width={columns}>
      {rule && <Text color={tone(v).rule}>{'─'.repeat(Math.max(1, columns))}</Text>}
      <Box justifyContent="space-between" gap={3}>
        <Box flexShrink={0} gap={2}>
          <Brand els={els} />
          <Text color="subtle">{counts(v)}</Text>
          <Update els={els} v={v} act={act} />
        </Box>
        {right ? <Text color="subtle" wrap="truncate-end">{right}</Text> : <ModelNotice els={els} v={v} />}
      </Box>
      {classic && <NoClicks els={els} />}
      <Composer els={els} v={v} act={act} />
      <SetupCard els={els} v={v} act={act} />
      {shownNeeds.map(s => <NeedsLine key={`n-${s.agent.id}`} els={els} s={s} v={v} act={act} />)}
      {shownWorking.map(s => <AgentRow key={s.agent.id} els={els} s={s} v={v} act={act} />)}
      {hidden > 0 && <Text color="subtle">and {hidden} more · /redhelm right shows them all</Text>}
    </Box>
  )
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
    ? <Box gap={1}><Badge els={els} text="Model changed" color="error" /><Text wrap="truncate-end">Run /model to choose.</Text></Box>
    : first && ask
      ? (
        <Box gap={1} flexShrink={1}>
          <Box gap={1} flexShrink={0}>
            <Avatar els={els} a={first.agent} v={v} />
            <Text bold wrap="truncate-end">{label(first.agent, v.lanes)}</Text>
            <Badge els={els} text="Asks you" color="warning" />
          </Box>
          <Text wrap="truncate-end">{excerpt(ask.text, 90)}</Text>
        </Box>
      )
      : v.setup.length
        ? <Text wrap="truncate-end"><Text bold>Finish setting up REDhelm</Text><Text color="subtle"> · {v.setup.length} settings to review</Text></Text>
        : null
  if (!body) return null
  return (
    <Box justifyContent="space-between" gap={2}>
      {body}
      <Button key="open-redhelm" plain label="Open REDhelm" onPress={act.open} />
    </Box>
  )
}
