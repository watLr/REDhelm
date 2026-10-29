import type { Draft, Practice, SavedAgent, SavedRole } from '../types'
import { answerOf, compact, head, LABEL, NAME, PRACTICE, PURPOSE, ROLE } from './workflows'

/**
 * What happens to a draft after Save read it. An edit in your words goes to the model, which answers
 * with operations, never a rewritten workflow, so a brief is never shortened or mangled behind your
 * back. Every op is checked before any applies; one bad op rejects the edit, with a reason in one
 * line. Pure: a draft and ops in, a draft out.
 */

// Edits

/** `item` is an agent in Lineup and a role in Roles. */
export type Op =
  | { op: 'rename'; name: string }
  | { op: 'purpose'; text: string }
  | { op: 'form'; value: 'roles' | 'lineup' }
  | { op: 'lead'; add?: string[]; remove?: string[] }          // lead skills
  | { op: 'practice'; add: Practice; at?: number }
  | { op: 'practice'; remove: number }
  | { op: 'practice'; index: number; set: Practice }
  | { op: 'part'; remove: number }                              // a shared brief part
  | { op: 'remove'; item: number }
  | { op: 'move'; item: number; stage: number | 'new' }        // Lineup
  | { op: 'set'; item: number; field: 'label' | 'role' | 'type' | 'model' | 'effort' | 'background' | 'teammate' | 'isolation'; value: string | boolean | null }
  | { op: 'brief'; item: number; find: string; replace: string } // Lineup
  | { op: 'brief'; item: number; append: string }               // Lineup
  | { op: 'skills' | 'tools'; item: number; add?: string[]; remove?: string[] }
  | { op: 'add'; stage?: number | 'new'; item: { label: string; type: string; description?: string; brief?: string; role?: string; model?: string; effort?: string } }
    // Lineup needs `stage`, `description` and `brief`; Roles needs `role`
export type EditAnswer = { ops: Op[] } | { cannot: string }

/** One model call per edit: it answers with ops. */
export const EDIT_CALL = { model: 'sonnet', effort: 'low', maxTokens: 1200, timeoutMs: 30_000 } as const

/** The Agent tool's values. */
const EFFORTS: readonly unknown[] = ['lower', 'higher', 'low', 'medium', 'high', 'xhigh', 'max']
const ISOLATIONS: readonly unknown[] = ['worktree', 'remote']
const FIELDS: readonly unknown[] = ['label', 'role', 'type', 'model', 'effort', 'background', 'teammate', 'isolation']

export const EDIT_SYSTEM = [
  'Change a saved workflow by operations only; never rewrite it. Reply with JSON only: {"ops": [operations, in order]}, or {"cannot": "<one line saying why>"} when no operation below makes the change asked for.',
  'The operations:',
  '{"op": "rename", "name": "≤ 40 characters"}',
  '{"op": "purpose", "text": "one line, ≤ 90 characters"}',
  '{"op": "form", "value": "roles" | "lineup"}',
  '{"op": "lead", "add": ["skill"], "remove": ["skill"]}   the lead skills; add and remove are each optional',
  '{"op": "practice", "add": {"when": "≤ 120 characters", "do": "≤ 120 characters"}, "at": practice}   "at" is optional: the new practice goes before that one, or last without it',
  '{"op": "practice", "remove": practice}',
  '{"op": "practice", "index": practice, "set": {"when": "≤ 120 characters", "do": "≤ 120 characters"}}',
  '{"op": "part", "remove": part}   a shared brief part',
  '{"op": "remove", "item": item}',
  '{"op": "move", "item": item, "stage": stage | "new"}   lineup only',
  '{"op": "set", "item": item, "field": "label" | "role" | "type" | "model" | "effort" | "background" | "teammate" | "isolation", "value": text | true | false | null}   "role" is roles only',
  '{"op": "brief", "item": item, "find": "text the brief holds, exactly", "replace": "text"}   lineup only; every occurrence is replaced',
  '{"op": "brief", "item": item, "append": "text"}   lineup only; it goes last, as a new paragraph',
  '{"op": "skills" | "tools", "item": item, "add": ["name"], "remove": ["name"]}',
  '{"op": "add", "stage": stage | "new", "item": {"label": "≤ 16 characters", "type": "agent type", "description": "one line", "brief": "the whole brief", "model": "optional", "effort": "optional"}}   lineup',
  '{"op": "add", "item": {"label": "≤ 16 characters", "type": "agent type", "role": "one line, ≤ 90 characters", "model": "optional", "effort": "optional"}}   roles',
  'item, stage, practice and part are the numbers in brackets in the workflow, [0] the first. The person counts from 1, as the list does: their 2 is [1]. The numbers always mean the workflow as listed, even after an earlier operation removed or moved something. What you add has no number, so give it everything in the operation that adds it; a stage made by "new" takes the next number after the last one.',
  "Items are the lineup's agents or the roles, whichever the form is when the operation runs. A stage's agents start together; a stage left empty is dropped.",
  'effort is lower, higher, low, medium, high, xhigh or max; isolation is worktree, remote or null; null clears model, effort or isolation; background and teammate are true or false.',
  'Change only what was asked.',
].join('\n')

