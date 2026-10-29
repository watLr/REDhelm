import type { Agent, Draft, SavedAgent, SavedRole } from '../types'
import { hash } from './labels'
import { family } from './model'

/**
 * Reading a session for Save: where its stretches begin, the skills the lead loaded, the agents it
 * started, the stages they ran in, the roles they filled, the brief parts they shared, and the lead's
 * steps as a numbered trace. Pure: the conversation and REDhelm's records in, a draft out.
 */

export type Use = { tool: string; input: Record<string, unknown>; isError?: boolean; agentId?: string; result?: unknown }
/** Claude Code stores each content block as its own message, and a tool result is a user message. */
export type Msg = { role: 'user' | 'assistant'; text: string; toolUses: readonly Use[]; toolResults?: readonly unknown[] }
export type AgentInput = { description: string; prompt: string; subagent_type?: string; model?: string; effort?: string; name?: string; run_in_background?: boolean; isolation?: 'worktree' | 'remote' }
/** Message indexes, `to` exclusive; `led`: a lead skill loaded before its first agent. */
export type Stretch = { from: number; to: number; led: boolean }
/** One agent the lead started: the message it was started in, and the call. `at` is that lead message's first index. */
export type Call = { at: number; agentId: string; input: AgentInput }

/** How a background task's finish (an agent's or a workflow's) reaches the lead: a user message that begins with this. */
const NOTICE = '<task-notification>'
/** How a user message you did not write begins: a finished agent, a command's output, a reminder, an interruption. */
const NOT_YOURS = [NOTICE, '<local-command', '<system-reminder>', '[Request interrupted']

/** Whether a message is a prompt you wrote. A `/` command is one. */
export function isPrompt(m: Msg) {
  const text = m.text.trimStart()
  return m.role === 'user' && !!text && !m.toolResults?.length && !NOT_YOURS.some(p => text.startsWith(p))
}

const COMMAND = /<command-name>\/([^<]+)<\/command-name>/

/** The skill a `/` command at `i` loaded: one the model went on to answer. A built-in like /effort gets no answer. */
function slashSkill(msgs: readonly Msg[], i: number) {
  const m = msgs[i]!
  const name = isPrompt(m) ? COMMAND.exec(m.text)?.[1]?.trim() : undefined
  return name && msgs[i + 1]?.role === 'assistant' ? name : undefined
}

function skillOf(u: Use) {
  const name = u.input.skill
  return u.tool === 'Skill' && !u.isError && typeof name === 'string' && name ? name : undefined
}

/** An Agent call that started an agent; a failed or refused one has an error or no agent. */
const started = (u: Use) => u.tool === 'Agent' && !u.isError && !!u.agentId

/** What message `i` did, in order: the name of a skill it loaded, or the Agent call that started an agent. */
function acts(msgs: readonly Msg[], i: number): (string | Use)[] {
  const m = msgs[i]!
  if (m.role === 'user') {
    const name = slashSkill(msgs, i)
    return name ? [name] : []
  }
  return m.toolUses.flatMap((u): (string | Use)[] => {
    const name = skillOf(u)
    return name ? [name] : started(u) ? [u] : []
  })
}

const end = (msgs: readonly Msg[], to: number) => Math.min(to, msgs.length)

/** The object without its undefined fields, so a draft and the file saved from it read alike. */
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** Whether the assistant message at `i` opens a lead message: the one before it is not the lead's too. */
const opens = (msgs: readonly Msg[], i: number) => msgs[i - 1]?.role !== 'assistant'

/** The index of each of the lead's messages in the stretch, with the first index of the lead message it is part of. */
function* leadMessages(msgs: readonly Msg[], s: Stretch): Generator<[at: number, i: number]> {
  let at = s.from
  for (let i = s.from; i < end(msgs, s.to); i++) {
    if (msgs[i]!.role !== 'assistant') continue
    if (opens(msgs, i)) at = i
    yield [at, i]
  }
}

/** The message of the first skill the lead loaded before the first agent it started between `from` and `to`, if it did. */
function loadBefore(msgs: readonly Msg[], from: number, to: number) {
  let load: number | undefined
  for (let i = from; i < end(msgs, to); i++)
    for (const a of acts(msgs, i)) {
      if (typeof a !== 'string') return load
      load ??= i
    }
  return undefined
}

