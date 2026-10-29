import type { Draft, Lead, Practice, SavedAgent, SavedRole, SavedType, SavedWorkflow } from '../types'
import { hash } from './labels'
import { answerOf, compact, head, LABEL, NAME, PRACTICE, PURPOSE, ROLE } from './workflows'

/**
 * What happens to a draft after Save read it. An edit in your words goes to the model, which answers
 * with operations, never a rewritten workflow, so a brief is never shortened or mangled behind your
 * back. Every op is checked before any applies; one bad op rejects the edit, with a reason in one
 * line. Then the saved file and the library, the plan Claude gets when you press Run, and a
 * project's agent file read so it can travel. Pure: no engine calls, no file reads.
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
const titled = (title: string, rows: readonly string[]) => (rows.length ? `${title}:\n${rows.join('\n')}` : `${title}: none`)

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
    titled('Practices', d.lead.playbook.map((p, k) => numbered(k, `when ${JSON.stringify(p.when)}, do ${JSON.stringify(p.do)}`))),
    titled('Shared brief parts', d.lead.briefParts.map((p, k) => `${k + 1}. [${k}]${quote(p)}`)),
    titled("Lineup, the items while the form is lineup. A stage's agents start together", stages),
    titled('Roles, the items while the form is roles', d.roles.map((r, k) =>
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

// The saved file

/** How long an id may be before Save makes it unique among the files. */
const SLUG = 48

/**
 * A name's file id: its ASCII words (accents and apostrophes dropped), lowercased and joined with '-',
 * cut at a word to 48 characters. A name with no ASCII word gets `workflow-<hash of the name>`.
 */
export function slug(name: string): string {
  const words = name.normalize('NFKD').replace(/[\u0300-\u036f'’]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  let out = words[0]?.slice(0, SLUG) ?? ''
  for (const w of words.slice(1)) {
    if (out.length + 1 + w.length > SLUG) break
    out += `-${w}`
  }
  return out || `workflow-${hash(name)}`
}

/** The name when no saved workflow has it; else the first of "<name> 2", "<name> 3"… none has. */
export function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name
  let k = 2
  while (taken.includes(`${name} ${k}`)) k++
  return `${name} ${k}`
}

/** A project's key: its root is only ever kept hashed. */
export const projectKey = (root: string) => hash(root)

// Copies hold only the saved fields, each array and object new; a null a hand-edited file wrote reads as absent.
const copyLead = (l: Lead): Lead => compact({ skills: [...l.skills], playbook: l.playbook.map(p => ({ when: p.when, do: p.do })), briefParts: [...l.briefParts],
  model: l.model ?? undefined, effort: l.effort ?? undefined })
const copyRole = (r: SavedRole): SavedRole => compact({ label: r.label, role: r.role, type: r.type, model: r.model ?? undefined, effort: r.effort ?? undefined,
  isolation: r.isolation ?? undefined, background: r.background, teammate: r.teammate, tools: { ...r.tools }, skills: [...r.skills], ran: r.ran, team: r.team?.map(copyRole) })
const copyAgent = (a: SavedAgent): SavedAgent => compact({ label: a.label, description: a.description, brief: a.brief, type: a.type, model: a.model ?? undefined,
  effort: a.effort ?? undefined, name: a.name ?? undefined, background: a.background, teammate: a.teammate, isolation: a.isolation ?? undefined,
  tools: { ...a.tools }, skills: [...a.skills], team: a.team?.map(copyRole) })
const copyType = (t: SavedType): SavedType => ({ name: t.name, definition: t.definition })

/** The types an agent or role runs as, its own team's included. */
const typesOf = (x: SavedAgent | SavedRole) => [x.type, ...(x.team ?? []).map(r => r.type)]

/**
 * The draft as its file holds it: the chosen form only (the other left empty, a stage left empty
 * dropped), the copied types that form still runs as, once each, and nothing that is the sheet's
 * (repeats folded, types not copied, evidence, the reading's state, Earlier). Every object in it is
 * new, so the draft and the file share nothing.
 */
export function toSaved(d: Draft, at: number, id: string): SavedWorkflow {
  const roles = d.form === 'roles' ? d.roles.map(copyRole) : []
  const stages = d.form === 'lineup' ? d.stages.filter(s => s.agents.length).map(s => ({ agents: s.agents.map(copyAgent) })) : []
  const used = new Set([...roles, ...stages.flatMap(s => s.agents)].flatMap(typesOf))
  const types = d.types.filter((t, k) => used.has(t.name) && d.types.findIndex(u => u.name === t.name) === k).map(copyType)
  return { version: 1, id, name: d.name, purpose: d.purpose, savedAt: at, project: d.project, projectKey: d.projectKey, lead: copyLead(d.lead), form: d.form, roles, stages, types }
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)
/** A count: a whole number, 0 or more. */
const isCount = isIndex
/** Absent, null, or of the shape `ok` checks. */
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v)
const isCounts = (v: unknown) => !!fieldsOf(v) && Object.values(fieldsOf(v)!).every(isCount)
const isIsolation = (v: unknown) => v === 'worktree' || v === 'remote'
/** An id names a file in the library folder, never a path out of it. */
const isId = (v: unknown): v is string => isName(v) && !/[/\\]/.test(v) && v !== '.' && v !== '..'