/** How much of a brief or a shared part the edit call is given, and of a value a reason quotes. */
const BRIEF = 6000
const SHOWN = 60

const even = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * A brief or part for the edit call, whole, so a `find` can quote it: as JSON, to be quoted exactly.
 * Past 6,000 characters it is cut there, and says so.
 */
const quote = (text: string) => (text.length > BRIEF ? ` ${JSON.stringify(head(text, BRIEF))} … cut` : ` ${JSON.stringify(text)}`)

/** What agents and roles share, as their line names it: label, type, settings, skills and the tools they used. */
const setupOf = (x: SavedAgent | SavedRole) => {
  const tools = Object.keys(x.tools)
  return [x.label, x.type, x.model && `model ${x.model}`, x.effort && `effort ${x.effort}`, x.isolation && `isolation ${x.isolation}`,
    x.background && 'background', x.teammate && 'teammate', x.skills.length > 0 && `skills ${x.skills.join(', ')}`, tools.length > 0 && `tools ${tools.join(', ')}`]
}

const line = (parts: unknown[]) => parts.filter(Boolean).join(' · ')

/** A list under its title, `none` when empty. */
const listed = (title: string, rows: readonly string[]) => (rows.length ? `${title}:\n${rows.join('\n')}` : `${title}: none`)

/**
 * What the edit call is given: the name, purpose and form; the lead skills, practices and shared parts;
 * the Lineup's stages and agents, each brief whole (up to 6,000 characters); the roles; and what you asked, whole.
 * Both forms are listed, since a `form` op switches. Each thing is numbered from 1, as the sheet and
 * the reasons number it, with the number an op names it by in brackets.
 */
export function editRequest(d: Draft, ask: string): { system: string; prompt: string } {
  const text = (title: string, t: string) => `${title}: ${t ? JSON.stringify(t) : 'none'}`
  const numbered = (k: number, row: string) => `${k + 1}. [${k}] ${row}`
  let item = 0
  const stages = d.stages.map((s, k) =>
    `Stage ${k + 1} [${k}]:\n${s.agents.map(a => numbered(item++, line([...setupOf(a), `description ${JSON.stringify(a.description)}`, `brief${quote(a.brief)}`]))).join('\n')}`)
  const rows = [
    text('Name', d.name),
    text('Purpose', d.purpose),
    `Form: ${d.form}`,
    `Lead skills: ${d.lead.skills.join(', ') || 'none'}`,
    listed('Practices', d.lead.playbook.map((p, k) => numbered(k, `when ${JSON.stringify(p.when)}, do ${JSON.stringify(p.do)}`))),
    listed('Shared brief parts', d.lead.briefParts.map((p, k) => `${k + 1}. [${k}]${quote(p)}`)),
    listed("Lineup, the items while the form is lineup. A stage's agents start together", stages),
    listed('Roles, the items while the form is roles', d.roles.map((r, k) =>
      numbered(k, line([...setupOf(r), `ran ${r.ran} time${r.ran === 1 ? '' : 's'}`, `role ${JSON.stringify(r.role)}`])))),
  ]
  return { system: EDIT_SYSTEM, prompt: `${rows.join('\n')}\n\nThe change asked for: ${ask.trim()}` }
}

