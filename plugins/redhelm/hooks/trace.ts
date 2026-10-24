/**
 * An agent's activity trace: when its tool calls happened, drawn as bars on a flat baseline. The
 * bars rise while it works and flatten when it goes quiet. Pure: times in, text out.
 */

export const BUCKET_MS = 4000
/** A minute: the sheet's 16 cells, one bucket each. A row shows the newest 8, half a minute. */
export const BUCKETS = 16
const KEEP_MS = BUCKET_MS * BUCKETS
/** The terminal's own colour, in a Raster cell. */
export const DEFAULT_COLOR = 0x01000000

/** The call times worth keeping after one at `at`: the last 64 seconds, at most 400. */
export const record = (times: readonly number[], at: number) =>
  [...times.filter(t => at - t < KEEP_MS), at].slice(-400)

/**
 * Calls per 2-second bucket, oldest first; the last bucket holds `now`. Buckets sit on fixed
 * boundaries of the clock, so drawing again a moment later never shifts them.
 */
export function buckets(times: readonly number[], now: number, n = BUCKETS): number[] {
  const end = (Math.floor(now / BUCKET_MS) + 1) * BUCKET_MS
  const out = new Array<number>(n).fill(0)
  for (const t of times) {
    if (t > now) continue
    const k = n - 1 - Math.floor((end - 1 - t) / BUCKET_MS)
    if (k >= 0) out[k]!++
  }
  return out
}

/** Whether an agent called a tool in the last half minute: what a row's trace shows moving. */
export const isMoving = (times: readonly number[], now: number) =>
  times.some(t => t <= now && now - t < BUCKET_MS * 8)

/** One response an agent streamed: when it ended, the output tokens it carried, and how long they took to arrive. */
export type Burst = { at: number; tokens: number; ms: number }

const SPEED_MS = 60_000

/** The responses worth keeping after one more: the last minute's, at most 100. */
export const burst = (bursts: readonly Burst[], b: Burst) =>
  [...bursts.filter(x => b.at - x.at < SPEED_MS), b].slice(-100)

/**
 * How fast an agent's tokens arrive: output tokens a second while streaming, pooled over the last
 * minute so one short response doesn't swing it. Undefined when nothing streamed, or too briefly to time.
 */
export function speed(bursts: readonly Burst[], now: number): number | undefined {
  let tokens = 0
  let ms = 0
  for (const b of bursts) {
    if (b.at > now || now - b.at >= SPEED_MS) continue
    tokens += b.tokens
    ms += b.ms
  }
  return tokens > 0 && ms >= 250 ? Math.round(tokens / (ms / 1000)) : undefined
}

/** Eighths of a cell, bottom up: one bar level each. */
const LEVELS = '▁▂▃▄▅▆▇█'

/** Bar heights in eighths: 1 is the flat baseline, 8 × rows the top. Four calls fill a row; a busier window scales down. */
export function heights(counts: readonly number[], rows: number) {
  const top = rows * 8
  const scale = Math.max(4, ...counts)
  return counts.map(c => (c <= 0 ? 1 : Math.min(top, 1 + Math.max(1, Math.round((c / scale) * (top - 1))))))
}

/** The trace as lines of bars, top first, one bucket a cell. */
export function bars(counts: readonly number[], rows = 1): string[] {
  const h = heights(counts, rows)
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    const below = (rows - 1 - r) * 8
    lines.push(h.map(x => {
      const n = Math.max(0, Math.min(8, x - below))
      return n ? LEVELS[n - 1]! : ' '
    }).join(''))
  }
  return lines
}

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(b: readonly number[]) {
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += ABC[(n >> 18) & 63]! + ABC[(n >> 12) & 63]! + (i + 1 < b.length ? ABC[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? ABC[n & 63]! : '=')
  }
  return out
}

/**
 * What a Raster's `cells` takes: per cell, its code point, foreground and background as little-endian
 * u32s, in base64. `fg`: one colour, or one per column.
 */
export function rasterCells(lines: readonly string[], fg: number | readonly number[] = DEFAULT_COLOR, bg = DEFAULT_COLOR): string {
  const bytes: number[] = []
  const word = (w: number) => bytes.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255)
  for (const line of lines) {
    let i = 0
    for (const ch of line) {
      word(ch.codePointAt(0)!)
      word(typeof fg === 'number' ? fg : fg[i] ?? DEFAULT_COLOR)
      word(bg)
      i++
    }
  }
  return base64(bytes)
}

/** `a` part of the way to `b`, per channel: 0 is `a`, 1 is `b`. */
export function mix(a: number, b: number, t: number) {
  const ch = (x: number, s: number) => (x >> s) & 255
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s
  return (m(16) | m(8) | m(0)) >>> 0
}

/**
 * A comet tail: the newest column in the agent's own colour, older ones fading toward grey, so the
 * trace says how recent its work is as well as how much.
 */
export const tail = (color: number, grey: number, cells: number) =>
  Array.from({ length: cells }, (_, i) => mix(grey, color, 0.3 + 0.7 * (cells > 1 ? i / (cells - 1) : 1)))

/** One agent's trace, `cells` wide and `rows` tall, as Raster cells at `now`. */
export const traceRaster = (times: readonly number[], now: number, cells: number, rows: number, fg: number | readonly number[], bg?: number) =>
  rasterCells(bars(buckets(times, now, cells), rows), fg, bg)

/**
 * Who is busiest: each agent's share of the tool calls in the last minute, as whole cells of a line
 * `width` wide. Any agent that worked keeps at least one cell; an idle minute is an empty line.
 */
export function spectrum(traces: Record<string, readonly number[]>, now: number, width: number) {
  const calls = Object.entries(traces)
    .map(([id, times]) => ({ id, n: times.filter(t => t <= now && now - t < 60_000).length }))
    .filter(x => x.n > 0)
  const total = calls.reduce((s, x) => s + x.n, 0)
  if (!total || width < calls.length) return []
  const shares = calls.map(x => ({ ...x, cells: Math.max(1, Math.floor((x.n / total) * width)) }))
  // The cells rounding left over go to the busiest.
  let left = width - shares.reduce((s, x) => s + x.cells, 0)
  for (const x of [...shares].sort((a, b) => b.n - a.n)) {
    if (left <= 0) break
    x.cells++
    left--
  }
  while (left < 0) {
    const big = shares.reduce((m, x) => (x.cells > m.cells ? x : m))
    big.cells--
    left++
  }
  return shares.map(({ id, cells }) => ({ id, cells }))
}

/** The same trace for surfaces that draw SVG: a step line over the baseline. */
export function svgTrace(counts: readonly number[], width: number, height: number, rows: number, color: string, from = color) {
  const h = heights(counts, rows)
  const top = rows * 8
  const step = width / Math.max(1, counts.length)
  const y = (v: number) => (height - 1.5 - ((v - 1) / Math.max(1, top - 1)) * (height - 3)).toFixed(1)
  const points = h.map((v, i) => `${(i * step).toFixed(1)},${y(v)} ${((i + 1) * step).toFixed(1)},${y(v)}`).join(' ')
  // The same comet tail: faded at the oldest end, full colour at the newest.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="t" x1="0" x2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><polyline points="${points}" fill="none" stroke="url(#t)" stroke-width="1.5" stroke-linejoin="round"/></svg>`
}