/** What agents and roles share: the type and settings they ran with, the tools they used, the skills they loaded. */
const isSetup = (o: Fields) => isName(o.type) && optional(o.model, isText) && optional(o.effort, isText) && optional(o.isolation, isIsolation)
  && typeof o.background === 'boolean' && typeof o.teammate === 'boolean' && isCounts(o.tools) && isTexts(o.skills)

/** A role, with its own team one level down at most, as Save reads teams. */
function isRole(v: unknown, top: boolean): boolean {
  const o = fieldsOf(v)
  return !!o && isText(o.label) && isText(o.role) && isSetup(o) && isCount(o.ran) && (top ? optional(o.team, isTeam) : optional(o.team, () => false))
}
const isTeam = (v: unknown) => Array.isArray(v) && v.every(r => isRole(r, false))

function isAgent(v: unknown) {
  const o = fieldsOf(v)
  return !!o && isText(o.label) && isText(o.description) && isText(o.brief) && isSetup(o) && optional(o.name, isText) && optional(o.team, isTeam)
}

function isLead(v: unknown): v is Lead {
  const o = fieldsOf(v)
  const isPractice = (p: unknown) => !!fieldsOf(p) && isText(fieldsOf(p)!.when) && isText(fieldsOf(p)!.do)
  return !!o && isTexts(o.skills) && Array.isArray(o.playbook) && o.playbook.every(isPractice) && isTexts(o.briefParts) && optional(o.model, isText) && optional(o.effort, isText)
}

const isStage = (v: unknown) => !!fieldsOf(v) && Array.isArray(fieldsOf(v)!.agents) && (fieldsOf(v)!.agents as unknown[]).every(isAgent)
const isType = (v: unknown) => !!fieldsOf(v) && isName(fieldsOf(v)!.name) && isText(fieldsOf(v)!.definition)

/**
 * A saved file, read: version 1 with every field of its shape, as a new object holding those fields
 * only. Undefined for anything else: text that is not JSON, a newer version, a field missing or of the
 * wrong kind, an id that is a path, a team more than one level down.
 */
export function parseSaved(text: string): SavedWorkflow | undefined {
  let v: unknown
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
  const o = fieldsOf(v)
  if (!o || o.version !== 1 || !isId(o.id) || !isName(o.name) || !isText(o.purpose) || typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)
    || !isText(o.project) || !isText(o.projectKey) || !isLead(o.lead) || (o.form !== 'roles' && o.form !== 'lineup')
    || !Array.isArray(o.roles) || !o.roles.every(r => isRole(r, true)) || !Array.isArray(o.stages) || !o.stages.every(isStage)
    || !Array.isArray(o.types) || !o.types.every(isType)) return undefined
  return {
    version: 1, id: o.id, name: o.name, purpose: o.purpose, savedAt: o.savedAt, project: o.project, projectKey: o.projectKey, lead: copyLead(o.lead), form: o.form,
    roles: (o.roles as SavedRole[]).map(copyRole), stages: (o.stages as { agents: SavedAgent[] }[]).map(s => ({ agents: s.agents.map(copyAgent) })),
    types: (o.types as SavedType[]).map(copyType),
  }
}