type Fields = Record<string, unknown>

/** The object's fields; undefined for anything else, a list included. */
const fieldsOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Fields) : undefined)

/** The model's answer: its ops, or its reason when it found none to make. Undefined when it is neither, or an op is not an object. */
export function parseEdit(text: string | undefined): EditAnswer | undefined {
  const o = answerOf(text)
  if (!o) return undefined
  const ops = Array.isArray(o.ops) && o.ops.every(op => fieldsOf(op)) ? (o.ops as Op[]) : undefined
  const cannot = typeof o.cannot === 'string' ? o.cannot.trim() : ''
  if (ops?.length) return { ops }
  if (cannot) return { cannot }
  return ops ? { ops } : undefined
}

// Checking and applying

/** For an op that is none of the ops, or is missing a field or has one of the wrong kind. */
const NOT_AN_EDIT = "That isn't an edit REDhelm can make"
const ONLY_LINEUP = 'That only applies to Lineup'
const ONLY_ROLES = 'That only applies to Roles'
const LONG = {
  name: `A name is at most ${NAME} characters`,
  purpose: `A purpose is at most ${PURPOSE} characters`,
  label: `A label is at most ${LABEL} characters`,
  role: `A role is at most ${ROLE} characters`,
  practice: `A practice is at most ${PRACTICE} characters`,
}

/** A value as a reason quotes it: text on one line, anything else as JSON; at most 60 characters. */
function shown(v: unknown) {
  const t = typeof v === 'string' && even(v) ? even(v) : (JSON.stringify(v) ?? String(v))
  return t.length > SHOWN ? `${head(t, SHOWN).trimEnd()}…` : t
}

const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

/** Why `v` is not one line of text of at most `n` characters, or undefined when it is. Empty text is none unless `empty`. */
function lineFault(v: unknown, n: number, long: string, empty = false) {
  if (typeof v !== 'string' || (!empty && !even(v))) return NOT_AN_EDIT
  return even(v).length > n ? long : undefined
}

/** A list of names, each trimmed: none when absent, undefined when it is not a list of names. */
function namesOf(v: unknown): string[] | undefined {
  if (v === undefined) return []
  return Array.isArray(v) && v.every(n => typeof n === 'string' && n.trim()) ? v.map(n => (n as string).trim()) : undefined
}

/** The names with `remove` taken out, then `add` put in last, once each. */
function edited(names: readonly string[], add: readonly string[], remove: readonly string[]) {
  const out = names.filter(n => !remove.includes(n))
  for (const n of add) if (!out.includes(n)) out.push(n)
  return out
}

/** Tool counts with `remove` taken out and `add` put in at 0: a tool added was never used. A tool named like an Object method is still a tool. */
function editedTools(tools: Readonly<Record<string, number>>, add: readonly string[], remove: readonly string[]) {
  const out = Object.entries(tools).filter(([t]) => !remove.includes(t))
  for (const t of add) if (!out.some(([k]) => k === t)) out.push([t, 0])
  return Object.fromEntries(out)
}

/** A practice with the trace lines it cites. A practice you rewrite cites none. */
type Entry = { practice: Practice; evidence: string[] }

/**
 * The draft while ops apply. What was listed keeps its number whatever ops ran before: `agents`,
 * `listedRoles` and `listedPractices` stay as listed, and the rest hold what is still there. Stages are
 * only added to, so their numbers hold too; the empty ones go at the end. Every object here is a copy,
 * so ops change them in place and the draft given is never touched.
 */
type Work = {
  name: string
  purpose: string
  form: Draft['form']
  skills: string[]
  agents: SavedAgent[]
  stages: SavedAgent[][]
  listedRoles: SavedRole[]
  roles: SavedRole[]
  listedPractices: Entry[]
  practices: Entry[]
  /** The shared parts; a removed one is undefined. */
  parts: (string | undefined)[]
  /** The agents removed, for the repeats folded into them. */
  removed: SavedAgent[]
}

