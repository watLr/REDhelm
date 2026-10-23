# REDhelm live traces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild REDhelm's panel around one aligned row grid with a live braille activity trace per agent, state glyphs instead of sentences, hover actions, and short labels written by Haiku.

**Architecture:** Two new pure modules: `hooks/trace.ts` (call times → buckets → braille → Raster cells or SVG) and `hooks/labels.ts` (prompts, output cleaning, cache, rate limit). `hooks/view.tsx` is rebuilt on them. `hooks/register.tsx` records tool calls into traces, runs a 1 s ticker (times, label requests, visibility) and a 125 ms frame loop that repaints mounted Rasters with `$.ui.blit` only when their cells changed.

**Tech Stack:** Claude Code function-hook mod API (2.1.309): `Raster` + `$.ui.blit`, `Svg`, `$.model.complete`, BoxHoverProps reveal; `claude plugin test`; tsc 5.6 from the scratchpad.

**Spec:** `docs/superpowers/specs/2026-10-23-redhelm-live-traces-design.md`

## Global Constraints

- Row grid: `edge 1 │ state 1+gap │ name (flex, min 6) │ trace 8 (4 below 30 columns) │ time 5 │ › 1`.
- Glyphs: `▶` working, `▷` quiet (15-minute rule), `◆` waiting, `⚑` asks, `✓` done, `✕` failed or stopped; `◷` older model.
- The only red is the brand mark. Colours come from theme keys, plus the existing PALETTE surfaces.
- Haiku calls: `model: 'haiku', effort: 'low', maxTokens: 30, timeoutMs: 6000`, at most one in flight, a headline per agent at most every 20 s, only while REDhelm is on screen, cache of 200 by input hash. Headline ≤ 6 words, title ≤ 8 words, ≤ 48 characters.
- The UI never waits on the model: plain words show until a label arrives.
- Settings: `motion` (`on`/`off`, default `on`), `labels` (`haiku`/`plain`, default `haiku`).
- Privacy: no personal names, emails or home paths in anything committed. Commits use the noreply identity, and every push gets a scan over files and `git log -p` first.

## Review Focus

1. **An agent that ends while its trace is mounted.** The row moves to Finished and the Raster's key is gone. A blit to it is denied and the key is dropped, with no error loop. *Test:* Task 5, "frame drops a denied key".
2. **The model replies with junk** (quotes, a period, a refusal, three lines, 20 words). The label is cleaned or falls back. *Test:* Task 2, `clean` cases.
3. **A timeout or API error from Haiku.** The plain words stay, the failure isn't cached forever, and the call is retried after 20 s. *Test:* Task 2, "failure is retried after the rate window".
4. **A 22-column sidebar.** The name keeps at least 6 columns and the time stays visible, with a 4-cell trace. *Test:* Task 4, narrow render.
5. **Motion off, or a surface without Raster.** No Raster is drawn and nothing blits. The braille shows as text in the terminal and as Svg elsewhere. *Test:* Task 4 (motion off) and the every-surface test.

---

### Task 1: `hooks/trace.ts`

**Files:**
- Create: `plugins/redhelm/hooks/trace.ts`
- Test: `plugins/redhelm/tests/redhelm.test.tsx` (new `describe('traces')`)

**Interfaces:**
- Produces:
  - `BUCKET_MS = 2000`, `BUCKETS = 32`, `DEFAULT_COLOR = 0x01000000`.
  - `record(times: readonly number[], at: number): number[]` keeps the last 64 s, at most 400 entries.
  - `buckets(times, now, n = BUCKETS): number[]` is oldest first, on fixed 2 s boundaries.
  - `isMoving(times, now): boolean` is true for a call in the last 32 s.
  - `heights(counts, rows): number[]` gives 1..4·rows dots.
  - `braille(counts, rows = 1): string[]` lists the rows, top first, two buckets per cell.
  - `rasterCells(lines, fg = DEFAULT_COLOR): string` is base64 of LE u32 `[cp, fg, bg]` triplets.
  - `traceRaster(times, now, cells, rows, fg): string`.
  - `svgTrace(counts, width, height, rows, color): string`.

- [ ] **Step 1: Write failing tests**

