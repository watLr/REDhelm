import type { Agent } from '../types'

/**
 * Reading a session for Save: where its stretches begin, the skills the lead loaded, the agents it
 * started and the stages they ran in. Pure: the conversation and REDhelm's records in, a lineup out.
 */

export type Use = { tool: string; input: Record<string, unknown>; isError?: boolean; agentId?: string; result?: unknown }
/** Claude Code stores each content block as its own message, and a tool result is a user message. */
export type Msg = { role: 'user' | 'assistant'; text: string; toolUses: readonly Use[]; toolResults?: readonly unknown[] }
export type AgentInput = { description: string; prompt: string; subagent_type?: string; model?: string; effort?: string; name?: string; run_in_background?: boolean; isolation?: 'worktree' | 'remote' }
/** Message indexes, `to` exclusive; `led`: a lead skill loaded before its first agent. */
export type Stretch = { from: number; to: number; led: boolean }
/** One agent the lead started: the message it was started in, and the call. `at` is that lead message's first index. */
export type Call = { at: number; agentId: string; input: AgentInput }

/** How a user message you did not write begins: a finished agent, a command's output, a reminder, an interruption. */
const NOT_YOURS = ['<task-notification>', '<local-command', '<system-reminder>', '[Request interrupted']

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
  let at = s.from
  for (let i = s.from; i < end(msgs, s.to); i++) {
    if (msgs[i]!.role !== 'assistant') continue
    if (msgs[i - 1]?.role !== 'assistant') at = i
    for (const a of acts(msgs, i)) if (typeof a !== 'string') out.push({ at, agentId: a.agentId!, input: a.input as AgentInput })
  }
  return out
}

/** Whether a recorded agent was running at `t`. */
const running = (r: Agent | undefined, t: number) => !!r && r.startedAt <= t && t < (r.endedAt ?? Infinity)

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
    if (stage?.some(x => x.at === c.at || (t !== undefined && running(records[x.agentId], t)))) stage.push(c)
    else stages.push([c])
  }
  return stages
}

const typeOf = (c: Call) => c.input.subagent_type || 'general-purpose'

/** The same type, and the same name or the same description. */
const alike = (a: Call, b: Call) =>
  typeOf(a) === typeOf(b) &&
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