function workOf(d: Draft): Work {
  const stages = d.stages.map(s => s.agents.map(a => ({ ...a })))
  const listedRoles = d.roles.map(r => ({ ...r }))
  const listedPractices = d.lead.playbook.map((practice, k) => ({ practice, evidence: d.evidence[k] ?? [] }))
  return {
    name: d.name, purpose: d.purpose, form: d.form, skills: d.lead.skills,
    agents: stages.flat(), stages, listedRoles, roles: [...listedRoles], listedPractices, practices: [...listedPractices],
    parts: [...d.lead.briefParts], removed: [],
  }
}

const stageOf = (w: Work, a: SavedAgent) => w.stages.find(s => s.includes(a))

/** Agent `k` as listed, while it is still in the Lineup; or why there is none. */
function agentOf(w: Work, k: unknown): SavedAgent | string {
  if (!isIndex(k)) return NOT_AN_EDIT
  const a = w.agents[k]
  return a && stageOf(w, a) ? a : `No item ${k + 1}`
}

/** Role `k` as listed, while it is still there; or why there is none. */
function roleOf(w: Work, k: unknown): SavedRole | string {
  if (!isIndex(k)) return NOT_AN_EDIT
  const r = w.listedRoles[k]
  return r && w.roles.includes(r) ? r : `No item ${k + 1}`
}

const itemOf = (w: Work, k: unknown) => (w.form === 'lineup' ? agentOf(w, k) : roleOf(w, k))

/** Why `s` names no stage, or undefined when it does: one listed or added, or `new`. */
function stageFault(w: Work, s: unknown) {
  if (s === 'new') return undefined
  if (!isIndex(s)) return NOT_AN_EDIT
  return s < w.stages.length ? undefined : `No stage ${s + 1}`
}

/** The stage `s` names, once `stageFault` passed it; `new` adds one last. */
function stageFor(w: Work, s: unknown): SavedAgent[] {
  if (isIndex(s)) return w.stages[s]!
  const stage: SavedAgent[] = []
  w.stages.push(stage)
  return stage
}

function takeOut(w: Work, a: SavedAgent) {
  const stage = stageOf(w, a)!
  stage.splice(stage.indexOf(a), 1)
}

/** Why `v` cannot be the field's value, or undefined when it can. `null` clears model, effort and isolation. */
function valueFault(field: unknown, v: unknown) {
  switch (field) {
    case 'label': return lineFault(v, LABEL, LONG.label)
    case 'role': return lineFault(v, ROLE, LONG.role, true)
    case 'type': return lineFault(v, Infinity, NOT_AN_EDIT)
    case 'model': return v === null ? undefined : lineFault(v, Infinity, NOT_AN_EDIT)
    case 'effort': return v === null || EFFORTS.includes(v) ? undefined : `${shown(v)} isn't an effort`
    case 'isolation': return v === null || ISOLATIONS.includes(v) ? undefined : `${shown(v)} isn't an isolation`
    default: return typeof v === 'boolean' ? undefined : NOT_AN_EDIT // background, teammate
  }
}

function practiceFault(v: unknown) {
  const p = fieldsOf(v)
  return p ? (lineFault(p.when, PRACTICE, LONG.practice) ?? lineFault(p.do, PRACTICE, LONG.practice)) : NOT_AN_EDIT
}

/** A practice as you wrote it, on one line; a number in it is yours, so it stays. */
const practiceOf = (v: unknown): Practice => {
  const p = v as Practice
  return { when: even(p.when), do: even(p.do) }
}

/** Practice `k` as listed, while it is still there; or why there is none. */
function entryOf(w: Work, k: unknown): Entry | string {
  if (!isIndex(k)) return NOT_AN_EDIT
  const e = w.listedPractices[k]
  return e && w.practices.includes(e) ? e : `No practice ${k + 1}`
}