```ts
describe('traces', () => {
  test('calls fall into fixed two-second buckets, newest last', () => {
    expect(buckets([0, 100, 2500, 9000], 9999, 5)).toEqual([0, 1, 0, 0, 1].slice(0, 5)) // buckets 2..10 s: [2,4) [4,6) [6,8) [8,10)
    expect(buckets([], 0, 3)).toEqual([0, 0, 0])
    expect(record([0, 70_000], 70_500)).toEqual([70_000, 70_500]) // older than 64 s goes
  })
  test('braille draws bars on a flat baseline, two buckets a cell', () => {
    expect(braille([0, 0])).toEqual(['⣀'])
    expect(braille([4, 4])).toEqual(['⣿'])
    expect(braille([1, 0])[0]!.codePointAt(0)).toBe(0x2800 | 0x40 | 0x04 | 0x80)
    expect(braille([0, 0], 2)).toEqual(['⠀', '⣀'])
  })
  test('raster cells are base64 of little-endian code point, colour and background per cell', () => {
    const b = atob(rasterCells(['⣀'], 0x123456))
    const u = (i: number) => b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8) | (b.charCodeAt(i + 2) << 16) | (b.charCodeAt(i + 3) << 24) >>> 0
    expect([u(0), u(4), u(8)]).toEqual([0x28c0, 0x123456, 0x01000000])
  })
})
```
(Exact bucket expectations are fixed when written, against the boundary rule `end = (floor(now/2000)+1)·2000`.)

- [ ] **Step 2: Run, expect FAIL** with `claude plugin test plugins/redhelm` (module missing).
- [ ] **Step 3: Implement trace.ts:** bucket math, braille masks (left 0x40, 0x04, 0x02, 0x01 bottom to top; right 0x80, 0x20, 0x10, 0x08), and a manual LE byte packing plus base64, with no reliance on `btoa` or `toBase64` in the hooks environment.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `Traces: buckets, braille and Raster cells`.

### Task 2: `hooks/labels.ts`

**Files:**
- Create: `plugins/redhelm/hooks/labels.ts`
- Test: `describe('labels')`

**Interfaces:**
- Consumes: `Agent` from types.
- Produces:
  - `type Complete = (ask: { system: string; prompt: string }) => Promise<string | undefined>`.
  - `HEADLINE_EVERY_MS = 20_000`.
  - `headlineInput(a: Agent): string` uses the task (300), the last 5 steps and the latest words (600).
  - `titleInput(text: string): string`.
  - `clean(text, words, keepQuestion?): string | undefined`.
  - `hash(s): string` (FNV-1a).
  - `labeler(): { ask(complete, kind: 'headline' | 'title', id, input, at): Promise<string | undefined> }`.

- [ ] **Step 1: Failing tests**

```ts
describe('labels', () => {
  test('a reply becomes a short clean label, or nothing', () => {
    expect(clean('"Rewriting the setup guide."', 6)).toBe('Rewriting the setup guide')
    expect(clean('Headline: Fixing the flaky auth tests now and later too', 6)).toBe('Fixing the flaky auth tests now')
    expect(clean("I can't help with that.", 6)).toBeUndefined()
    expect(clean('', 6)).toBeUndefined()
    expect(clean('Add a README section?\nMore text', 8, true)).toBe('Add a README section?')
  })
  test('one call per input, one at a time, a headline per agent at most every 20 s', async () => {
    const calls: string[] = []
    let release = () => {}
    const slow: Complete = async ask => { calls.push(ask.prompt); await new Promise<void>(r => (release = r)); return 'Writing the guide' }
    const l = labeler()
    const first = l.ask(slow, 'headline', 'a1', 'x', 0)
    expect(await l.ask(slow, 'headline', 'a2', 'y', 0)).toBeUndefined() // busy
    release(); expect(await first).toBe('Writing the guide')
    expect(await l.ask(slow, 'headline', 'a1', 'x', 1)).toBe('Writing the guide') // cached, no call
    expect(await l.ask(slow, 'headline', 'a1', 'z', 5_000)).toBeUndefined() // too soon
    expect(calls).toEqual(['x'])
  })
  test('a failure leaves the plain words and is retried after the rate window', async () => {
    let n = 0
    const flaky: Complete = async () => (++n === 1 ? undefined : 'Running the tests')
    const l = labeler()
    expect(await l.ask(flaky, 'headline', 'a1', 'x', 0)).toBeUndefined()
    expect(await l.ask(flaky, 'headline', 'a1', 'x', 21_000)).toBe('Running the tests')
  })
})
```
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Caching: a cleaned label or a cleaned-empty reply (`null`) is cached, but a transport failure (`undefined` text) is not.
  - The rate limit applies per `kind:id`.
  - LRU of 200.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `Labels: prompts, cleaning, cache and rate limit`.

