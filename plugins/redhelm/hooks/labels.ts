import type { Agent } from '../types'

/**
 * The few words REDhelm asks Claude Code's small model for, the way /btw asks a side question: a
 * headline for what an agent is doing, a short title for what it asked. Rare, cached, optional;
 * the plain words show until a label arrives and whenever none does.
 */

/** Asks the model; resolves its reply's text, or undefined when there was none (an error, a timeout). */
export type Complete = (ask: { system: string; prompt: string }) => Promise<string | undefined>

/** A headline per agent, and a title per question, at most this often. */
export const HEADLINE_EVERY_MS = 20_000
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
 * One call at a time across REDhelm; the same input never costs a second call, and each agent or
 * question is asked at most every 20 seconds. A reply that cleans to nothing is remembered as
 * nothing; a call that failed is not, so it is tried again once the 20 seconds are up.
 */
export function labeler() {
  const cache = new Map<string, string | null>()
  const asked = new Map<string, number>()
  let busy = false
  const keep = (k: string, v: string | null) => {
    cache.delete(k)
    cache.set(k, v)
    if (cache.size > CACHE) cache.delete(cache.keys().next().value!)
  }
  return {
    async ask(complete: Complete, kind: Kind, id: string, input: string, at: number): Promise<string | undefined> {
      const k = `${kind}:${hash(input)}`
      if (cache.has(k)) return cache.get(k) ?? undefined
      const who = `${kind}:${id}`
      if (busy || at - (asked.get(who) ?? -Infinity) < HEADLINE_EVERY_MS) return undefined
      busy = true
      asked.set(who, at)
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