/**
 * The library as Load lists it: this project's workflows first, then newest first, then by id. A
 * workflow's id is its file's name, so Run and Delete reach the file it came from. A blank file (a
 * deleted one) and a name that is not `.json` are passed over; a file that does not read is counted.
 */
export function listed(files: readonly { name: string; text: string }[], key: string): { workflows: SavedWorkflow[]; unreadable: number } {
  const workflows: SavedWorkflow[] = []
  let unreadable = 0
  for (const f of files) {
    const id = /^(.+)\.json$/.exec(f.name)?.[1]
    if (!id || !f.text.trim()) continue
    const w = parseSaved(f.text)
    if (w) workflows.push({ ...w, id })
    else unreadable++
  }
  const theirs = (w: SavedWorkflow) => (w.projectKey === key ? 0 : 1)
  workflows.sort((a, b) => theirs(a) - theirs(b) || b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { workflows, unreadable }
}

// Run

/** What your prompt becomes when you run a workflow: the ask, and your notes for this run when you wrote any. */
export function runText(name: string, notes: string): string {
  const n = notes.trim()
  return `Run my saved REDhelm workflow "${name}".${n ? ` My notes for this run: ${n}` : ''}`
}

const OPENING = 'It is how this kind of work was led and staffed before: start from it, and fit it to this problem and to my notes. It fixes no loops, rounds or checks; choose those for this problem. If an agent type or skill is not available here, go without it and say so.'

/** What a copied agent file keeps but Run never registers, in this order: the first two run commands, the third widens permissions. */
const LEFT_BEHIND = ['hooks', 'mcpServers', 'permissionMode'] as const
const LEFT_WORDS: Record<(typeof LEFT_BEHIND)[number], string> = { hooks: 'hooks', mcpServers: 'MCP servers', permissionMode: 'permission mode' }

/** "a", "a and b", "a, b and c"; or with "or". */
const and = (xs: readonly string[], word = 'and') => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}` : (xs[0] ?? ''))
const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`)
const times = (n: number) => (n === 1 ? 'once' : `${n} times`)
/** A map's own entry: a type named like an Object method is still a type. */
const own = <T>(o: Readonly<Record<string, T>>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined)

type Here = { registered: Record<string, string>; leftBehind: Record<string, string[]> }

/** The type an agent or role runs as here, and what the plan says of it: that its copy could not be added, or what of its file stayed behind. */
function typeHere(type: string, h: Here): { as: string; note?: string } {
  const as = own(h.registered, type) ?? type
  if (as === 'general-purpose' && type !== 'general-purpose') return { as, note: `${type} could not be added here` }
  const left = own(h.leftBehind, type) ?? []
  const words = LEFT_BEHIND.filter(f => left.includes(f)).map(f => LEFT_WORDS[f])
  return { as, note: words.length ? `its ${and(words)} stayed behind` : undefined }
}

/** The type and the settings it ran with, as the Agent tool takes them. */
function settings(x: SavedAgent | SavedRole, h: Here) {
  const t = typeHere(x.type, h)
  const name = 'name' in x ? x.name : undefined
  return [`subagent_type ${t.as}${t.note ? ` (${t.note})` : ''}`, name && `name ${name}`, x.model && `model ${x.model}`, x.effort && `effort ${x.effort}`,
    x.isolation && `isolation ${x.isolation}`, x.background && 'background', x.teammate && 'teammate'].filter(Boolean).join(', ')
}

/** The tools it used, most used first. A tool an edit added never ran, so it is left out. */
const toolsUsed = (tools: Readonly<Record<string, number>>) => Object.entries(tools).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])

/** The roles its own agents filled, as one line; undefined when it started none. */
function teamLine(team: readonly SavedRole[] | undefined, h: Here) {
  if (!team?.length) return undefined
  const one = (r: SavedRole) => {
    const t = typeHere(r.type, h)
    const parts = [t.as, r.model, r.effort && `effort ${r.effort}`, r.isolation && `isolation ${r.isolation}`, r.ran > 0 && `ran ${times(r.ran)}`].filter(Boolean)
    return `${r.label} (${parts.join(', ')}${t.note ? `; ${t.note}` : ''})`
  }
  return `It started its own team: ${team.map(one).join(', ')}. Ask it to staff its work that way.`
}