### Task 3: Words and states in `model.ts`, settings and types

**Files:**
- Modify:
  - `hooks/model.ts`: add `State`, `stateOf`, `age`, `plainHeadline`, `headlineOf` and `firstAsk`; Settings gains `motion` and `labels`; remove `doing`.
  - `types/index.d.ts`: `Agent.headline?: string`, `Message.title?: string`.
  - `.claude-plugin/plugin.json`: userConfig `motion` and `labels`.
- Test: update `settings()` expectations; replace the `doing` test.

**Interfaces:**
- Produces:
  - `type State = 'working' | 'quiet' | 'waiting' | 'asks' | 'done' | 'failed'`.
  - `stateOf(a, now, asks?)`.
  - `age(ms)` returns `now`, `12s`, `3m`, `1h` or `2d`.
  - `plainHeadline(a, now)`.
  - `headlineOf(a, now)` uses Haiku's headline only while working.
  - `firstAsk(text, size = 90)` returns the first sentence ending in `?`, else the first sentence.

- [ ] **Step 1: Tests:**
  - quiet after 15 minutes, `Waiting for Echo`, `Getting started`, the answer excerpt for a finished agent
  - `age` boundaries
  - `firstAsk('The diff is written. Should I forward it?')` gives `Should I forward it?`
  - settings defaults include `motion: 'on', labels: 'haiku'`
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**
- [ ] **Step 5: Commit** `Model: states, ages and plain headlines; motion and labels settings`.

### Task 4: Rebuild `hooks/view.tsx`

**Files:**
- Modify: `hooks/view.tsx` (rewrite of the list, card, header, sheet, wide and alert parts; workflows, setup and update keep their logic)
- Test: update the view-facing tests; add new ones.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `View` gains `traces: Record<string, readonly number[]>`, `at: number`, `motion: boolean` and `mount?: (key: string, spec: TraceSpec) => void`.
  - `type TraceSpec = { agentId: string; cells: number; rows: number; fg: number }`.
  - `Els` gains optional `Raster` and `Svg`.
  - Keys kept for behaviour: `sel-<id>`, `compose-<id>`, `stop-<id>`, `dismiss-<id>`, `more-<id>`, `back`, `toggle-done`, `cancel-compose`, `update`, `setup-*`, `brief-more`.
  - New keys: `row-<id>`, `ask-<id>`, `actions-<id>`, `trace-<id>`, `trace-big-<id>`, `open-<id>`.

**Components:**
- `Header`: brand plus count Texts (`⚑ n` warning, `▶ n`, `✓ n` success, `✕ n` error; zeros left out). With no agents it shows `No agents yet`.
- `Trace`:
  - Terminal with motion on: a `Raster` keyed `trace-<id>`, registered through `v.mount`.
  - Terminal with motion off: braille `Text` rows.
  - Other surfaces: `Svg`.
  - Colour: default while moving, a subtle grey when flat.
- `Row`:
  - A keyed `row-<id>` Box (hover tint) on the grid.
  - Second line: the headline, subtle and truncated.
  - Live, and not being written to: an absolute `actions-<id>` Box at `right 2, top 0`, drawn `display:'none'` with `hover:{display:'flex'}`, holding Message (`compose-<id>`) and Stop (`stop-<id>`).
- `QuestionCard`:
  - A keyed `ask-<id>` Box on the card surface, with a 1-column edge Box whose `backgroundColor` is warning, or subtle on pulse frames (`v.motion && v.now - ask.at < 1500 && floor((v.now - ask.at)/250) % 2 === 1`).
  - Lines: `⚑ name … asks · age`; the title (`ask.title ?? firstAsk(ask.text)`), bold; then Reply, Dismiss when ended, and `Details ›`.
- `Finished`: one line, `Finished · n` with Show/Hide. Rows with `✓`/`✕`, no trace (an empty slot keeps alignment), time since ended, and the answer as the headline.
- `Sheet` (`back` kept):
  - The identity line, then actions, then the full question.
  - The big trace: 16 cells, 4 rows when columns ≥ 40, else 2; hidden for ended agents.
  - Fields: Task (2 lines plus More), Steps (6), Files, Model (+`◷`), Context, Last said.