/**
 * Your prompts split the session: a stretch begins at a prompt after which the lead started an agent,
 * and holds your prompts after it that started none. A skill loaded since the stretch before started
 * its agents, and before this one's first, leads: the stretch begins at your prompt before that load
 * and runs to the end.
 */
export function stretches(msgs: readonly Msg[]): Stretch[] {
  const prompts = msgs.flatMap((m, i) => (isPrompt(m) ? [i] : []))
  const starts = prompts.filter((from, k) => agentCalls(msgs, { from, to: prompts[k + 1] ?? msgs.length, led: false }).length > 0)
  const out: Stretch[] = []
  for (const [k, start] of starts.entries()) {
    const next = starts[k + 1] ?? msgs.length
    // The first prompt after the stretch before's agents: a skill loaded earlier was loaded inside it.
    const gap = k ? prompts[prompts.indexOf(starts[k - 1]!) + 1]! : prompts[0]!
    const load = loadBefore(msgs, gap, next)
    const from = load === undefined ? start : prompts.findLast(p => p <= load)!
    const led = load !== undefined
    const before = out[out.length - 1]
    if (before) before.to = from
    out.push({ from, to: led ? msgs.length : next, led })
    if (led) break
  }
  return out
}

/** What Earlier opens: the latest stretch with the `back` before it. Led as the oldest of them was; empty when there is none. */
export function widen(list: readonly Stretch[], back: number): Stretch {
  const last = list[list.length - 1]
  if (!last) return { from: 0, to: 0, led: false }
  const first = list[Math.max(0, list.length - 1 - Math.max(0, back))]!
  return { from: first.from, to: last.to, led: first.led }
}

/** The skills the lead loaded in the stretch, by the Skill tool or a `/` command, once each, in order. */
export function leadSkills(msgs: readonly Msg[], s: Stretch): string[] {
  const out: string[] = []
  for (let i = s.from; i < end(msgs, s.to); i++)
    for (const a of acts(msgs, i)) if (typeof a === 'string' && !out.includes(a)) out.push(a)
  return out
}

/**
 * The agents the lead started in the stretch, in order. One lead message is a run of assistant
 * messages with no user message between, so a tool result between two calls splits it.
 */
export function agentCalls(msgs: readonly Msg[], s: Stretch): Call[] {
  const out: Call[] = []
  for (const [at, i] of leadMessages(msgs, s))
    for (const a of acts(msgs, i)) if (typeof a !== 'string') out.push({ at, agentId: a.agentId!, input: a.input as AgentInput })
  return out
}

/** A field of a Workflow tool use's result: its `runId`, or the `taskId` its finish notice names. */
function workflowResult(u: Use, field: 'runId' | 'taskId') {
  const id = u.tool === 'Workflow' && !u.isError ? (u.result as Record<string, unknown> | null | undefined)?.[field] : undefined
  return typeof id === 'string' && id ? id : undefined
}

/** A run agent as the Agent tool would take it, from its record: what ran, the model by its family. */
const runInput = (r: Agent): AgentInput =>
  compact({
    description: r.description,
    prompt: (r.brief ?? '').slice(0, 2000),
    // The Agent tool cannot start a `workflow-subagent`.
    subagent_type: !r.type || r.type === 'workflow-subagent' ? 'general-purpose' : r.type,
    model: r.model?.startsWith('claude-') ? family(r.model) : r.model,
    effort: r.effort,
  })

/**
 * The agents of the built-in workflow runs the lead started in the stretch, from REDhelm's records,
 * in start order, never from the run's script. `at` is the lead message that started the run. An
 * agent one of them started is theirs, not the run's: it counts only in its parent's tools.
 */
export function runCalls(msgs: readonly Msg[], s: Stretch, records: Record<string, Agent>): Call[] {
  const runs = new Map<string, number>()
  for (const [at, i] of leadMessages(msgs, s))
    for (const u of msgs[i]!.toolUses) {
      const run = workflowResult(u, 'runId')
      if (run && !runs.has(run)) runs.set(run, at)
    }
  return Object.values(records)
    .filter(r => r.run !== undefined && runs.has(r.run) && !r.parent)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(r => ({ at: runs.get(r.run!)!, agentId: r.id, input: runInput(r) }))
}

/** Whether a recorded agent was running at `t`. */
const running = (r: Agent | undefined, t: number) => !!r && r.startedAt <= t && t < (r.endedAt ?? Infinity)

