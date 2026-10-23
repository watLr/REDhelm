import type { Agent } from '../types'

/**
 * The few words REDhelm asks Claude Code's small model for, the way /btw asks a side question: a
 * headline for what an agent is doing, a short title for what it asked. Rare, cached, optional;
 * the plain words show until a label arrives and whenever none does.
 */

/** Asks the model; resolves its reply's text, or undefined when there was none (an error, a timeout). */
export type Complete = (ask: { system: string; prompt: string }) => Promise<string | undefined>

/** An agent's headline changes at most this often, and only when its work did. */
export const HEADLINE_EVERY_MS = 45_000
/** Label calls a REDhelm makes in any hour, at most; past it, the plain words stay. */
export const CALLS_PER_HOUR = 30
const CACHE = 200

const SYSTEM = {
  headline:
    'You write the status line of a coding agent on a dashboard. Reply with one present-tense phrase of at most 6 words saying what the agent is doing now, starting with a verb ending in -ing, like "Rewriting the setup guide". No quotes, no final period, nothing else.',
  title:
    'You shorten a question a coding agent asked its user into a title of at most 8 words, like "Add a README section?". Keep it a question when it asks one. Reply with the title only, no quotes.',
} as const

export type Kind = keyof typeof SYSTEM

/** What a headline is written from: the task, the latest steps and the agent's latest words. */
export const headlineInput = (a: Agent) =>
  [
    `Task: ${(a.brief || a.description || '').slice(0, 300)}`,
    `Latest steps, newest first: ${(a.steps ?? []).slice(0, 5).map(s => s.text).join('; ') || 'none yet'}`,
    a.thinking ? `Its latest words: ${a.thinking.slice(0, 600)}` : '',
  ].filter(Boolean).join('\n')

export const titleInput = (question: string) => question.slice(0, 1200)

/**
 * What a headline is about: the task and the steps, not the agent's latest words. Those change on
 * every model request; asking again for each would cost a call for a headline that reads the same.
 */
export const headlineKey = (a: Agent) =>
  // Only what REDhelm itself recorded: the brief and the steps. The description Claude Code lists can change on its own.
  hash(`${(a.brief ?? '').slice(0, 300)}\n${(a.steps ?? []).slice(0, 5).map(s => s.text).join('; ')}`)

const REFUSAL = /^(i\s+(can['’]?t|cannot|am unable|won['’]?t)|i['’]m (sorry|unable)|sorry\b|as an ai)/i
const WRAPPING = /^["'`*_“”‘’\s]+|["'`*_“”‘’\s]+$/g

/** The reply as a label: its first line, unquoted, at most `words` words and 48 characters; nothing for an empty reply or a refusal. */
export function clean(text: string | undefined, words: number, keepQuestion = false): string | undefined {
  let line = (text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
  line = line.replace(WRAPPING, '').replace(/^(headline|title|status)\s*:\s*/i, '').replace(WRAPPING, '')
  const asks = keepQuestion && line.endsWith('?')
  line = line.replace(/[\s.,;:!?…]+$/, '')
  if (!line || REFUSAL.test(line)) return undefined
  let out = line.split(/\s+/).slice(0, words).join(' ')
  if (out.length > 48) out = out.slice(0, 48).replace(/\s+\S*$/, '') || out.slice(0, 48)
  return asks ? `${out}?` : out
}

/** FNV-1a: the cache keeps a short key per input, not the input. */
export function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * One call at a time across REDhelm; the same key never costs a second call; each agent or question
 * is asked at most every 45 seconds; and no more than 30 calls go out in any hour. A reply that
 * cleans to nothing is remembered as nothing; a call that failed is not, so it is tried again later.
 */
export function labeler() {
  const cache = new Map<string, string | null>()
  const asked = new Map<string, number>()
  const sent: number[] = []
  let busy = false
  const keep = (k: string, v: string | null) => {
    cache.delete(k)
    cache.set(k, v)
    if (cache.size > CACHE) cache.delete(cache.keys().next().value!)
  }
  return {
    /** `key`: what the label is about (the input itself unless given); a new key is a new label. */
    async ask(complete: Complete, kind: Kind, id: string, input: string, at: number, key = hash(input)): Promise<string | undefined> {
      const k = `${kind}:${key}`
      if (cache.has(k)) return cache.get(k) ?? undefined
      const who = `${kind}:${id}`
      while (sent.length && at - sent[0]! >= 3_600_000) sent.shift()
      if (busy || sent.length >= CALLS_PER_HOUR || at - (asked.get(who) ?? -Infinity) < HEADLINE_EVERY_MS) return undefined
      busy = true
      asked.set(who, at)
      sent.push(at)
      try {
        const text = await complete({ system: SYSTEM[kind], prompt: input }).catch(() => undefined)
        if (text === undefined) return undefined
        const label = clean(text, kind === 'headline' ? 6 : 8, kind === 'title')
        keep(k, label ?? null)
        return label
      } finally {
        busy = false
      }
    },
  }
}