/** `add` (before listed practice `at`, or the next one still there; last without it), `remove`, or `index` with `set`. */
function practice(w: Work, o: Fields) {
  const given = ['add', 'remove', 'index', 'set'].filter(k => o[k] !== undefined).join()
  if (given === 'add') {
    const fault = practiceFault(o.add)
    if (fault) return fault
    const at = o.at ?? w.listedPractices.length
    if (!isIndex(at)) return NOT_AN_EDIT
    if (at > w.listedPractices.length) return `No practice ${at + 1}`
    const next = w.listedPractices.slice(at).find(e => w.practices.includes(e))
    w.practices.splice(next ? w.practices.indexOf(next) : w.practices.length, 0, { practice: practiceOf(o.add), evidence: [] })
    return undefined
  }
  if (given === 'remove' || given === 'index,set') {
    const e = entryOf(w, given === 'remove' ? o.remove : o.index)
    if (typeof e === 'string') return e
    if (given === 'remove') w.practices.splice(w.practices.indexOf(e), 1)
    else {
      const fault = practiceFault(o.set)
      if (fault) return fault
      e.practice = practiceOf(o.set)
      e.evidence = []
    }
    return undefined
  }
  return NOT_AN_EDIT
}

function remove(w: Work, o: Fields) {
  if (w.form === 'roles') {
    const r = roleOf(w, o.item)
    if (typeof r === 'string') return r
    w.roles.splice(w.roles.indexOf(r), 1)
    return undefined
  }
  const a = agentOf(w, o.item)
  if (typeof a === 'string') return a
  takeOut(w, a)
  w.removed.push(a)
  return undefined
}

/** An agent to the end of another stage, or of a new one. */
function move(w: Work, o: Fields) {
  if (w.form !== 'lineup') return ONLY_LINEUP
  const a = agentOf(w, o.item)
  if (typeof a === 'string') return a
  const fault = stageFault(w, o.stage)
  if (fault) return fault
  takeOut(w, a)
  stageFor(w, o.stage).push(a)
  return undefined
}

function set(w: Work, o: Fields) {
  if (!FIELDS.includes(o.field)) return NOT_AN_EDIT
  if (o.field === 'role' && w.form === 'lineup') return ONLY_ROLES
  const it = itemOf(w, o.item)
  if (typeof it === 'string') return it
  if (o.value === undefined) return NOT_AN_EDIT
  const v = typeof o.value === 'string' ? even(o.value) : o.value
  const fault = valueFault(o.field, v)
  if (fault) return fault
  const fields = it as unknown as Fields
  if (v === null) delete fields[o.field as string]
  else fields[o.field as string] = v
  return undefined
}

/** Every occurrence of `find` replaced, as text and never as a pattern; or `append` as a new last paragraph. */
function brief(w: Work, o: Fields) {
  if (w.form !== 'lineup') return ONLY_LINEUP
  const a = agentOf(w, o.item)
  if (typeof a === 'string') return a
  const { find, replace, append } = o
  if (append === undefined && typeof find === 'string' && find && typeof replace === 'string') {
    if (!a.brief.includes(find)) return `"${shown(find)}" isn't in that brief`
    a.brief = a.brief.split(find).join(replace)
    return undefined
  }
  if (find === undefined && replace === undefined && typeof append === 'string' && append.trim()) {
    a.brief = a.brief.trim() ? `${a.brief.trimEnd()}\n\n${append.trim()}` : append.trim()
    return undefined
  }
  return NOT_AN_EDIT
}

function skillsOrTools(w: Work, o: Fields) {
  const it = itemOf(w, o.item)
  if (typeof it === 'string') return it
  const add = namesOf(o.add)
  const remove = namesOf(o.remove)
  if (!add || !remove) return NOT_AN_EDIT
  if (o.op === 'skills') it.skills = edited(it.skills, add, remove)
  else it.tools = editedTools(it.tools, add, remove)
  return undefined
}

