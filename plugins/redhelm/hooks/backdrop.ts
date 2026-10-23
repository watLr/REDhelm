/**
 * Backdrops: a whole-pane field of characters drawn behind REDhelm, the way an ASCII video renderer
 * turns frames into glyphs. Rows and cards sit on plates of the field's own colour, so text never
 * lands on the pattern. Pure: kind, size and time in, Raster cells out.
 */

export type Backdrop = 'ripples' | 'lattice' | 'field' | 'ember' | 'none'

/** A tool call: a ring spreading from where its agent sits on the activity line. */
export type Ripple = { x: number; y: number; at: number; color: number }

/** The field's colours for a theme: its background, the lattice, and the glow. */
export type Palette = { bg: number; lattice: number; dim: number; bright: number; ember: number }

export const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { bg: 0x000000, lattice: 0x303030, dim: 0x181818, bright: 0x4a4a4a, ember: 0xc0262d },
  light: { bg: 0xfafafa, lattice: 0xd2d2d8, dim: 0xe8e8ec, bright: 0xa8a8b0, ember: 0xe0525a },
}

/** How long a ring travels before it is gone. */
export const RIPPLE_S = 2.4

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Raster cells: per cell its code point, foreground and background as little-endian u32s, in base64. */
function pack(chars: number[], fg: number[], bg: number) {
  const b: number[] = []
  const word = (w: number) => b.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255)
  for (let i = 0; i < chars.length; i++) {
    word(chars[i]!)
    word(fg[i]!)
    word(bg)
  }
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += ABC[(n >> 18) & 63]! + ABC[(n >> 12) & 63]! + (i + 1 < b.length ? ABC[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? ABC[n & 63]! : '=')
  }
  return out
}

const mix = (a: number, b: number, t: number) => {
  const ch = (x: number, s: number) => (x >> s) & 255
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * Math.max(0, Math.min(1, t))) << s
  return (m(16) | m(8) | m(0)) >>> 0
}

const code = (s: string) => [...s].map(c => c.codePointAt(0)!)
const SPACE = 0x20
const PLUS = 0x2b
/** Dark to bright, as an ASCII renderer reads luminance. */
const RAMP = code(' .·:-=+*')
const DOTS = code(' .·∙•')

/** A lattice point: every fourth column, every other row. */
export const isLattice = (x: number, y: number) => x % 4 === 2 && y % 2 === 1

// Value noise, for the field's clouds

const hash = (x: number, y: number, z: number) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Value noise in 0..1, smooth across cells; `z` slides between layers so it evolves as well as drifts. */
function noise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi)
  const layer = (k: number) => {
    const a = hash(xi, yi, k), b = hash(xi + 1, yi, k), c = hash(xi, yi + 1, k), d = hash(xi + 1, yi + 1, k)
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
  }
  return layer(zi) + (layer(zi + 1) - layer(zi)) * zf
}

/** Three octaves: big soft shapes with finer grain on top. */
const fbm = (x: number, y: number, z: number) =>
  noise(x, y, z) * 0.6 + noise(x * 2.03, y * 2.03, z * 1.7) * 0.28 + noise(x * 4.1, y * 4.1, z * 2.3) * 0.12

/** Whether a backdrop changes with time (and so needs repainting while shown). */
export const animates = (kind: Backdrop, ripples: readonly Ripple[], t: number) =>
  kind === 'field' || kind === 'ember' || (kind === 'ripples' && ripples.some(r => t - r.at >= 0 && t - r.at < RIPPLE_S))

/**
 * One frame of a backdrop, `cols` × `rows` cells. `t`: seconds; `pace`: how busy the agents are,
 * 0 (idle) to 1, which speeds the field; `ripples`: rings in flight (ripples only).
 */
export function backdrop(kind: Backdrop, cols: number, rows: number, t: number, p: Palette, pace = 0, ripples: readonly Ripple[] = []): string {
  const n = cols * rows
  const chars = new Array<number>(n).fill(SPACE)
  const fg = new Array<number>(n).fill(p.lattice)
  const at = (x: number, y: number) => y * cols + x

  if (kind === 'lattice' || kind === 'ripples') {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (isLattice(x, y)) chars[at(x, y)] = PLUS
  }

  if (kind === 'ripples') {
    for (const r of ripples) {
      const age = t - r.at
      if (age < 0 || age >= RIPPLE_S) continue
      const radius = age * 20
      const fade = (1 - age / RIPPLE_S) ** 1.5
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        // Rows are about twice as tall as columns are wide: the ring stays round on screen.
        const off = Math.abs(Math.hypot(x - r.x, (y - r.y) * 2.1) - radius)
        if (off > 2.4) continue
        const strength = fade * (1 - off / 2.4)
        const i = at(x, y)
        if (isLattice(x, y)) fg[i] = mix(fg[i]!, r.color, Math.min(1, 0.3 + strength))
        else if (strength > 0.3) {
          chars[i] = strength > 0.65 ? DOTS[3]! : DOTS[2]!
          fg[i] = mix(p.bg, r.color, Math.min(1, strength * 0.9))
        }
      }
    }
  }

  if (kind === 'field') {
    // Drifting clouds of noise read through a luminance ramp: the ASCII-video trick, near the background.
    const s = t * (0.4 + 1.6 * pace)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const w = (fbm(x * 0.09 + s * 0.35, y * 0.19 - s * 0.12, s * 0.05) - 0.43) / 0.42
      if (w <= 0) continue
      chars[at(x, y)] = RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(w * (RAMP.length - 1)))]!
      fg[at(x, y)] = mix(p.dim, p.bright, Math.min(1, w))
    }
  }

  if (kind === 'ember') {
    // A halftone glow in REDhelm red, rising from the lower corner and breathing slowly.
    const breath = 0.85 + 0.15 * Math.sin(t * 0.8)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const d = Math.hypot((x - cols * 0.75) / cols, ((y - rows) / rows) * 1.15)
      const flicker = 0.5 + 0.5 * Math.sin(x * 1.7 + y * 2.3 + t * 1.6)
      const g = Math.max(0, 1 - d * 0.95) ** 1.4 * breath * (0.8 + 0.2 * flicker)
      const k = Math.min(DOTS.length - 1, Math.floor(g * DOTS.length * 1.25))
      if (!k) continue
      chars[at(x, y)] = DOTS[k]!
      fg[at(x, y)] = mix(p.bg, p.ember, 0.15 + g * 0.75)
    }
  }

  return pack(chars, fg, p.bg)
}
