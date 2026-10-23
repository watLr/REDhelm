# REDhelm: live traces redesign

Date: 2026-10-23 · Status: approved direction, spec for review

## Why

REDhelm reads like a page of sentences ("is running checks", "1 needs you · 3 working").
It should read like a product: aligned columns, state you see instead of read, motion that
means something, and a few precise words. A small model writes those words.

## Red thread

**Every agent is a live signal.** Its row carries a trace of its tool calls: the trace
moves when the agent works, flattens when it goes quiet, and the row's edge turns amber
when it asks you something. State is shown by the trace and one glyph, not by a sentence.
Nothing moves unless the underlying state changed.

Signature: the braille activity trace beside every live agent.

## Users and constraints

- One person supervising several Claude Code agents, glancing at REDhelm between other work.
- Surfaces: right sidebar (dock, 22 to about 60 columns), bottom bar (one line per agent,
  about 6 rows), classic layout (pane inline, no clicks), desktop, VS Code, mobile.
- Light and dark themes; colours come from the theme's meaning keys.
- Model calls are billed to the person: rare, cached, optional.

## 1. Layout

### Row grid (shared by every list row)

```
edge │ state │ name (flex) │ trace │ time │ ›
 1   │  2    │  min 6      │ 8 (4) │  4   │ 1
```

- `edge`: `▌` in amber for a question, otherwise a space.
- `state` glyphs:

  | Glyph | State | Colour |
  |---|---|---|
  | `▶` | working | default |
  | `▷` | quiet (no action for 15 minutes, still live; the existing rule) | subtle |
  | `◆` | waiting on another agent or on work it started | subtle |
  | `⚑` | asks you | warning |
  | `✓` | finished | success |
  | `✕` | failed or stopped | error |

- `name`: truncates with `…`; never wraps in a list row.
- `trace`: 8 braille cells; 4 below 30 columns; hidden for finished agents.
- `time`: right-aligned, tabular: `12s`, `3m`, `1h`, `2d`.
- `›`: opens the sheet. The whole row is pressable.
- Second line, indented under the name: the agent's **headline** (see §3), subtle colour,
  truncated to one line.

### Header

`REDhelm` (brand mark, the only red) and counts on the right: `⚑ 1  ▶ 3  ✓ 2`.
Zero counts are left out. No agents: `No agents yet` in subtle text.

### Question card

```
▌⚑ docs                    asks · 2m
▌  Add a README section?
▌  [ Reply ]  Dismiss      Details ›
```

- The amber edge runs down the whole card.
- The title is the question's **short title** (§3); the full text lives in the sheet.
- Dismiss appears only once the agent has ended (unchanged rule).

### Hover actions

A working row has a hidden actions box (`display: none`, absolutely positioned over the
time column, row background) that reveals on hover through a scope per row:
`Message` and `Stop`. No hook runs on hover. On surfaces without a pointer the row still
opens the sheet, where the actions are.

### Bottom bar (wide)

One line per agent: `edge state name  trace  headline …  time`. Counts in the header line.
The composer line and update line are unchanged in place.

### Sheet (drawn in the panel, with ← Back)

1. `← Back`, then the identity line: state glyph, name, time.
2. Actions row: Reply/Message, Stop or Dismiss.
3. Question (if any), full text.
4. A 16-cell trace across the width (4 rows tall on terminal ≥ 40 columns).
5. Task: the brief collapsed to 2 lines with More.
6. Steps: the grouped list, newest first, 6 shown.
7. A key–value block: Files, Model (with `◷` when an older model), Context.
8. Last said.

Fields stack (label above value) under 50 columns, as now.

### Things removed

- Avatars (initial on a coloured block): the trace and glyph identify rows.
- "Asks you" and "Older model" text badges in list rows (glyph and `◷` instead).
- Prose status lines in rows ("is running checks"); kept as the plain fallback text only.

## 2. Motion

- **Trace**: per agent, a ring of 32 two-second buckets (64 seconds) counting tool calls.
  Rows show the newest 16 buckets as 8 cells; the sheet shows all 32 as 16 cells. Rendering
  maps each pair of buckets to one braille cell (left and right columns of dots, 4 levels
  each). Terminal: a `Raster` keyed `trace-<agentId>`, repainted with `$.ui.blit` at
  8 frames a second while that agent had a tool call in the last 32 seconds and the pane is
  shown. Other surfaces: an `Svg` polyline from the same buckets, redrawn with the panel.
  A quiet agent's trace is flat and stops repainting.
- **Time**: `$.ui.invalidate('ui.render')` once a second while the pane is shown and any
  agent is live (times are derived from timestamps).
- **New question**: the amber edge alternates warning/subtle 3 times over about 1.5
  seconds (timestamp-derived, via invalidate), then stays solid.
- **Setting** `motion: on | off` (default on). Off: no blits, no pulse; times update with
  normal redraws.

Budget: one blit per active agent per frame; no full redraw more than once a second for
motion. Trace data lives in module memory (visual only; a reload restarts it flat).

## 3. Labels written by Haiku (`/btw`-style side calls)

- Call: `$.model.complete({ model: 'haiku', effort: 'low', maxTokens: 30, timeoutMs: 6000,
  system, prompt })` with an `AbortController` cancelled on unload.