/** A role that never ran (an edit added it) leaves out how many times it ran. */
function roleItem(r: SavedRole, h: Here) {
  const line = [r.role.trim() && sentence(r.role.trim()), `${settings(r, h)}.`, `Tools it used: ${toolsUsed(r.tools).map(([t]) => t).join(', ') || 'none'}.`,
    `Skills: ${r.skills.join(', ') || 'none'}.`, r.ran > 0 && `Ran ${times(r.ran)}.`].filter(Boolean).join(' ')
  const team = teamLine(r.team, h)
  return `- ${r.label}: ${line}${team ? `\n  ${team}` : ''}`
}

/** An agent of the lineup, its brief whole under it, each line indented as the item is. */
function agentItem(a: SavedAgent, h: Here) {
  const tools = toolsUsed(a.tools).map(([t, n]) => `${t} ${n}`)
  const lines = [`- ${a.label}: ${settings(a, h)}`, `  Tools it used: ${tools.join(', ') || 'none'}. Skills it used: ${a.skills.join(', ') || 'none'}.`]
  const team = teamLine(a.team, h)
  if (team) lines.push(`  ${team}`)
  const brief = a.brief.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
  if (brief) lines.push('  Brief:', ...brief.split('\n').map(l => (l.trim() ? `  ${l}` : '')))
  return lines.join('\n')
}

/** "When the work splits cleanly, start implementers together." */
const practiceLine = (p: Practice) => sentence([p.when.trim().replace(/[\s,;:.]+$/, ''), p.do.trim()].filter(Boolean).join(', '))

/**
 * The plan Claude gets in the prompt's context when you run a workflow (spec §8): the opening, then
 * the lead skills, the playbook, the shared brief parts (Roles), and the roles or the stages, each only
 * when it has something in it. A type is named as it runs here: `registered` maps a saved type to
 * `redhelm:<name>`, or to `general-purpose` when its copy could not be added, which the plan says;
 * `leftBehind` names what of a copied type's file stayed behind.
 */
export function planText(w: SavedWorkflow, registered: Record<string, string>, leftBehind: Record<string, string[]>): string {
  const h = { registered, leftBehind }
  const purpose = w.purpose.trim()
  const blocks = [`Saved REDhelm workflow "${w.name}"${purpose ? `: ${sentence(purpose)}` : '.'}\n${OPENING}`]
  const skills = w.lead.skills
  if (skills.length) blocks.push(`Lead: use the ${and(skills)} skill${skills.length > 1 ? 's' : ''} to run this.`)
  const playbook = w.lead.playbook.filter(p => p.when.trim() || p.do.trim())
  if (playbook.length) blocks.push(['How the lead worked last time. Use the practices that fit this problem:', ...playbook.map((p, k) => `${k + 1}. ${practiceLine(p)}`)].join('\n'))
  if (w.form === 'roles') {
    const parts = w.lead.briefParts.filter(p => p.trim())
    if (parts.length) blocks.push(`Every agent's brief should include:\n${parts.join('\n\n')}`)
    if (w.roles.length) blocks.push(['Staff it with these roles, as many of each as the work needs:', ...w.roles.map(r => roleItem(r, h))].join('\n'))
  } else {
    const stages = w.stages.filter(s => s.agents.length)
    const stage = (s: { agents: SavedAgent[] }, k: number) => [`Stage ${k + 1}, ${k ? `after stage ${k} finishes` : 'start together'}:`, ...s.agents.map(a => agentItem(a, h))]
    if (stages.length) blocks.push(stages.flatMap(stage).join('\n'))
  }
  return blocks.join('\n\n')
}

// Agent files

/** What a copied agent file carries when Run registers it. `name` is the file's own, which the engine names `redhelm:<name>`. */
export type AgentSpecIn = { name: string; description: string; prompt: string; tools?: string[]; disallowedTools?: string[]; model?: string;
  effort?: string; maxTurns?: number; skills?: string[]; initialPrompt?: string; memory?: 'user' | 'project' | 'local'; background?: true; isolation?: 'worktree' | 'remote' }