/** A new agent at the end of a stage, or a new role last. It has run nothing yet: no tools, no skills, `ran` 0. */
function add(w: Work, o: Fields) {
  const it = fieldsOf(o.item)
  if (!it) return NOT_AN_EDIT
  const lineup = w.form === 'lineup'
  if (lineup && it.role !== undefined) return ONLY_ROLES
  if (!lineup && (o.stage !== undefined || it.description !== undefined || it.brief !== undefined)) return ONLY_LINEUP
  const model = it.model ?? undefined
  const effort = typeof it.effort === 'string' ? even(it.effort) : (it.effort ?? undefined)
  const fault =
    lineFault(it.label, LABEL, LONG.label) ??
    lineFault(it.type, Infinity, NOT_AN_EDIT) ??
    (model === undefined ? undefined : lineFault(model, Infinity, NOT_AN_EDIT)) ??
    (effort === undefined ? undefined : valueFault('effort', effort)) ??
    (lineup
      ? (lineFault(it.description, Infinity, NOT_AN_EDIT) ?? lineFault(it.brief, Infinity, NOT_AN_EDIT) ?? stageFault(w, o.stage))
      : lineFault(it.role, ROLE, LONG.role))
  if (fault) return fault
  const text = (v: unknown) => even(v as string)
  const setup = { type: text(it.type), model: model === undefined ? undefined : text(model), effort: effort as string | undefined, background: false, teammate: false }
  if (lineup) {
    stageFor(w, o.stage).push(compact({ label: text(it.label), description: text(it.description), brief: (it.brief as string).trim(), ...setup, tools: {}, skills: [] }))
  } else {
    w.roles.push(compact({ label: text(it.label), role: text(it.role), ...setup, tools: {}, skills: [], ran: 0 }))
  }
  return undefined
}

/** Checks one op against what the ops before it left, and applies it to `w`; the reason when it cannot. */
function step(w: Work, x: unknown): string | undefined {
  const o = fieldsOf(x)
  if (!o) return NOT_AN_EDIT
  switch (o.op) {
    case 'rename': {
      const fault = lineFault(o.name, NAME, LONG.name)
      if (!fault) w.name = even(o.name as string)
      return fault
    }
    case 'purpose': {
      const fault = lineFault(o.text, PURPOSE, LONG.purpose, true)
      if (!fault) w.purpose = even(o.text as string)
      return fault
    }
    case 'form':
      if (o.value !== 'roles' && o.value !== 'lineup') return NOT_AN_EDIT
      w.form = o.value
      return undefined
    case 'lead': {
      const add = namesOf(o.add)
      const remove = namesOf(o.remove)
      if (!add || !remove) return NOT_AN_EDIT
      w.skills = edited(w.skills, add, remove)
      return undefined
    }
    case 'practice': return practice(w, o)
    case 'part':
      if (!isIndex(o.remove)) return NOT_AN_EDIT
      if (w.parts[o.remove] === undefined) return `No shared part ${o.remove + 1}`
      w.parts[o.remove] = undefined
      return undefined
    case 'remove': return remove(w, o)
    case 'move': return move(w, o)
    case 'set': return set(w, o)
    case 'brief': return brief(w, o)
    case 'skills':
    case 'tools': return skillsOrTools(w, o)
    case 'add': return add(w, o)
    default: return NOT_AN_EDIT
  }
}

/** The ops, in order, on `w`; the first reason stops them. */
function run(w: Work, ops: readonly unknown[]) {
  if (!Array.isArray(ops)) return NOT_AN_EDIT
  for (const op of ops) {
    const why = step(w, op)
    if (why) return why
  }
  return undefined
}

/** Why the edit cannot be made: the first op's reason that fails, for the sheet's one line. Undefined when every op can. */
export function checkOps(d: Draft, ops: readonly Op[]): string | undefined {
  return run(workOf(d), ops)
}

/**
 * The draft with the ops applied, once `checkOps` passed them; a new draft, never `d` changed. Stages
 * left empty are dropped, and with a removed agent the repeats folded into it. Ops `checkOps` refuses
 * leave the draft as it was.
 */
export function applyOps(d: Draft, ops: readonly Op[]): Draft {
  const w = workOf(d)
  if (run(w, ops)) return d
  const stages = w.stages.filter(s => s.length).map(agents => ({ agents }))
  const left = stages.flatMap(s => s.agents)
  const gone = (label: string) => w.removed.some(a => a.description === label) && !left.some(a => a.description === label)
  return {
    ...d,
    name: w.name,
    purpose: w.purpose,
    form: w.form,
    lead: { ...d.lead, skills: w.skills, playbook: w.practices.map(e => e.practice), briefParts: w.parts.filter((p): p is string => p !== undefined) },
    stages,
    roles: w.roles,
    folded: d.folded.filter(f => !gone(f.label)),
    evidence: w.practices.map(e => e.evidence),
  }
}