/** Started by the same lead message. A run's agents were started by its script, so only their times place them. */
const together = (a: Call, b: Call, records: Record<string, Agent>) =>
  a.at === b.at && !records[a.agentId]?.run && !records[b.agentId]?.run

/**
 * The lineup, calls in start order: an agent joins the stage when the same lead message started an
 * agent of it, or when it started while one of it was running; otherwise it opens the next stage.
 * An agent REDhelm has no record of joins by the lead message alone.
 */
export function stagesOf(calls: readonly Call[], records: Record<string, Agent>): Call[][] {
  const stages: Call[][] = []
  for (const c of calls) {
    const stage = stages[stages.length - 1]
    const t = records[c.agentId]?.startedAt
    if (stage?.some(x => together(x, c, records) || (t !== undefined && running(records[x.agentId], t)))) stage.push(c)
    else stages.push([c])
  }
  return stages
}

/** A missing `subagent_type` reads as general-purpose. */
const typeOf = (input: AgentInput) => input.subagent_type || 'general-purpose'

/** The same type, and the same name or the same description. */
const alike = (a: Call, b: Call) =>
  typeOf(a.input) === typeOf(b.input) &&
  ((!!a.input.name && a.input.name === b.input.name) || (!!a.input.description && a.input.description === b.input.description))

/**
 * A second round is not another stage: an agent alike to one in an earlier stage is a repeat, counted
 * on the first and not kept. Two alike in one stage are peers, both kept. A stage left empty is dropped.
 */
export function foldRepeats(stages: readonly Call[][]): { stages: Call[][]; folded: { label: string; times: number }[] } {
  /** Each call of the stages so far, with the call kept for it. */
  const before: [call: Call, kept: Call][] = []
  const counts = new Map<Call, { label: string; times: number }>()
  const out: Call[][] = []
  for (const stage of stages) {
    const now = stage.map((c): [Call, Call] => [c, before.find(([b]) => alike(b, c))?.[1] ?? c])
    for (const [c, kept] of now) {
      if (c === kept) continue
      const n = counts.get(kept) ?? { label: kept.input.description, times: 1 }
      n.times++
      counts.set(kept, n)
    }
    before.push(...now)
    const kept = now.filter(([c, k]) => c === k).map(([c]) => c)
    if (kept.length) out.push(kept)
  }
  return { stages: out, folded: [...counts.values()] }
}

/** Roles when a skill loaded before the first agent: that skill led the team. Otherwise the lineup as it ran. */
export function defaultForm(msgs: readonly Msg[], s: Stretch): 'roles' | 'lineup' {
  return loadBefore(msgs, s.from, s.to) === undefined ? 'lineup' : 'roles'
}

// Roles, teams and shared brief parts

/** A label's length, at most. */
const LABEL = 16

/** The first `n` characters, never half of a character written as two. */
const head = (text: string, n: number) => text.slice(0, n).replace(/[\uD800-\uDBFF]$/, '')

/** A label from a description or a type: at most 16 characters, cut at a word where there is one. */
function labelOf(text: string) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= LABEL) return t
  const word = t.lastIndexOf(' ', LABEL)
  return (word > 0 ? t.slice(0, word) : head(t, LABEL)).replace(/[\s,;:.·–—-]+$/, '') || head(t, LABEL)
}

/** Tool counts added into `into`, by their own keys only: a tool named like an Object method still adds up. */
function addTools(into: Record<string, number>, from: Record<string, number> | undefined) {
  for (const [k, n] of Object.entries(from ?? {})) into[k] = (Object.hasOwn(into, k) ? into[k]! : 0) + n
  return into
}

/** Skills joined into `into`, once each, in order. */
function addSkills(into: string[], from: readonly string[] | undefined) {
  for (const s of from ?? []) if (!into.includes(s)) into.push(s)
  return into
}

const someOrNone = <T>(xs: T[]) => (xs.length ? xs : undefined)

/** The agents an agent started in its own conversation. */
const ownCalls = (own: readonly Msg[] | undefined) => (own ? agentCalls(own, { from: 0, to: own.length, led: false }) : [])

/** A role's setup: the same type, model, effort and isolation make one role. */
const setupOf = (i: AgentInput) => JSON.stringify([typeOf(i), i.model, i.effort, i.isolation])

