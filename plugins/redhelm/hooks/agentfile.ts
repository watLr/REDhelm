/**
 * A project's agent file, read so its type can travel with a saved workflow: the name Claude Code
 * dispatches it by, and what Run registers of it. Pure: the file's text in, a spec or a reason out.
 */

/** What a copied agent file keeps but Run never registers, in this order: the first two run commands, the third widens permissions. */
export const LEFT_BEHIND = ['hooks', 'mcpServers', 'permissionMode'] as const

/** "a or b", "a, b or c". */
const or = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : (xs[0] ?? ''))

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
  const lines = definition.replace(/^\uFEFF/, '').split('\n')
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

/** Line ends as `\n`, whether the file was written with `\r\n` or `\r`. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * A plain or quoted value: quotes taken off (with their escapes), a ` # comment` after it dropped.
 * Undefined when anything but a comment follows a closing quote: `"Read" Grep` is no value.
 */
function scalar(raw: string): string | undefined {
  const t = raw.trim()
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(t)
  const sq = dq ? undefined : /^'((?:[^']|'')*)'/.exec(t)
  const quoted = dq ?? sq
  if (quoted) {
    const after = t.slice(quoted[0].length)
    if (after.trim() && !/^\s+#/.test(after)) return undefined
    if (sq) return sq[1]!.replace(/''/g, "'")
    try {
      return JSON.parse(`"${quoted[1]}"`) as string
    } catch {
      return quoted[1]!
    }
  }
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
  const fault = new Fault(`${key} isn't text`)
  if (/^[|>]/.test(e.text)) {
    if (!/^[|>][-+0-9]*(?:\s+#.*)?$/.test(e.text)) return fault
    const lines = dedent(e.block)
    return e.text.startsWith('|') ? lines.join('\n').trimEnd() : lines.map(l => l.trim()).join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n\n/g, '\n').trim()
  }
  const rest = said(e)
  if (/^[[{]/.test(e.text) || (!e.text && rest.some(l => ITEM.test(l)))) return fault
  return scalar([e.text, ...rest].filter(Boolean).join(' ')) ?? fault
}

/** Values as items, empty ones dropped; undefined when one is no value. */
function valuesOf(raw: readonly string[]): string[] | undefined {
  const got = raw.map(s => scalar(s))
  return got.includes(undefined) ? undefined : (got as string[]).filter(Boolean)
}

/** Items split at commas outside brackets, so `Bash(git add:*, git commit:*)` stays one; undefined when one is no value. */
function items(text: string): string[] | undefined {
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
  return valuesOf(out)
}

/**
 * A value as a list: `[a, b]`, `a, b`, or `- a` lines. Anything else is no list, never names read out
 * of it: a `|` or `>` block, a map, text after a closing quote.
 */
function listOf(key: string, e: Written): string[] | Fault {
  const rest = said(e)
  const fault = new Fault(`${key} isn't a list`)
  if (!e.text) return (rest.every(l => ITEM.test(l)) && valuesOf(rest.map(l => l.replace(ITEM, '')))) || fault
  if (/^[|>{]/.test(e.text) || rest.some(l => ITEM.test(l))) return fault
  const text = [e.text, ...rest].join(' ')
  if (!text.startsWith('[')) {
    const plain = scalar(text)
    return (plain !== undefined && items(plain)) || fault
  }
  const flow = text.replace(/\s+#.*$/, '')
  return (flow.endsWith(']') && items(flow.slice(1, -1))) || fault
}

/**
 * How a carried key's value reads: text, a list, a list of tools, true or false, a number of turns, or
 * one of a few words. A list of tools is never empty: an empty allow-list must never risk reading as every tool.
 */
type Kind = 'text' | 'list' | 'tools' | 'flag' | 'turns' | readonly string[]

const CARRIED: readonly (readonly [Exclude<keyof AgentSpecIn, 'name' | 'description' | 'prompt'>, Kind])[] = [
  ['tools', 'tools'], ['disallowedTools', 'tools'], ['model', 'text'], ['effort', 'text'], ['maxTurns', 'turns'], ['skills', 'list'], ['initialPrompt', 'text'],
  ['memory', ['user', 'project', 'local']], ['background', 'flag'], ['isolation', ['worktree', 'remote']],
]

/** A key's value as its kind reads it; `false` and empty text are none. */
function valueOf(key: string, kind: Kind, e: Written): unknown {
  if (kind === 'list' || kind === 'tools') {
    const list = listOf(key, e)
    return kind === 'tools' && Array.isArray(list) && !list.length ? new Fault(`${key} is empty`) : list
  }
  const t = textOf(key, e)
  if (t instanceof Fault || kind === 'text' || !t) return t || undefined
  if (kind === 'flag') return /^true$/i.test(t) || (/^false$/i.test(t) ? undefined : new Fault(`${key} isn't true or false`))
  if (kind === 'turns') return /^[1-9]\d*$/.test(t) ? Number(t) : new Fault(`${key} isn't a whole number`)
  return kind.includes(t) ? t : new Fault(`${key} isn't ${or(kind)}`)
}

/** The name a project's agent file gives its type, as Claude Code dispatches it; undefined when it gives none. */
export function typeName(definition: string): string | undefined {
  const e = frontMatter(lf(definition))?.fields.get('name')
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
  const fm = frontMatter(lf(definition))
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