- `Wide`: one line per agent with the same parts, `NeedsLine` with the title, and the header counts.
- `Alert`: `⚑ name  title  Open REDhelm`.
- `ModelNotice` and `Overlaps`: glyph and edge, no Badge.
- Avatars, `Badge` and `AVATARS` are deleted.

- [ ] **Step 1: Update and add tests:**
  - every surface: `sel-a1` present; headline `Edit setup.md`; Raster `trace-a1` on terminal and Svg on desktop
  - header `▶ 1`; question card `ask-a1` with title and no full text, while the sheet has the full text
  - `actions-a1` with `display: 'none'`
  - narrow 22: `sel-a1` and the time present, and `trace-a1` `columns` 4
  - motion off: no Raster
  - copy updates (`Task` for `Asked to`, `⚑ 1` for `1 needs you`, `✓ 1` for `1 finished`, `Waiting for Echo`, `Getting started`)
- [ ] **Step 2: FAIL. Step 3: rewrite view.tsx. Step 4: PASS plus tsc.**
- [ ] **Step 5: Commit** `View: live trace rows, question cards, glyph header, hover actions`.

### Task 5: Wiring in `register.tsx`

**Files:**
- Modify: `hooks/register.tsx`
- Test: integration tests

**Steps in code:**
- **Module state:** `traces: Map<string, number[]>`, `sites: Map<requestId, Map<key, TraceSpec & { cells?: string }>>`, `visible: boolean`, `labels = labeler()`, `stopLabels: AbortController`, `framing: boolean`.
- **`tool.call` (agent):** `traces.set(id, record(traces.get(id) ?? [], now))`.
- **`view($)`:** `traces: Object.fromEntries(traces)`, `at: await $.clock.now()`, `motion: cfg.motion === 'on'`.
  - The Pane and band render hooks set `sites.set(e.requestId, new Map())` and pass `mount` into the view.
- **`tick($)`, every 1000 ms:**
  - `visible = await onScreen($)` (pane shown, or bottom placement not folded).
  - While visible and an agent is live or a question is open, it writes the `now` atom.
  - With `labels === 'haiku'` it runs `labelAll($)`: question titles first, then headlines of working agents. Each goes through `labels.ask(askHaiku($), …)` and is written only when it changed.
  - `sync` no longer writes `now`.
- **`frame($)`, every 125 ms:** skipped unless visible, motion is on and no frame is running.
  - For each mounted key it computes `traceRaster`. When the result differs from the last, it calls `$.ui.blit({ requestId, key, cells })`; a `deny` deletes the key.
- **`received` (question):** with motion on, `$.clock.after(k·250)` for k = 1..6 writes `now` (the pulse).
- **Session lifecycle:** `session.start` resets traces, sites and the abort controller and starts the two timers; `session.end` aborts label calls.
- **`askHaiku($)`:** `$.model.complete({ model: 'haiku', effort: 'low', maxTokens: 30, timeoutMs: 6000, system, prompt }, { signal })` returns `r.isAnswered ? r.text : undefined`.

- [ ] **Step 1: Tests:**
  - Shown pane (`engine(on, true, { shown: true })`) plus a `model.complete` stand-in: the headline appears after `clock.advance(1_100)`, and the question title appears on its card.
  - `labels: 'plain'`: no model call.
  - Frame: a blit is called for `trace-a1` after a tool call while shown, and a denied blit is not retried.
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS plus tsc.**
- [ ] **Step 5: Commit** `Wire traces, frames, ticker and Haiku labels`.

### Task 6: Live verification, docs and release

- [ ] Stage (`scratchpad/stage`, Claude Code 2.1.309, `CLAUDE_CODE_NO_FLICKER=1`) with a real agent, in each layout:
  - the 48-column sidebar
  - the 22-column sidebar (narrow terminal)
  - the 120-column bottom bar
  - light and dark
  - classic
- [ ] Screenshots, then the squint, strip and five-second tests. Fix what fails and re-render.
- [ ] Confirm the trace moves, hover reveals actions, and the Haiku headline lands.
- [ ] README: rewrite "What it does" for rows, traces and labels; add both settings and the model-call note under Privacy (labels send agent task and step text to Claude Code's small model).
- [ ] Version 0.6.0. Refresh the screenshots with no usage limits, time zone or home paths in them.
- [ ] Privacy scan over files and `git log -p`, then commit and push.