/**
 * The agents as roles, in the order each setup first ran: `ran` counts the agents that filled it,
 * their tools are summed and their skills joined. Labelled by type (a plugin's by its own name, after
 * the colon) until the reading names them; the role line is the reading's. With `teams`, each role
 * gets the roles its agents' own agents filled.
 */
export function groupRoles(calls: readonly Call[], records: Record<string, Agent>, teams?: Record<string, readonly Msg[]>): SavedRole[] {
  const groups = new Map<string, Call[]>()
  for (const c of calls) {
    const k = setupOf(c.input)
    const group = groups.get(k)
    if (group) group.push(c)
    else groups.set(k, [c])
  }
  return [...groups.values()].map(group => {
    const first = group[0]!.input
    const type = typeOf(first)
    const of = (c: Call) => records[c.agentId]
    return compact({
      label: labelOf(type.split(':').pop()!),
      role: '',
      type,
      model: first.model,
      effort: first.effort,
      isolation: first.isolation,
      background: group.some(c => !!c.input.run_in_background),
      teammate: group.some(c => !!of(c)?.teammate),
      tools: group.reduce((t, c) => addTools(t, of(c)?.tools), {}),
      skills: group.reduce((s: string[], c) => addSkills(s, of(c)?.skills), []),
      ran: group.length,
      team: teams && someOrNone(groupRoles(group.flatMap(c => ownCalls(teams[c.agentId])), records)),
    })
  })
}

/** An agent's own agents as roles, one level down: theirs count only in their tools. Undefined when it started none. */
export function teamOf(own: readonly Msg[] | undefined, records: Record<string, Agent>): SavedRole[] | undefined {
  return someOrNone(groupRoles(ownCalls(own), records))
}

/** An agent in the lineup: its call as given, with what REDhelm recorded of its tools and skills. */
function savedAgent(c: Call, records: Record<string, Agent>, teams: Record<string, readonly Msg[]>): SavedAgent {
  const i = c.input
  const r = records[c.agentId]
  return compact({
    label: labelOf(i.description || typeOf(i)),
    description: i.description ?? '',
    brief: i.prompt ?? '',
    type: typeOf(i),
    model: i.model,
    effort: i.effort,
    name: i.name || undefined,
    background: !!i.run_in_background,
    teammate: !!r?.teammate,
    isolation: i.isolation,
    tools: addTools({}, r?.tools),
    skills: addSkills([], r?.skills),
    team: teamOf(teams[c.agentId], records),
  })
}

/** Shared brief parts: at most three, each at most 1,500 characters. */
const PARTS = 3
const PART_LENGTH = 1500

/**
 * Paragraphs (split at blank lines) that at least two briefs and at least half of them hold word for
 * word, once whitespace is evened out: a report format, a rule every agent got. Each is kept as first
 * written, in the order they first appear; when more than three are shared, the three most briefs share.
 * An empty brief (a run agent whose brief REDhelm never saw) is no brief: it does not count against them.
 */
export function sharedParts(all: readonly string[]): string[] {
  const briefs = all.filter(b => b.trim())
  const found = new Map<string, { text: string; briefs: number }>()
  for (const brief of briefs) {
    const here = new Set<string>()
    for (const p of brief.split(/\n\s*\n/)) {
      const text = p.trim()
      const key = text.replace(/\s+/g, ' ')
      if (!key || text.length > PART_LENGTH || here.has(key)) continue
      here.add(key)
      const f = found.get(key)
      if (f) f.briefs++
      else found.set(key, { text, briefs: 1 })
    }
  }
  const shared = [...found.values()].filter(f => f.briefs >= 2 && f.briefs * 2 >= briefs.length)
  const kept = new Set([...shared].sort((a, b) => b.briefs - a.briefs).slice(0, PARTS))
  return shared.filter(f => kept.has(f)).map(f => f.text)
}

// The lead trace