/** A front matter key as written: the value on its line, and the lines under it (indented, or `- ` items). */
type Written = { text: string; block: string[] }
type FrontMatter = { fields: Map<string, Written>; body: string; error?: string }

/** Why a value cannot be carried as written, for the toast after `Couldn't add <name> · `. */
class Fault {
  constructor(readonly error: string) {}
}

/** The keys a spec reads: one of them set twice cannot be carried as written. A key it never reads may repeat. */
const READ = ['name', 'description', 'tools', 'disallowedTools', 'model', 'effort', 'maxTurns', 'skills', 'initialPrompt', 'memory', 'background', 'isolation']
const KEY = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/
const ITEM = /^\s*-(?:\s|$)/
const COMMENT = /^\s*#/

/**
 * The front matter between the first two `---` lines, read as a YAML subset: `key: value` lines at
 * the left edge, each with the lines under it (indented, or `- ` items) as its block. A block is its
 * key's alone: what it holds is never read as keys. Comment lines are passed over. The first line that
 * is none of these, or a key a spec reads set twice, is the error; reading goes on, so the name is
 * still found. Undefined without an opening `---`.
 */
function frontMatter(definition: string): FrontMatter | undefined {
  const lines = definition.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trimEnd() !== '---') return undefined
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---')
  if (end < 0) return { fields: new Map(), body: '', error: 'The front matter never ends' }
  const fields = new Map<string, Written>()
  let error: string | undefined
  let open: Written | undefined
  for (let i = 1; i < end; i++) {
    const l = lines[i]!
    if (!l.trim() || /^\s/.test(l) || ITEM.test(l)) {
      if (open) open.block.push(l)
      else if (l.trim()) error ??= `Front matter line ${i + 1} isn't key: value`
      continue
    }
    if (l.startsWith('#')) continue
    const m = KEY.exec(l)
    if (!m) {
      error ??= `Front matter line ${i + 1} isn't key: value`
      open = undefined
      continue
    }
    open = { text: m[2]?.trim() ?? '', block: [] }
    if (!fields.has(m[1]!)) fields.set(m[1]!, open)
    else if (READ.includes(m[1]!)) error ??= `${m[1]} is set twice`
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim(), error }
}

/** A plain or quoted value: quotes taken off (with their escapes), a ` # comment` after a plain one dropped. */
function scalar(raw: string): string {
  const t = raw.trim()
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(t)
  if (dq) {
    try {
      return JSON.parse(`"${dq[1]}"`) as string
    } catch {
      return dq[1]!
    }
  }
  const sq = /^'((?:[^']|'')*)'/.exec(t)
  if (sq) return sq[1]!.replace(/''/g, "'")
  return t.startsWith('#') ? '' : t.replace(/\s+#.*$/, '')
}

/** The block's lines that say something, trimmed. */
const said = (e: Written) => e.block.filter(l => l.trim() && !COMMENT.test(l)).map(l => l.trim())
const blank = (e: Written) => !e.text && !said(e).length

/** A `|` or `>` block's lines, without the indent they share; blank lines at its end dropped. */
function dedent(block: readonly string[]) {
  const lines = [...block]
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length))
  return lines.map(l => (l.trim() ? l.slice(indent) : ''))
}

