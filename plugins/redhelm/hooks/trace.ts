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

/** What a Raster's `cells` takes: per cell, its code point, foreground and background as little-endian u32s, in base64. */
export function rasterCells(lines: readonly string[], fg = DEFAULT_COLOR): string {
  const bytes: number[] = []
  const word = (w: number) => bytes.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255)
  for (const line of lines) {
    for (const ch of line) {
      word(ch.codePointAt(0)!)
      word(fg)
      word(DEFAULT_COLOR)
    }
  }
  return base64(bytes)
}

/** One agent's trace, `cells` wide and `rows` tall, as Raster cells at `now`. */
export const traceRaster = (times: readonly number[], now: number, cells: number, rows: number, fg: number) =>
  rasterCells(bars(buckets(times, now, cells), rows), fg)

/** The same trace for surfaces that draw SVG: a step line over the baseline. */
export function svgTrace(counts: readonly number[], width: number, height: number, rows: number, color: string) {
  const h = heights(counts, rows)
  const top = rows * 8
  const step = width / Math.max(1, counts.length)
  const y = (v: number) => (height - 1.5 - ((v - 1) / Math.max(1, top - 1)) * (height - 3)).toFixed(1)
  const points = h.map((v, i) => `${(i * step).toFixed(1)},${y(v)} ${((i + 1) * step).toFixed(1)},${y(v)}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`
}