/** A word of a command, a quoted string whole; or the operators between commands and redirections. */
const TOKEN = /(?:[^\s"'&|;()<>]|"(?:[^"\\]|\\.)*"|'[^']*')+|[&|;()<>]+/g
const OPERATOR = /^[&|;()<>]+$/
const ASSIGNMENT = /^[A-Za-z_]\w*=/
/** A subcommand is a plain word: not a flag, a path, a file name or a value. */
const SUBCOMMAND = /^[a-z][\w:-]*$/i
/** The programs whose next word is a subcommand (`git commit`, `npm test`). Any other program's next word is an argument, never kept. */
const HAS_SUBCOMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'deno', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'claude', 'make'])
/** Commands that only set up the one after them. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.'])
/** Programs that run the command after them (`sudo rm`, `env FOO=1 npm test`): the trace names that one. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice'])

/** A program by its name, never its path. */
const program = (word: string) => word.replace(/^["']|["']$/g, '').split('/').pop() || word

/**
 * A command's words from the program it runs: variables set before it and wrappers left out. A
 * wrapper given flags stays, so a flag's value (`sudo -u root`) is never taken for the program.
 */
function unwrap(words: readonly string[]) {
  let k = 0
  while (k < words.length) {
    const next = words[k + 1]
    if (ASSIGNMENT.test(words[k]!) || (WRAPPERS.has(program(words[k]!)) && next !== undefined && !next.startsWith('-'))) k++
    else break
  }
  return words.slice(k)
}

/**
 * A command as the lead trace shows it: the program, and its subcommand when it is one of the few
 * programs that have them; nothing else, so no argument, value or path reaches the trace. The first
 * command that does more than set up the next one (`cd`, `export`) speaks for the line.
 */
export function command(cmd: string): string {
  const commands: string[][] = [[]]
  for (const word of cmd.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ';').match(TOKEN) ?? []) {
    if (OPERATOR.test(word)) commands.push([])
    else commands[commands.length - 1]!.push(word)
  }
  // One that only sets variables is no command.
  const bare = commands.map(unwrap).filter(c => c.length)
  const [first, sub] = bare.find(c => !SETUP.has(program(c[0]!))) ?? bare[0] ?? []
  if (!first) return ''
  const name = program(first)
  return sub && HAS_SUBCOMMANDS.has(name) && SUBCOMMAND.test(sub) ? `${name} ${sub}` : name
}

/**
 * One step of the lead's, numbered from 1. `yours`: your prompt's text, whole, for the numbers check.
 * The line counting the steps left out is numbered 0, which no step is: a practice citing 0 cites nothing.
 */
export type TraceEvent = { n: number; line: string; yours?: string }

/** The trace keeps at most 200 steps: the first 20 and the last 180. */
const TRACE_FIRST = 20
const TRACE_LAST = 180
/** A prompt shows as its first 300 characters. */
const SAID = 300

/** The tools that change a file, and the input naming it. */
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const fileOf = (u: Use) => u.input.file_path ?? u.input.notebook_path

/** A prompt as you wrote it; a `/` command as you typed it. */
function said(m: Msg) {
  const text = m.text.trim()
  const name = COMMAND.exec(text)?.[1]?.trim()
  if (!name) return text
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args ? `/${name} ${args}` : `/${name}`
}

/** An agent's setup as a trace line names it: type, model and isolation, the missing ones left out. */
const startedAs = (i: AgentInput) => [typeOf(i), i.model, i.isolation].filter(Boolean).join(' · ')

/** The task a finish notice is about: `<task-id>…</task-id>`, an agent's id or a workflow's task. */
const TASK = /<task-id>([^<]+)<\/task-id>/

/** A step other than starting an agent or editing, as one line; undefined for a tool the trace leaves out (reads, searches). */
function lineOf(u: Use) {
  const name = skillOf(u)
  if (name) return `lead loaded skill ${name}`
  if (u.tool === 'Workflow' && !u.isError) return 'lead started a workflow'
  if (u.tool === 'Bash') {
    const c = typeof u.input.command === 'string' ? command(u.input.command) : ''
    return c ? `lead ran ${c}` : 'lead ran a command'
  }
  if (u.tool === 'SendMessage') return 'lead sent a message to an agent'
  if (u.tool === 'AskUserQuestion') return 'lead asked you a question'
  return undefined
}

const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`

/**
 * The stretch as the lead's steps, one numbered line each, for the reading: your prompts, skills it
 * loaded, agents it started (those one lead message started with one setup in one line), workflows,
 * commands, messages to agents, questions to you, edits in a row as one line, and agents and
 * workflows finishing. Past 200 steps, the first 20 and the last 180 are kept, with a line counting the rest.
 */
export function leadTrace(msgs: readonly Msg[], s: Stretch): TraceEvent[] {
  const steps: Omit<TraceEvent, 'n'>[] = []
  const push = (line: string, yours?: string) => steps.push(compact({ line, yours }))
  /** This lead message's agents, by setup: the step that names them and how many. */
  let setups = new Map<string, { at: number; k: number }>()
  /** The files of the edits in a row, while the last step is theirs. */
  let edits: { at: number; files: Set<unknown> } | undefined
  /** The tasks of the workflows the lead started: their finish notices are a workflow's, not an agent's. */
  const workflows = new Set<string>()
  for (let i = s.from; i < end(msgs, s.to); i++) {
    const m = msgs[i]!
    if (m.role === 'user') {
      if (isPrompt(m)) {
        const text = said(m)
        push(`you: "${head(text.replace(/\s+/g, ' '), SAID)}"`, text)
      } else if (m.text.trimStart().startsWith(NOTICE)) {
        const task = TASK.exec(m.text)?.[1]?.trim()
        push(task && workflows.has(task) ? 'a workflow finished' : 'an agent finished')
      }
      continue
    }
    if (opens(msgs, i)) setups = new Map()
    for (const u of m.toolUses) {
      const task = workflowResult(u, 'taskId')
      if (task) workflows.add(task)
      if (EDITS.has(u.tool)) {
        if (u.isError) continue
        if (edits?.at !== steps.length - 1) {
          edits = { at: steps.length, files: new Set() }
          push('')
        }
        edits.files.add(fileOf(u) ?? u)
        steps[edits.at]!.line = `lead edited ${plural(edits.files.size, 'file')}`
      } else if (u.tool === 'Agent') {
        if (!started(u)) continue
        const setup = startedAs(u.input as AgentInput)
        const same = setups.get(setup)
        if (same) steps[same.at]!.line = `lead started ${++same.k} × ${setup} together`
        else {
          setups.set(setup, { at: steps.length, k: 1 })
          push(`lead started ${setup}`)
        }
      } else {
        const line = lineOf(u)
        if (line) push(line)
      }
    }
  }
  const all = steps.map((e, k) => ({ n: k + 1, ...e }))
  if (all.length <= TRACE_FIRST + TRACE_LAST) return all
  const left = all.length - TRACE_FIRST - TRACE_LAST
  return [...all.slice(0, TRACE_FIRST), { n: 0, line: `… ${plural(left, 'earlier step')} left out` }, ...all.slice(-TRACE_LAST)]
}

// The draft

export type ReadInput = {
  msgs: readonly Msg[]
  records: Record<string, Agent>
  /** Each top-level agent's own conversation, by its id, for its team. */
  teams: Record<string, readonly Msg[]>
  list: readonly Stretch[]
  /** How many times Earlier widened the latest stretch. */
  back: number
  root: string
  /** What the lead ran on at the stretch's last request. */
  lead: { model?: string; effort?: string }
}

/**
 * What Save saw, before the reading: the stretch Earlier widened to, its lead skills and shared brief
 * parts, its agents as roles and as the lineup (both, so `Save as` switches without reading again),
 * and nothing read yet. Undefined when the stretch holds no agent work.
 */
export function readWorkflow({ msgs, records, teams, list, back, root, lead }: ReadInput): Draft | undefined {
  const s = widen(list, back)
  // A run's agents go after the lead's own up to the message that started the run (the sort is stable).
  const calls = [...agentCalls(msgs, s), ...runCalls(msgs, s, records)].sort((a, b) => a.at - b.at)
  if (!calls.length) return undefined
  const { stages, folded } = foldRepeats(stagesOf(calls, records))
  const widened = Math.max(0, Math.min(back, list.length - 1))
  return {
    name: '',
    purpose: '',
    project: root.split(/[\\/]/).filter(Boolean).pop() ?? '',
    projectKey: hash(root),
    lead: compact({ skills: leadSkills(msgs, s), playbook: [], briefParts: sharedParts(calls.map(c => c.input.prompt ?? '')), model: lead.model, effort: lead.effort }),
    form: defaultForm(msgs, s),
    roles: groupRoles(calls, records, teams),
    stages: stages.map(st => ({ agents: st.map(c => savedAgent(c, records, teams)) })),
    types: [],
    folded,
    notCopied: [],
    evidence: [],
    read: 'pending',
    back: widened,
    more: widened < list.length - 1,
  }
}