/** A value as text: a `|` block as its lines; a `>` block, or a plain value over several lines, folded to one; quotes taken off. */
function textOf(key: string, e: Written): string | Fault {
  if (/^[|>][-+0-9]*$/.test(scalar(e.text)) && !/^["']/.test(e.text)) {
    const lines = dedent(e.block)
    return e.text.startsWith('|') ? lines.join('\n').trimEnd() : lines.map(l => l.trim()).join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n\n/g, '\n').trim()
  }
  const rest = said(e)
  if (/^[[{]/.test(e.text) || (!e.text && rest.some(l => ITEM.test(l)))) return new Fault(`${key} isn't text`)
  return scalar([e.text, ...rest].filter(Boolean).join(' '))
}

/** Items split at commas outside brackets, so `Bash(git add:*, git commit:*)` stays one. */
function items(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[') depth++
    else if ((c === ')' || c === ']') && depth) depth--
    else if (c === ',' && !depth) {
      out.push(text.slice(from, i))
      from = i + 1
    }
  }
  out.push(text.slice(from))
  return out.map(s => scalar(s)).filter(Boolean)
}

/** A value as a list: `[a, b]`, `a, b`, or `- a` lines. */
function listOf(key: string, e: Written): string[] | Fault {
  const rest = said(e)
  const fault = new Fault(`${key} isn't a list`)
  if (!e.text) return rest.every(l => ITEM.test(l)) ? rest.map(l => scalar(l.replace(ITEM, ''))).filter(Boolean) : fault
  if (rest.some(l => ITEM.test(l)) || e.text.startsWith('{')) return fault
  const text = [e.text, ...rest].join(' ')
  if (!text.startsWith('[')) return items(scalar(text))
  const flow = text.replace(/\s+#.*$/, '')
  return flow.endsWith(']') ? items(flow.slice(1, -1)) : fault
}

/** How a carried key's value reads: text, a list, true or false, a number of turns, or one of a few words. */
type Kind = 'text' | 'list' | 'flag' | 'turns' | readonly string[]

const CARRIED: readonly (readonly [Exclude<keyof AgentSpecIn, 'name' | 'description' | 'prompt'>, Kind])[] = [
  ['tools', 'list'], ['disallowedTools', 'list'], ['model', 'text'], ['effort', 'text'], ['maxTurns', 'turns'], ['skills', 'list'], ['initialPrompt', 'text'],
  ['memory', ['user', 'project', 'local']], ['background', 'flag'], ['isolation', ['worktree', 'remote']],
]

/** A key's value as its kind reads it; `false` and empty text are none. */
function valueOf(key: string, kind: Kind, e: Written): unknown {
  if (kind === 'list') return listOf(key, e)
  const t = textOf(key, e)
  if (t instanceof Fault || kind === 'text' || !t) return t || undefined
  if (kind === 'flag') return /^true$/i.test(t) || (/^false$/i.test(t) ? undefined : new Fault(`${key} isn't true or false`))
  if (kind === 'turns') return /^[1-9]\d*$/.test(t) ? Number(t) : new Fault(`${key} isn't a whole number`)
  return kind.includes(t) ? t : new Fault(`${key} isn't ${and(kind, 'or')}`)
}

/** The name a project's agent file gives its type, as Claude Code dispatches it; undefined when it gives none. */
export function typeName(definition: string): string | undefined {
  const e = frontMatter(definition)?.fields.get('name')
  const name = e && textOf('name', e)
  return typeof name === 'string' && name ? name : undefined
}

/**
 * A copied agent file as Run registers it: what travels (`description`, the body as `prompt`, `tools`,
 * `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `background`,
 * `isolation`), and which of `hooks`, `mcpServers` and `permissionMode` the file has, which stay
 * behind. Other keys are passed over. A value it cannot read is an error, never left out: a `tools`
 * dropped would give the agent every tool.
 */
export function agentSpec(definition: string): { spec: AgentSpecIn; leftBehind: string[] } | { error: string } {
  const fm = frontMatter(definition)
  if (!fm) return { error: 'No front matter' }
  if (fm.error) return { error: fm.error }
  const read = (key: string, kind: Kind) => {
    const e = fm.fields.get(key)
    return e && !blank(e) ? valueOf(key, kind, e) : undefined
  }
  const name = read('name', 'text')
  const description = read('description', 'text')
  if (name instanceof Fault) return { error: name.error }
  if (!name) return { error: 'No name' }
  if (description instanceof Fault) return { error: description.error }
  if (!description) return { error: 'No description' }
  const spec: Record<string, unknown> = { name, description, prompt: fm.body }
  for (const [key, kind] of CARRIED) {
    const v = read(key, kind)
    if (v instanceof Fault) return { error: v.error }
    if (v !== undefined) spec[key] = v
  }
  return { spec: spec as AgentSpecIn, leftBehind: LEFT_BEHIND.filter(k => fm.fields.has(k)) }
}