- **Headline** (per agent): input is the task (first 300 characters), the last 5 steps and
  up to 600 characters of its latest thinking, paths already tidied. Output: a present-tense
  phrase of 6 words or fewer, no quotes, no trailing period. Example: `Rewriting the setup
  guide`.
- **Question title** (per question): input is the question; output 8 words or fewer, ending
  in `?` when it asks.
- When: a headline is requested when an agent's steps change, at most once every 20
  seconds per agent; one call in flight at a time across REDhelm; only while REDhelm is on
  screen. Results cached by a hash of the input (in module memory, 200 entries).
- Fallback, always shown until a label arrives and whenever a call fails or times out:
  headline = the agent's current activity in plain words (today's `activity()`), title =
  the first sentence of the question, excerpted. The UI never waits on the model.
- Output is cleaned: first line only, quotes and trailing punctuation trimmed, capped at
  48 characters; an empty or refused answer falls back.
- **Setting** `labels: haiku | plain` (default haiku).

## 4. States

| State | Row | Sheet |
|---|---|---|
| Working | `▶`, moving trace, headline | big trace moving |
| Quiet | `▷` subtle, flat trace, `quiet` in time column | flat trace |
| Waiting on agent/work | `◆`, flat trace, `waits` | names what it waits on |
| Asks you | question card, amber edge | question first |
| Finished / failed | in the folded Finished list, `✓`/`✕`, no trace | Last said |
| No agents | `No agents yet` | — |
| Label pending/failed | plain fallback text | same |
| Classic layout | unchanged `Buttons need the fullscreen layout` line | — |
| Motion off | static traces (updated with redraws) | — |

## 5. Settings

Add to plugin options: `motion` (`on`/`off`, default `on`) and `labels` (`haiku`/`plain`,
default `haiku`). Both documented in the README.

## 6. Code shape

- `hooks/trace.ts` (new, pure): bucket ring (`record(at)`, `buckets(now)`), braille
  encoding (`brailleRow(buckets, cells)`), Raster cell packing (`rasterCells(...)`), SVG
  points.
- `hooks/labels.ts` (new): queue, cache, prompt building, output cleaning, fallback. Takes
  a `complete` function so tests can stand it in.
- `hooks/view.tsx`: rebuilt around `Row`, `QuestionCard`, `Header`, `Trace`, `Sheet`
  components using the grid; avatars and badges removed.
- `hooks/register.tsx`: record tool calls into traces, blit timer, invalidate ticker,
  label requests, new settings.
- `types/index.d.ts`: `Agent.headline?`, `Message.title?`.

## 7. Testing

- Unit: braille encoding and bucket rolling; Raster cell bytes; label cleaning, cache,
  rate limit, fallback on error/timeout.
- View: state glyphs per status; question card shows the title, sheet shows full text;
  hover actions present (hidden) per working row; counts header; narrow (22 columns) keeps
  name and time; motion off renders no Raster.
- Existing behaviour tests updated to the new copy.
- Live (Claude Code 2.1.309): 22- and 48-column sidebar, 120-column bottom bar, light and
  dark, classic layout; screenshots checked with squint, strip and five-second tests.

## Out of scope

- An "ask REDhelm a question" box (a `/btw` for agents). Possible later.
- Changes to the model guard, setup card, workflows or update line beyond restyling.

## Changes made while building (0.6.0)

Found on the live render and kept:

- **Bars, not braille.** Braille dots rendered as faint specks in a terminal sidebar. The
  trace uses block bars (`▁▂▃▄▅▆▇█`), one 4-second bucket per cell: a row shows 8 cells
  (32 s), the sheet 16 (64 s). Moving bars use a mid-grey, so the name stays the first read.
- **One-row sheet trace.** Stacked rows of bars break apart at terminal line spacing.
- **Redraw only when a shown time changes.** The ticker compares every shown time
  (`clockFace`) and redraws only on a change, so an agent past its first minute redraws
  once a minute and its trace moves by Raster repaints alone. The 125 ms frame loop runs
  only while REDhelm is on screen and a trace still moves.
- **Narrow question card.** Below 34 columns the card shows the age without `asks ·`;
  below 30, chips use one column of padding.
- **Surface choice.** Element tables name every element on every surface (a missing one
  draws nothing), so Raster vs Svg is chosen by `e.surface`.
- **Colour (0.6.2, asked for after 0.6.1).** Each agent has its own hue (no orange: that is
  a question's amber): a stripe down its row, its trace as a comet tail (grey at the oldest
  bar to full hue at the newest), and a spectrum line under the header, each working
  agent's share of the last minute's tool calls. The amber `Asks you` pill returns on
  question cards (34 columns and up) and in the bar.
- **Background (0.7.0, chosen from four concepts rendered live).** The docked terminal sidebar
  draws a pane-sized Raster behind everything (`hooks/backdrop.ts`): black with a `+` lattice;
  each tool call sends a ring through it in the agent's hue from its segment of the activity
  line. Rows, the header and loose lines sit on plates of the field colour (text inside a
  coloured Box takes its colour; bare text paints the pane's grey). Options: ripples (default),
  lattice, field (value-noise clouds through an ASCII ramp), ember, none. Rings repaint at
  8 fps for 2.4 s after a call; field and ember at 4 fps; still backdrops are drawn once.
