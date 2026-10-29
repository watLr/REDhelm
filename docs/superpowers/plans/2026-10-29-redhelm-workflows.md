# REDhelm Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save how a session's work was led and staffed (lead skills or a read playbook, roles or a lineup, tools and skills, copied project agent types) into REDhelm's library, and hand it back to Claude from the sidebar's `Load → Run`.

**Architecture:** Two new pure modules. `hooks/workflows.ts` turns the session's messages and REDhelm's agent records into a `Draft`: stretches, lead, stages, roles, teams, shared brief parts, the lead trace, and the checks on the model's reading. `hooks/library.ts` holds what happens to a draft after that: edit ops, the saved file format, the plan text Claude gets, and parsing agent files. `register.tsx` wires them to the sidebar, the prompt box (`✎` and `▶` modes beside Reply's `→`), `$.model.complete`, `$.fs` and `$.agent.register`. `view.tsx` draws the section and the sheet.

**Tech Stack:** Claude Code function-hook mod API (2.1.311); `claude plugin test`; `npx -y -p typescript@5.6 tsc`.

**Spec:** `docs/superpowers/specs/2026-10-29-redhelm-workflows-design.md`

## Global Constraints

- **Build in a worktree** of branch `workflows`, never in the main checkout. The main checkout is symlinked into the owner's live sessions, so a half-built change there loads into their work.
- Library: `~/.claude/redhelm/workflows/<id>.json`, `version: 1`.
- Lengths: name ≤ 40, purpose ≤ 90, label ≤ 16, role line ≤ 90 (a plan decision; the spec says "one line"), practice `when` and `do` ≤ 120, at most 8 practices.
- Shared brief parts: in ≥ 2 briefs and in ≥ half of them, at most 3, each ≤ 1,500 characters.
- Reading: `{ model: 'sonnet', effort: 'low', maxTokens: 1500, timeoutMs: 30_000 }`, one call per Save. Input: your prompts at their first 300 characters, a script at its first 6,000, each brief at its first 300.
- Edit: `{ model: 'sonnet', effort: 'low', maxTokens: 1200, timeoutMs: 30_000 }`. The model returns ops only.
- Both calls are counted in the same tallies as labels, which `/redhelm models` shows.
- Lead trace: at most 200 events (a plan decision). When there are more, keep the first 20 and the last 180, with `… <k> earlier steps left out` between them.
- Marks: `✎ Workflow: `, matched by `/^✎ Workflow: ([\s\S]*)$/`, and `▶ <name>: `, matched against the workflow Run chose (kept in state).
- Run text: ``Run my saved REDhelm workflow "<name>".``, plus ` My notes for this run: <notes>` when there are notes.
- Registered types are `redhelm:<name>`.
  - Carried: `description`, the body as `prompt`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `background`, `isolation`.
  - Never registered: `hooks`, `mcpServers`, `permissionMode`.
- Fail open: gating hooks end in `.catch(($, e, next) => next(e))`, and bookkeeping runs inside `quietly`.
- One mode owns the prompt box at a time (`→`, `✎`, `▶`). Each hands `draftKept` on.
- Never saved: commands, file lists, agent answers, the conversation, the lead trace and the evidence. `project` is the folder name; `projectKey` is `hash(root)` from `labels.ts`.
- **Plan decision:** the engine has no file delete. Delete writes an empty file, which `listed` skips without counting it.
- Fixtures are made-up projects and text only. Commits use the noreply identity with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer. Run a privacy scan of files and `git log -p` before any push.
- Every task ends with:
  - `claude plugin test plugins/redhelm`: passes, no failures;
  - `npx -y -p typescript@5.6 tsc -p plugins/redhelm`: exit 0, no output.

## Review Focus

1. **An Agent call that failed or was refused** started nothing. It is not read as an agent, a role or a trace "started" event. *Test:* Task 3, "a failed or refused Agent call is not read".
2. **A very long stretch** (a REDManager build with hundreds of steps). The trace keeps the cap, so the request stays small. *Test:* Task 4, "a long stretch keeps the first 20 and the last 180 steps".
3. **A name with a colon, or with no ASCII letters** (`Build: phase two`, `Тесты ✓`). Run still matches it, and the file gets an id. *Tests:* Task 7, "slugs"; Task 9, "a name with a colon runs".
4. **The first Load, before any workflow was saved.** The folder does not exist yet. Load says `No saved workflows yet`, with no error. *Test:* Task 9, "an empty library says so".
5. **A late reading.** You press Earlier or Cancel before the model's reading lands. The late answer never overwrites the newer draft or reopens a closed sheet. *Test:* Task 8, "a reading that lands late is dropped".

---

### Task 1: Probe what the types could not answer (the lead runs this; it needs an interactive session)

The answers decide how Tasks 3, 4, 8 and 9 recognise prompts, `/` skills, run agents and agent files.

**Files:**
- Create (throwaway, outside the repo): `<scratchpad>/wfprobe/.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`.
- Create (sample project, made up): `/Users/Shared/notes-app/.claude/agents/team/probe-local.md` (frontmatter `name: probe-local`; a subfolder on purpose) and `/Users/Shared/notes-app/.claude/skills/probe-skill/SKILL.md` ("Reply `probe skill loaded`.").
- Modify: this plan's **Findings** section, at the end.

- [ ] **Step 1: Write the probe mod.**
  - `/wfprobe` writes `$.session.messages()` and each agent's messages to `<scratchpad>/wfprobe/out/`.
  - An `agent.spawn` hook appends `{ provider, workflow, isTeammate, parentAgentId, description, prompt: first 80 characters }` to `out/spawns.jsonl`.
  - A `prompt.submit` hook adds context to any prompt starting `probe-context:`: `context: ['The code word is HELM-7.']`.
  - Prompts starting `probe-roles:` or `probe-lineup:` get, as `context`, a hand-written plan in the shape of spec §8.
  - `/wfregister` calls `$.agent.register({ name: 'probe-reviewer', description: 'Reviews one file', prompt: 'You review one file and reply in one line.' })`.
- [ ] **Step 2: Run the session.** In `/Users/Shared/notes-app`, start `claude --plugin-dir <scratchpad>/wfprobe --model haiku`. Never `/model`. Then, in order:
  1. `/probe-skill`, then "load the probe-skill skill with the Skill tool".
  2. "Start two background agents at once (one reads notes.js, one reads store.js); when both finish, start one more that lists bugs."
  3. "Start a probe-local agent to read store.js."
  4. "Run a Workflow script with two `agent()` calls that each read one file." This explicit ask is the Workflow tool's opt-in.
  5. `probe-context: what is the code word?`
  6. `/wfregister`, then in the next prompt: "Start a wfprobe:probe-reviewer agent on store.js."
  7. `probe-roles: Run my saved REDhelm workflow "Probe".` and `probe-lineup: Run my saved REDhelm workflow "Probe".`
  8. `/wfprobe`.
- [ ] **Step 3: Record the answers.** Write them under **Findings**, numbered as the spec's "To check first" list. For each, note the observed shape (with content replaced by made-up text) and the rule it gives:
  - 1: what `isPrompt` must reject;
  - 2: how `leadSkills` sees a `/` skill;
  - 3: whether `agentId` is on a background agent's tool use;
  - 4: whether context reached the model;
  - 5: what a run agent's `description` and placeholder brief are;
  - 6: whether each plan shape was followed;
  - 7: the agent file lookup rule and the `provider` values;
  - 8: whether a type registered one turn earlier was dispatched.
- [ ] **Step 4: Fix the fixtures.** Update the `notice` and `slash` fixture helpers in Task 3 Step 1 to the shapes seen. Any finding that contradicts a later task's rule gets a one-line amendment in that task.
- [ ] **Step 5: Commit** the plan update: `git commit -m "Workflows plan: what the probe found"`.

### Task 2: What REDhelm records, and workflow agents that ended early

**Files:**
- Modify: `plugins/redhelm/types/index.d.ts` (`Agent`).
- Modify: `plugins/redhelm/hooks/register.tsx`: `agent.spawn` patch (~line 1013), `tool.call` (~1055), `sync` grace loop (~175), `blank` (60).
- Test: `plugins/redhelm/tests/redhelm.test.tsx`, a new `describe('workflow records')`.

**Interfaces:**
- Produces: `Agent` gains `run?: string`, `parent?: string`, `teammate?: boolean`, `origin?: string` (`e.provider.plugin`, added after Task 1), `tools?: Record<string, number>` and `skills?: string[]`. Old records read as missing, so readers default to `{}`, `[]` and `false`.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('workflow records', () => {
  const agents = async ($: any) => (await $.state.get({ plugin: 'redhelm', key: 'agents' })).value
  test('an agent of a built-in workflow run is still working past the 20-second grace', async ($: any, on: any) => {
    on('turn.complete', () => ({ text: '' }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Probe the parser', subagentType: 'general-purpose', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
    await clock.advance(25_000)
    expect((await agents($)).a1.status).toBe('running')
    expect((await agents($)).a1.run).toBe('wf_1')
    await $.turn.complete({ answer: 'done', durationMs: 9000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    expect((await agents($)).a1.status).toBe('completed')
  })
  test('tools are counted per agent, MCP tools by server, skills once each in order', async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    for (const call of [{ tool: 'Read', file_path: 'a' }, { tool: 'Read', file_path: 'b' }, { tool: 'mcp__notes__search', q: 'x' },
      { tool: 'Skill', skill: 'tdd' }, { tool: 'Skill', skill: 'tdd' }, { tool: 'Skill', skill: 'brainstorming' }])
      await $.tool.call({ ...call, agentId: 'a1' } as any)
    const a = (await agents($)).a1
    expect(a.tools).toEqual({ Read: 2, 'mcp:notes': 1, Skill: 3 })
    expect(a.skills).toEqual(['tdd', 'brainstorming'])
  })
  test('a spawn records its parent and whether it is a teammate', async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Scout', subagentType: 'Explore', parentAgentId: 'lead1', isTeammate: true } as any)
    expect((await agents($)).a1).toMatchObject({ parent: 'lead1', teammate: true })
  })
})
```

- [ ] **Step 2: Run the tests.** `claude plugin test plugins/redhelm` is expected to FAIL: `run` is undefined and the status is `completed`.
- [ ] **Step 3: Implement.**
  - The spawn patch adds `run: e.workflow?.runId`, `parent: e.parentAgentId` and `teammate: e.isTeammate === true`.
  - Inside `quietly`, the `tool.call` hook increments `tools[key]` for every call of an agent that `ourAgent` knows. The key is `mcp:<server>` for `mcp__<server>__…` and the tool name otherwise. For `Skill`, it appends `e.skill` to `skills` when new.
  - The grace loop skips agents with `run`.
  - `turn.complete` already ends an agent; confirm a run agent takes that path.
- [ ] **Step 4: Run the tests and the typecheck.** Both pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: tools, skills, parent and run per agent; workflow agents no longer end at 20 seconds"`.

### Task 3: Reading a session, part 1: stretches, lead skills and the lineup

**Files:**
- Create: `plugins/redhelm/hooks/workflows.ts`.
- Modify: `plugins/redhelm/types/index.d.ts` (the saved types, verbatim from spec §1: `Practice`, `Lead`, `SavedRole`, `SavedAgent`, `SavedType`, `SavedWorkflow`, plus `Draft`).
- Test: `plugins/redhelm/tests/redhelm.test.tsx`, a new `describe('reading a session')`, plus the fixture helpers below.

**Interfaces:**
- Produces, in `types/index.d.ts`:

```ts
export type Draft = Omit<SavedWorkflow, 'version' | 'id' | 'savedAt'> & {
  /** Lineup repeats folded away: "<label> ran <times> times · saved once". */
  folded: { label: string; times: number }[]
  /** Project types whose file was found but could not be read: "type not copied". */
  notCopied: string[]
  /** Per practice, the trace lines it cites. For the sheet; never saved. */
  evidence: string[][]
  read: 'pending' | 'done' | 'failed'
  /** How many times Earlier widened the stretch, and whether it can again. */
  back: number
  more: boolean
}
```

  A draft carries **both** `roles` and `stages`, so `Save as` switches without reading again. `toSaved` (Task 7) empties the form not chosen.
- Produces, in `workflows.ts`:

```ts
export type Use = { tool: string; input: Record<string, unknown>; isError?: boolean; agentId?: string; result?: unknown }
export type Msg = { role: 'user' | 'assistant'; text: string; toolUses: readonly Use[]; toolResults?: readonly unknown[] }
export type AgentInput = { description: string; prompt: string; subagent_type?: string; model?: string; effort?: string; name?: string; run_in_background?: boolean; isolation?: 'worktree' | 'remote' }
/** Message indexes, `to` exclusive; `led`: a lead skill loaded before its first agent. */
export type Stretch = { from: number; to: number; led: boolean }
/** One agent the lead started: the message it was started in, and the call. */
export type Call = { at: number; agentId: string; input: AgentInput }
export function isPrompt(m: Msg): boolean
export function stretches(msgs: readonly Msg[]): Stretch[]           // oldest first
export function widen(list: readonly Stretch[], back: number): Stretch // the latest, plus `back` before it
export function leadSkills(msgs: readonly Msg[], s: Stretch): string[]
export function agentCalls(msgs: readonly Msg[], s: Stretch): Call[]
export function stagesOf(calls: readonly Call[], records: Record<string, Agent>): Call[][]
export function foldRepeats(stages: readonly Call[][]): { stages: Call[][]; folded: { label: string; times: number }[] }
export function defaultForm(msgs: readonly Msg[], s: Stretch): 'roles' | 'lineup'
```

- [ ] **Step 1: Write the fixture helpers and the failing tests**

```tsx
import { agentCalls, defaultForm, foldRepeats, isPrompt, leadSkills, stagesOf, stretches, widen, type Msg } from '../hooks/workflows'
const you = (text: string): Msg => ({ role: 'user', text, toolUses: [] })
const lead = (...toolUses: any[]): Msg => ({ role: 'assistant', text: '', toolUses })
const call = (agentId: string, input: Record<string, unknown> = {}) =>
  ({ tool: 'Agent', agentId, input: { description: 'Write the docs', prompt: 'Write docs/api.md', subagent_type: 'general-purpose', ...input } })
const skill = (name: string) => ({ tool: 'Skill', input: { skill: name } })
// Shapes seen in Task 1 (findings 1 and 2).
const notice = (text: string): Msg => ({ role: 'user', text: `<task-notification> <task-id>a1</task-id> ${text} </task-notification>`, toolUses: [] })
const slash = (name: string): Msg => ({ role: 'user', text: `<command-message>${name}</command-message> <command-name>/${name}</command-name>`, toolUses: [] })
const result = (): Msg => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'Async agent launched successfully.' }] })

describe('reading a session', () => {
  test('stretches split at your prompts that started agents; a skill that led keeps the rest whole', () => {
    const msgs = [you('Write the docs'), lead(call('a1')), you('thanks'), you('Now test it'), lead(call('a2', { description: 'Add tests' }))]
    expect(stretches(msgs)).toEqual([{ from: 0, to: 3, led: false }, { from: 3, to: 5, led: false }])
    expect(widen(stretches(msgs), 1)).toEqual({ from: 0, to: 5, led: false })
    const led = [you('Plan the build'), lead(skill('redmanager')), lead(call('a1')), you('go on'), lead(call('a2'))]
    expect(stretches(led)).toEqual([{ from: 0, to: 5, led: true }])
  })
  test('notifications are not your prompts', () => {
    expect(isPrompt(notice('agent a1 finished'))).toBe(false)
    expect(isPrompt(result())).toBe(false)
    expect(isPrompt(you('[Request interrupted by user]'))).toBe(false)
    expect(isPrompt(slash('probe-skill'))).toBe(true)
    expect(isPrompt(you('hi'))).toBe(true)
    expect(stretches([you('go'), lead(call('a1', { run_in_background: true })), notice('done'), lead(call('a2'))])).toHaveLength(1)
  })
  test('lead skills come from the Skill tool and from / commands, once each, in order', () => {
    const msgs = [slash('redmanager'), lead(skill('brainstorming'), skill('redmanager')), lead(call('a1'))]
    expect(leadSkills(msgs, { from: 0, to: 3, led: true })).toEqual(['redmanager', 'brainstorming'])
    // A / command the model never answered (a built-in like /effort) is not a skill.
    expect(leadSkills([slash('effort'), you('go'), lead(call('a1'))], { from: 0, to: 3, led: false })).toEqual([])
  })
  test('one lead message is a run of assistant messages; a tool result between two calls splits it', () => {
    const msgs = [you('go'), lead(call('a1')), lead(call('a2', { description: 'Add tests' })), result(), result(), lead(call('a3', { description: 'Review' }))]
    expect(stagesOf(agentCalls(msgs, { from: 0, to: 6, led: false }), {}).map(st => st.map(c => c.agentId))).toEqual([['a1', 'a2'], ['a3']])
  })
  test('one lead message is one stage; started while another runs joins it; started after all ended opens the next', () => {
    const records = { a1: agent({ id: 'a1', startedAt: 0, endedAt: 50 }), a2: agent({ id: 'a2', startedAt: 0, endedAt: 90 }),
      a3: agent({ id: 'a3', startedAt: 60, endedAt: 99 }), a4: agent({ id: 'a4', startedAt: 100 }) }
    const msgs = [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' })), lead(call('a3', { description: 'Check types' })), lead(call('a4', { description: 'Review' }))]
    const s = { from: 0, to: 4, led: false }
    expect(stagesOf(agentCalls(msgs, s), records).map(st => st.map(c => c.agentId))).toEqual([['a1', 'a2', 'a3'], ['a4']])
    expect(stagesOf(agentCalls(msgs, s), {}).map(st => st.map(c => c.agentId))).toEqual([['a1', 'a2'], ['a3'], ['a4']])
  })
  test('a failed or refused Agent call is not read', () => {
    const msgs = [you('go'), lead({ ...call('a9'), isError: true }, { ...call(''), agentId: undefined })]
    expect(agentCalls(msgs, { from: 0, to: 2, led: false })).toEqual([])
  })
  test('a repeat in a later stage folds with its count; two alike in one stage are peers', () => {
    const impl = (id: string) => call(id, { description: 'Build the slice', name: 'impl' })
    const rev = (id: string) => call(id, { description: 'Review the slice', subagent_type: 'reviewer' })
    const msgs = [you('go'), lead(impl('a1')), lead(rev('a2')), lead(impl('a3')), lead(rev('a4')), lead(call('a5', { subagent_type: 'Explore' }), call('a6', { subagent_type: 'Explore' }))]
    const st = stagesOf(agentCalls(msgs, { from: 0, to: 6, led: false }), {})
    const r = foldRepeats(st)
    expect(r.stages.map(x => x.map(c => c.agentId))).toEqual([['a1'], ['a2'], ['a5', 'a6']])
    expect(r.folded).toEqual([{ label: 'Build the slice', times: 2 }, { label: 'Review the slice', times: 2 }])
  })
  test('the default form is Roles when a skill loaded before the first agent', () => {
    expect(defaultForm([you('go'), lead(skill('redmanager')), lead(call('a1'))], { from: 0, to: 3, led: true })).toBe('roles')
    expect(defaultForm([you('go'), lead(call('a1')), lead(skill('status-board'))], { from: 0, to: 3, led: false })).toBe('lineup')
  })
})
```

- [ ] **Step 2: Run the tests.** Expected to FAIL: the module `../hooks/workflows` is missing.
- [ ] **Step 3: Implement the functions above in `workflows.ts`.** Rules the tests do not fully pin:
  - An agent is running at `t` when `startedAt ≤ t < (endedAt ?? ∞)`.
  - A stretch boundary is a prompt (`isPrompt`) followed by at least one `agentCalls` entry before the next such prompt. A `led` stretch absorbs every later one.
  - A repeat is the same `subagent_type` plus the same `name`, or the same `subagent_type` plus the same `description`, as a call in an *earlier* stage. `folded.label` is the description.
  - A missing `subagent_type` reads as `general-purpose`.
  - **A lead message** is a run of consecutive assistant messages with no user message between them. Claude Code stores each content block as its own message, and a tool result is a user message (Task 1, finding 1).
  - **`isPrompt`:** a user message with text, no `toolResults`, and text that does not start with `<task-notification>`, `<local-command`, `<system-reminder>` or `[Request interrupted`. A `<command-message>` text is a prompt.
  - **A `/` skill** is a prompt whose text holds `<command-name>/<name></command-name>` and whose next message is an assistant message (Task 1, finding 2).
- [ ] **Step 4: Run the tests and the typecheck.** Both pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: read a session's stretches, lead skills and lineup"`.

### Task 4: Reading a session, part 2: roles, teams, shared parts, the trace, the draft

**Files:**
- Modify: `plugins/redhelm/hooks/workflows.ts`.
- Test: `describe('reading a session')`, continued.

**Interfaces:**
- Consumes: Task 3's `Msg`, `Call`, `Stretch`, `stagesOf`, `foldRepeats`, `leadSkills` and `defaultForm`; `hash` from `labels.ts`.
- Produces:

```ts
export type TraceEvent = { n: number; line: string; yours?: string }  // `yours`: your prompt's text, for the numbers check
export function runCalls(msgs: readonly Msg[], s: Stretch, records: Record<string, Agent>): Call[] // agents of Workflow runs in s, from records
export function groupRoles(calls: readonly Call[], records: Record<string, Agent>): SavedRole[]
export function teamOf(own: readonly Msg[] | undefined, records: Record<string, Agent>): SavedRole[] | undefined
export function sharedParts(briefs: readonly string[]): string[]
export function command(cmd: string): string                            // program and subcommand only
export function leadTrace(msgs: readonly Msg[], s: Stretch): TraceEvent[]
export type ReadInput = { msgs: readonly Msg[]; records: Record<string, Agent>; teams: Record<string, readonly Msg[]>;
  list: readonly Stretch[]; back: number; root: string; lead: { model?: string; effort?: string } }
export function readWorkflow(input: ReadInput): Draft | undefined       // undefined: no agent work in the stretch
```

- [ ] **Step 1: Write the failing tests**

```tsx
test('roles group by type, model, effort and isolation; ran counts them; tools sum', () => {
  const records = { a1: agent({ id: 'a1', tools: { Edit: 3 } }), a2: agent({ id: 'a2', tools: { Edit: 1, Bash: 2 }, skills: ['tdd'] }) }
  const msgs = [you('go'), lead(call('a1', { model: 'opus', isolation: 'worktree' }), call('a2', { model: 'opus', isolation: 'worktree' }), call('a3', { subagent_type: 'reviewer', model: 'sonnet' }))]
  const roles = groupRoles(agentCalls(msgs, { from: 0, to: 2, led: false }), records)
  expect(roles.map(r => [r.type, r.model, r.isolation, r.ran])).toEqual([['general-purpose', 'opus', 'worktree', 2], ['reviewer', 'sonnet', undefined, 1]])
  expect(roles[0]).toMatchObject({ tools: { Edit: 4, Bash: 2 }, skills: ['tdd'], label: 'general-purpose' })
})
test("an agent's own agents become its team, one level down", () => {
  const team = teamOf([lead(call('b1', { subagent_type: 'Explore' }), call('b2', { subagent_type: 'Explore' }))], {})
  expect(team?.map(r => [r.type, r.ran])).toEqual([['Explore', 2]])
  expect(teamOf([], {})).toBeUndefined()
})
test('a paragraph most briefs share is kept verbatim; one in a single brief is not', () => {
  const report = 'STATUS: DONE | BLOCKED\nCHANGED: <files>'
  expect(sharedParts([`Write the docs.\n\n${report}`, `Add tests.\n\n${report}`, 'Review it.'])).toEqual([report])
  expect(sharedParts(['one\n\nonly here', 'two'])).toEqual([])
  expect(sharedParts([`a\n\n${'x'.repeat(1501)}`, `b\n\n${'x'.repeat(1501)}`])).toEqual([])
})
test('commands keep the program and subcommand only', () => {
  expect(command('cd app && FOO=1 npm test -- --watch')).toBe('npm test')
  expect(command('git commit -m "token=abc"')).toBe('git commit')
  expect(command('ls -la /p')).toBe('ls')
})
test('the lead trace is one numbered line a step', () => {
  const msgs = [you('Build the store'), lead(skill('brainstorming')), lead(call('a1', { model: 'opus', isolation: 'worktree' }), call('a2', { model: 'opus', isolation: 'worktree' })),
    lead({ tool: 'Bash', input: { command: 'npm test' } }, { tool: 'SendMessage', input: { to: 'a1', message: 'fix' } }),
    lead({ tool: 'AskUserQuestion', input: {} }, { tool: 'Bash', input: { command: 'git commit -m x' } })]
  expect(leadTrace(msgs, { from: 0, to: 5, led: false }).map(e => `#${e.n} ${e.line}`)).toEqual([
    '#1 you: "Build the store"', '#2 lead loaded skill brainstorming', '#3 lead started 2 × general-purpose · opus · worktree together',
    '#4 lead ran npm test', '#5 lead sent a message to an agent', '#6 lead asked you a question', '#7 lead ran git commit'])
})
test('a long stretch keeps the first 20 and the last 180 steps', () => {
  const msgs = [you('go'), ...Array.from({ length: 300 }, () => lead({ tool: 'Bash', input: { command: 'npm test' } }))]
  const t = leadTrace(msgs, { from: 0, to: msgs.length, led: false })
  expect(t).toHaveLength(201)
  expect(t[20]!.line).toBe('… 101 earlier steps left out')
})
test('readWorkflow fills both forms, the lead and the shared parts, and nothing read yet', () => {
  const d = readWorkflow({ msgs: [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' }))], records: {}, teams: {},
    list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p/notes-app', lead: { model: 'claude-opus-5-5' } })!
  expect(d).toMatchObject({ form: 'lineup', project: 'notes-app', read: 'pending', back: 0, more: false, lead: { skills: [], playbook: [], model: 'claude-opus-5-5' } })
  expect(d.stages[0]!.agents.map(a => a.label)).toEqual(['Write the docs', 'Add tests'])
  expect(d.roles).toHaveLength(1)
  expect(readWorkflow({ msgs: [you('hi')], records: {}, teams: {}, list: [], back: 0, root: '/p', lead: {} })).toBeUndefined()
})
```

- [ ] **Step 2: Run the tests.** Expected to FAIL: the functions are undefined.
- [ ] **Step 3: Implement.** Rules the tests do not fully pin:
  - **Trace events:** `you: "<first 300>"`, `lead loaded skill <name>`, `lead started <k> × <type> · <model> · <isolation> together` (one line per setup in a message, leaving out missing parts; for a single agent, `lead started <type> · <model> · <isolation>`, with no count and no `together`), `lead started a workflow`, `lead ran <command>`, `lead sent a message to an agent`, `lead asked you a question`, `lead edited <k> files`, and `an agent finished` (from notices, the shape found in Task 1).
  - The marker counts the steps left out.
  - Labels fall back to the description, cut to 16 characters at a word boundary. `project` is the last part of `root`. `projectKey` is `hash(root)`, the same function as `library.ts`'s `projectKey`.
  - `runCalls` takes records whose `run` matches a Workflow tool use's `result.runId` in `s`, in `startedAt` order. Their type `workflow-subagent` is saved as `general-purpose`, because the Agent tool cannot start it (Task 1, finding 5). Their brief is REDhelm's record (its first 2,000 characters).
  - `types: []`; Task 8 fills them.
- [ ] **Step 4: Run the tests and the typecheck.** Both pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: roles, teams, shared brief parts and the lead trace"`.

### Task 5: The reading: request, checks, fallbacks

**Files:**
- Modify: `plugins/redhelm/hooks/workflows.ts`.
- Test: a new `describe('the reading')`.

**Interfaces:**
- Produces:

```ts
export const READING_CALL = { model: 'sonnet', effort: 'low', maxTokens: 1500, timeoutMs: 30_000 } as const
export const READING_SYSTEM: string
export function readingRequest(d: Draft, trace: readonly TraceEvent[], script?: string): { system: string; prompt: string }
export type Reading = { name?: string; purpose?: string; labels?: string[]; roles?: { label: string; role: string }[]; playbook: Practice[]; evidence: number[][] }
export function checkReading(text: string | undefined, trace: readonly TraceEvent[], d: Draft): Reading | undefined
export function applyReading(d: Draft, r: Reading | undefined, trace: readonly TraceEvent[]): Draft
```

`READING_SYSTEM`, exact copy:

```
You read how a lead coding agent ran a piece of work, from a numbered list of its steps, and describe it for a saved workflow. Reply with JSON only:
{"name": "≤ 40 characters", "purpose": "one line, ≤ 90 characters", "labels": ["≤ 16 characters, one per agent, in order"], "roles": [{"label": "≤ 16 characters", "role": "one line, ≤ 90 characters"}], "playbook": [{"when": "≤ 120 characters", "do": "≤ 120 characters", "evidence": [step numbers]}]}
The playbook is how the lead orchestrated: how it started agents, what it did when they reported, what the person asked for. At most 8 practices. Each says when it applies, so a lead can tell when it does not fit another problem. Never a fixed number of rounds, workers or attempts unless the person's own prompt said it. Leave out what a listed lead skill already does. No file names, paths or project names. Cite the steps each practice comes from.
```

- [ ] **Step 1: Write the failing tests**

```tsx
describe('the reading', () => {
  const d = () => readWorkflow({ msgs: [you('Build the store, 3 rounds of review at most'), lead(call('a1'), call('a2', { description: 'Add tests' }))],
    records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p/notes-app', lead: {} })!
  const trace = () => leadTrace([you('Build the store, 3 rounds of review at most'), lead(call('a1'), call('a2'))], { from: 0, to: 2, led: false })
  const reply = (over: any = {}) => JSON.stringify({ name: 'Docs and tests', purpose: 'Writes docs and tests together', labels: ['Docs', 'Tests'],
    roles: [{ label: 'Writer', role: 'Writes one part' }], playbook: [{ when: 'When parts are independent', do: 'start writers together', evidence: [2] }], ...over })
  test('a good reading fills names, roles and the playbook, with evidence lines', () => {
    const r = applyReading(d(), checkReading(reply(), trace(), d()), trace())
    expect(r).toMatchObject({ name: 'Docs and tests', read: 'done', roles: [{ label: 'Writer', role: 'Writes one part' }] })
    expect(r.stages[0]!.agents.map(a => a.label)).toEqual(['Docs', 'Tests'])
    expect(r.evidence).toEqual([['#2 lead started 2 × general-purpose together']])
  })
  test('a practice citing no real step is dropped', () => {
    expect(checkReading(reply({ playbook: [{ when: 'Always', do: 'x', evidence: [99] }, { when: 'Always', do: 'y', evidence: [] }] }), trace(), d())!.playbook).toEqual([])
  })
  test('a number survives only when a cited prompt of yours holds it', () => {
    const p = (evidence: number[]) => checkReading(reply({ playbook: [{ when: 'When a review fails', do: 'review again, 3 rounds at most', evidence }] }), trace(), d())!.playbook
    expect(p([2])).toEqual([])
    expect(p([1])).toHaveLength(1)
  })
  test('more than eight practices are cut to eight; lengths are enforced', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ when: `When step ${'abcdefghij'[i]}`, do: 'go', evidence: [2] }))
    expect(checkReading(reply({ playbook: many }), trace(), d())!.playbook).toHaveLength(8)
    expect(checkReading(reply({ name: 'x'.repeat(41) }), trace(), d())!.name).toBeUndefined()
    expect(checkReading(reply({ labels: ['Docs'] }), trace(), d())!.labels).toBeUndefined() // one per agent, or none
  })
  test('a failed reading falls back and says so; a fenced answer still parses', () => {
    const r = applyReading(d(), checkReading(undefined, trace(), d()), trace())
    expect(r).toMatchObject({ read: 'failed', name: 'Write the docs, Add tests', purpose: '', lead: { playbook: [] } })
    expect(checkReading('```json\n' + reply() + '\n```', trace(), d())?.name).toBe('Docs and tests')
  })
})
```

- [ ] **Step 2: Run the tests.** Expected to FAIL.
- [ ] **Step 3: Implement.**
  - `readingRequest` puts the trace (one `#n line` a row), the lead skills, the first 6,000 characters of the script, and each agent's or role's description plus the first 300 characters of its brief into `prompt`. It also states how many labels and roles are expected.
  - In `checkReading`, `yours` holds a cited prompt's text, and the numbers check is `/\d/`.
  - With no labels, `applyReading` keeps the fallback labels. A failed reading names the workflow from the first three labels, joined with `, ` and cut to 40 characters, and labels roles by type.
- [ ] **Step 4: Run the tests and the typecheck.** Both pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: the reading of the lead, checked against what was seen"`.

### Task 6: Edit ops

**Files:**
- Create: `plugins/redhelm/hooks/library.ts`.
- Test: a new `describe('editing a draft')`.

**Interfaces:**
- Produces: `Op` and `EditAnswer`, verbatim from spec §6, plus:

```ts
export const EDIT_CALL = { model: 'sonnet', effort: 'low', maxTokens: 1200, timeoutMs: 30_000 } as const
export const EDIT_SYSTEM: string   // "Change a saved workflow by operations only…": the Op union as JSON, `{ cannot }` when no op fits
export function editRequest(d: Draft, ask: string): { system: string; prompt: string }  // the draft as numbered items, practices and parts
export function parseEdit(text: string | undefined): EditAnswer | undefined
export function checkOps(d: Draft, ops: readonly Op[]): string | undefined   // the first reason, for the sheet's one line
export function applyOps(d: Draft, ops: readonly Op[]): Draft                // after checkOps passed; never mutates d
```

Reason copy, exact. `<n>` is 1-based, as the sheet numbers items:
- `No item <n>`; `No stage <n>`; `No practice <n>`; `No shared part <n>`;
- `"<find>" isn't in that brief`; `<value> isn't an effort`; `<value> isn't an isolation`;
- `That only applies to Lineup`; `That only applies to Roles`; `A practice is at most 120 characters`.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('editing a draft', () => {
  const d = () => readWorkflow({ msgs: [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' }))], records: {}, teams: {},
    list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p', lead: {} })!
  test('each op applies', () => {
    const r = applyOps(d(), [{ op: 'rename', name: 'Docs' }, { op: 'set', item: 1, field: 'model', value: 'sonnet' },
      { op: 'brief', item: 0, find: 'docs/api.md', replace: 'docs/guide.md' }, { op: 'practice', add: { when: 'When tests fail', do: 'fix them, 2 tries' } },
      { op: 'move', item: 1, stage: 'new' }, { op: 'form', value: 'roles' }])
    expect(r.name).toBe('Docs')
    expect(r.stages.map(s => s.agents.map(a => a.label))).toEqual([['Write the docs'], ['Add tests']])
    expect(r.stages[1]!.agents[0]!.model).toBe('sonnet')
    expect(r.stages[0]!.agents[0]!.brief).toBe('Write docs/guide.md')
    expect(r.lead.playbook).toEqual([{ when: 'When tests fail', do: 'fix them, 2 tries' }]) // your own number stays
    expect(r.form).toBe('roles')
  })
  test('one bad op rejects the whole edit and says why', () => {
    const before = d()
    expect(checkOps(before, [{ op: 'rename', name: 'X' }, { op: 'remove', item: 7 }])).toBe('No item 8')
    expect(checkOps(before, [{ op: 'brief', item: 0, find: 'nowhere', replace: 'x' }])).toBe('"nowhere" isn\'t in that brief')
    expect(checkOps(before, [{ op: 'set', item: 0, field: 'effort', value: 'turbo' }])).toBe("turbo isn't an effort")
    expect(checkOps({ ...before, form: 'roles' }, [{ op: 'move', item: 0, stage: 'new' }])).toBe('That only applies to Lineup')
  })
  test('the edit answer parses ops or a reason', () => {
    expect(parseEdit('{"ops":[{"op":"rename","name":"X"}]}')).toEqual({ ops: [{ op: 'rename', name: 'X' }] })
    expect(parseEdit('{"cannot":"There is no reviewer to drop"}')).toEqual({ cannot: 'There is no reviewer to drop' })
    expect(parseEdit('not json')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests.** Expected to FAIL.
- [ ] **Step 3: Implement.**
  - `item` indexes the Lineup's agents across all stages in reading order, or the Roles list. `stage` counts from 0. `'new'` appends a stage.
  - Efforts are the Agent tool's enum (`lower`, `higher`, `low`, `medium`, `high`, `xhigh`, `max`). Isolations are `worktree`, `remote` or `null`.
  - `remove` and `move` drop stages left empty.
- [ ] **Step 4: Run the tests and the typecheck.** Both pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: edits as checked operations"`.

### Task 7: Saved files, the plan Claude gets, agent files

**Files:**
- Modify: `plugins/redhelm/hooks/library.ts`.
- Test: a new `describe('the library')`.

**Interfaces:**
- Consumes: `Draft` and the saved types (Task 3); `hash` from `labels.ts`.
- Produces:

```ts
export function slug(name: string): string                 // ASCII words joined with '-', ≤ 48; none: `workflow-<hash(name)>`
export function uniqueName(name: string, taken: readonly string[]): string   // name, then "<name> 2", "<name> 3"…
export const projectKey: (root: string) => string          // hash(root)
export function toSaved(d: Draft, at: number, id: string): SavedWorkflow   // the draft already holds project and projectKey
export function parseSaved(text: string): SavedWorkflow | undefined          // version 1, fields shaped, else undefined
export function listed(files: readonly { name: string; text: string }[], key: string): { workflows: SavedWorkflow[]; unreadable: number }
export function runText(name: string, notes: string): string
export function planText(w: SavedWorkflow, registered: Record<string, string>, leftBehind: Record<string, string[]>): string
export type AgentSpecIn = { name: string; description: string; prompt: string; tools?: string[]; disallowedTools?: string[]; model?: string;
  effort?: string; maxTurns?: number; skills?: string[]; initialPrompt?: string; memory?: 'user' | 'project' | 'local'; background?: true; isolation?: 'worktree' | 'remote' }
export function typeName(definition: string): string | undefined
export function agentSpec(definition: string): { spec: AgentSpecIn; leftBehind: string[] } | { error: string }
```

`planText`'s copy is spec §8, verbatim: the opening paragraph, then the `Lead:`, playbook, shared parts, Roles and Lineup blocks, each present only when it has content. `registered` maps a saved type name to the type the plan names: `redhelm:<name>`, or `general-purpose` after a failure. `leftBehind` adds `(its hooks, MCP servers and permission mode stayed behind)` to that agent's line.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('the library', () => {
  test('slugs', () => {
    expect(slug('Tests, then a review')).toBe('tests-then-a-review')
    expect(slug('Тесты ✓')).toMatch(/^workflow-[0-9a-z]+$/)
    expect(uniqueName('Tests', ['Tests', 'Tests 2'])).toBe('Tests 3')
  })
  test('a saved file keeps only the chosen form and reads back', () => {
    const d = { ...readWorkflow({ msgs: [you('go'), lead(call('a1'))], records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p/notes-app', lead: {} })!, name: 'Docs' }
    const w = toSaved({ ...d, form: 'roles' }, 5, 'docs')
    expect(w.projectKey).toBe(projectKey('/p/notes-app'))
    expect(w).toMatchObject({ version: 1, id: 'docs', savedAt: 5, stages: [] })
    expect('folded' in w || 'evidence' in w).toBe(false)
    expect(parseSaved(JSON.stringify(w))).toEqual(w)
    expect(parseSaved(JSON.stringify({ ...w, version: 2 }))).toBeUndefined()
  })
  test("this project's workflows list first, then newest; bad files are counted, empty ones skipped", () => {
    const mk = (id: string, savedAt: number, key: string) => JSON.stringify({ ...emptySaved, id, name: id, savedAt, projectKey: key })
    const r = listed([{ name: 'a.json', text: mk('a', 1, 'k') }, { name: 'b.json', text: mk('b', 9, 'other') }, { name: 'c.json', text: mk('c', 3, 'k') },
      { name: 'bad.json', text: '{' }, { name: 'gone.json', text: '' }], 'k')
    expect(r.workflows.map(w => w.id)).toEqual(['c', 'a', 'b'])
    expect(r.unreadable).toBe(1)
  })
  test('the run text and each plan shape', () => {
    expect(runText('Build: phase two', '')).toBe('Run my saved REDhelm workflow "Build: phase two".')
    expect(runText('Docs', 'only src/store.js')).toBe('Run my saved REDhelm workflow "Docs". My notes for this run: only src/store.js')
    const roles = planText({ ...emptySaved, name: 'Build', form: 'roles', lead: { skills: ['redmanager'], playbook: [], briefParts: ['STATUS: DONE'] },
      roles: [{ ...role, label: 'Implementer', type: 'store-builder', ran: 7 }] }, { 'store-builder': 'redhelm:store-builder' }, {})
    expect(roles).toContain('Lead: use the redmanager skill to run this.')
    expect(roles).toContain('Every agent\'s brief should include:\nSTATUS: DONE')
    expect(roles).toContain('subagent_type redhelm:store-builder')
    expect(roles).not.toContain('How the lead worked last time')
    const lineup = planText({ ...emptySaved, form: 'lineup', stages: [{ agents: [{ ...savedAgent, label: 'Docs', brief: 'Write the docs' }] }] }, {}, {})
    expect(lineup).toContain('Stage 1, start together:')
    expect(lineup).toContain('Write the docs')
  })
  test('an agent file carries its settings and leaves hooks, MCP servers and permission mode behind', () => {
    const file = '---\nname: store-reviewer\ndescription: Reviews the store\ntools: Read, Grep\nmodel: sonnet\npermissionMode: bypassPermissions\nhooks:\n  Stop: echo\nmcpServers: [notes]\n---\nYou review the store.'
    expect(typeName(file)).toBe('store-reviewer')
    expect(agentSpec(file)).toEqual({ spec: { name: 'store-reviewer', description: 'Reviews the store', prompt: 'You review the store.', tools: ['Read', 'Grep'], model: 'sonnet' },
      leftBehind: ['hooks', 'mcpServers', 'permissionMode'] })
    expect(agentSpec('no frontmatter')).toEqual({ error: 'No front matter' })
  })
})
```

  `emptySaved`, `role` and `savedAgent` are fixture constants in the test file: a `SavedWorkflow`, `SavedRole` and `SavedAgent` with the least each needs.

- [ ] **Step 2: Run the tests.** Expected to FAIL.
- [ ] **Step 3: Implement.**
  - The front matter is a YAML subset: `key: value`; a list as `[a, b]`, as `a, b`, or as `- a` lines; booleans; integers.
  - An indented block under a key, such as `hooks:`, is that key's value; it is not parsed further.
- [ ] **Step 4: Run the tests and the typecheck.** Both pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: saved files, the plan for Claude, agent files that travel"`.

### Task 8: Save in the panel

**Files:**
- Modify: `plugins/redhelm/types/index.d.ts`. Add `Detail`, `WorkflowSheet` and `WorkflowMode`. `PluginState.redhelm` gains `workflowSheet: WorkflowSheet | null`, `workflowList: { workflows: SavedWorkflow[]; unreadable: number } | null` and `workflowMode: WorkflowMode`.
- Modify: `plugins/redhelm/hooks/view.tsx`:
  - `Actions` and `View` gain the new fields.
  - New `WorkflowsSection` and `WorkflowSheet`.
  - `Workflows` is renamed `Boards`.
- Modify: `plugins/redhelm/hooks/register.tsx`:
  - the actions;
  - the panel render swapping in the sheet, beside `v.inspecting`;
  - a new pane `redhelm-workflow` for the bottom placement;
  - the reading call;
  - copying types;
  - writing the file.
- Test: a new `describe('saving a workflow')`.

**Interfaces:**
- Consumes: `readWorkflow`, `leadTrace`, `readingRequest`, `checkReading`, `applyReading`, `READING_CALL` (Tasks 4–5); `applyOps` (Task 6); `slug`, `uniqueName`, `toSaved`, `projectKey`, `typeName` (Task 7).
- Produces:

```ts
export type Detail = { kind: 'item' | 'practice' | 'parts'; index: number }
export type WorkflowSheet =
  | { mode: 'review'; draft?: Draft; error?: string; undo: Draft[]; busy?: 'applying'; detail?: Detail; token: number }
  | { mode: 'saved'; id: string; armed?: boolean; detail?: Detail }
export type WorkflowMode = null | { kind: 'edit' }
  | { kind: 'run'; id: string; name: string; registered: Record<string, string>; leftBehind: Record<string, string[]> }
// Actions, added here:
wfSave: () => void; wfEarlier: () => void; wfForm: (form: 'roles' | 'lineup') => void
wfDetail: (d: Detail | null) => void; wfRemove: (item: number) => void; wfKeep: () => void; wfClose: () => void
wfBar: () => void   // the bottom bar's Workflows button: opens redhelm-workflow on the section
// View, added here:
workflow: WorkflowSheet | null; library: { workflows: SavedWorkflow[]; unreadable: number } | null; mode: WorkflowMode
```

Keys:
- `wf-save`, `wf-load`, `wf-earlier`, `wf-roles`, `wf-lineup`;
- `wf-item-<i>`, `wf-remove-<i>`, `wf-practice-<i>`, `wf-parts`;
- `wf-keep`, `wf-cancel`, `wf-back`, `wf-bar`.

Copy, exact:
- The section, and the bottom bar's button: `Workflows`, `Save`, `Load`.
- The sheet: `Save workflow`, `Reading…`, `Lead`, `no skill`, `Playbook`, `read`, `seen`, `Briefs`, `Save as`, `Roles`, `Lineup`, `ran <n>×`, `<k> together`, `after <k>`, `type copied`, `type not copied`, `<label> ran <n> times · saved once`.
- Messages: `No agent work in this session yet`, `Couldn't read this session`, `Couldn't read this session's lead`.
- Toasts: `Saved · <name>`, `Couldn't save · <reason>`.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('saving a workflow', () => {
  const said = [you('Write the docs and tests'), lead(call('a1', { model: 'sonnet' }), call('a2', { description: 'Add tests', effort: 'high' })),
    lead(call('a3', { description: 'Review the change', subagent_type: 'store-reviewer' }))]
  const reading = JSON.stringify({ name: 'Tests, then a review', purpose: 'Docs and tests, then a review', labels: ['Docs', 'Tests', 'Review'],
    roles: [{ label: 'Writer', role: 'Writes one part' }, { label: 'Reviewer', role: 'Checks the change' }],
    playbook: [{ when: 'When parts are independent', do: 'start writers together', evidence: [2] }] })
  const setup = (on: any, opts: { said?: Msg[]; answer?: () => any; files?: Record<string, string> } = {}) => {
    const writes: Record<string, string> = {}
    on('session.messages', (_$: any, e: any) => ({ value: e.agentId ? [] : opts.said ?? said }))
    on('model.complete', () => opts.answer?.() ?? { value: { isAnswered: true, text: reading, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    on('fs.list', (_$: any, e: any) => ({ value: Object.keys(opts.files ?? {}).filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file' })) }))
    on('fs.read', (_$: any, e: any) => (e.path in (opts.files ?? {}) ? { value: opts.files![e.path] } : { error: 'missing' }))
    on('fs.write', (_$: any, e: any) => ((writes[e.path] = e.text), { value: undefined }))
    return writes
  }
  const settle = () => new Promise<void>(r => setTimeout(() => r(), 60))
  test('Save opens the sheet on the latest stretch; the reading fills in after', async ($: any, on: any) => {
    setup(on)
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' })
    expect(await ui.find({ type: 'Text', text: /^Save workflow$/ })).toBeDefined()
    await settle()
    expect(await ui.find({ type: 'Text', text: /Tests, then a review/ })).toBeDefined()
    expect((await ui.find({ key: 'wf-item-2' }))?.text).toMatch(/Review/)
    await ui.press({ key: 'wf-practice-0' })
    expect(await ui.find({ type: 'Text', text: /#2 lead started general-purpose · sonnet/ })).toBeDefined() // its evidence
    await ui.unmount()
  })
  test('Save writes the chosen form only; a same name becomes "<name> 2"', async ($: any, on: any) => {
    const writes = setup(on, { files: { [`${HOME}/.claude/redhelm/workflows/tests-then-a-review.json`]: JSON.stringify({ ...emptySaved, id: 'tests-then-a-review', name: 'Tests, then a review' }) } })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle(); await ui.press({ key: 'wf-keep' }); await settle()
    const path = Object.keys(writes).find(p => /workflows\/tests-then-a-review-2\.json$/.test(p))!
    expect(JSON.parse(writes[path]!)).toMatchObject({ name: 'Tests, then a review 2', form: 'lineup', roles: [] })
    await ui.unmount()
  })
  test("a project's own type is copied once and marked", async ($: any, on: any) => {
    const writes = setup(on, { files: { '/p/.claude/agents/store-reviewer.md': '---\nname: store-reviewer\ndescription: Reviews\n---\nYou review.' } })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /type copied/ })).toBeDefined()
    await ui.press({ key: 'wf-keep' }); await settle()
    expect(JSON.parse(Object.values(writes)[0]!).types).toEqual([{ name: 'store-reviewer', definition: '---\nname: store-reviewer\ndescription: Reviews\n---\nYou review.' }])
    await ui.unmount()
  })
  test("a failed reading keeps what was seen and says so; no agent work says so", async ($: any, on: any) => {
    setup(on, { answer: () => ({ value: { isAnswered: false } }) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /Couldn't read this session's lead/ })).toBeDefined()
    expect((await ui.find({ key: 'wf-item-0' }))?.text).toMatch(/Write the docs/)
    await ui.unmount()
  })
  test('a reading that lands late is dropped', async ($: any, on: any) => {
    const pending: (() => void)[] = [] // one release per reading, in the order they were asked
    setup(on, { said: [you('one'), lead(call('a1')), you('two'), lead(call('a2', { description: 'Add tests' }))],
      answer: () => new Promise(r => pending.push(() => r({ value: { isAnswered: true, text: JSON.stringify({ name: 'Stale', labels: ['X'], roles: [], playbook: [] }), usage: {} } }))) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await ui.press({ key: 'wf-earlier' }); pending[0]!(); await settle() // Save's reading, now stale
    expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeUndefined()
    await ui.press({ key: 'wf-cancel' }); pending[1]!(); await settle() // Earlier's reading, after Cancel
    expect(await ui.find({ type: 'Text', text: /^Save workflow$/ })).toBeUndefined()
    await ui.unmount()
  })
})
```

  `HOME` is whatever home the test engine reports. Copy how the status-line tests resolve it and how they mock `fs.*` results, including a missing file. A test that only passes with `Earlier` hidden is not the point: the late-reading test needs two stretches.
- [ ] **Step 2: Run the tests.** Expected to FAIL: `wf-save` is not found.
- [ ] **Step 3: Implement.**
  - **`wfSave`:**
    - Read `$.session.messages()`, keeping briefs as given (no `tidy`).
    - Read `teams` with `$.session.messages({ agentId })`, only for top-level agents whose record has `tools.Agent`. A `{ deny }` reads as no team.
    - The lead model and effort come from `GUARD`.
    - Call `readWorkflow` with `back: 0`.
    - Copy types:
      - The agent's record `origin` (Task 2) decides. `project`: look for the file in `<root>/.claude/agents/`, recursively, by `typeName`. Found → `types`; not found or unreadable → `notCopied`.
      - Any other origin (`user`, a plugin id, `engine`), or no record: name only.
    - Set the sheet with a new `token`. If reading the messages throws, set `error` to `Couldn't read this session`.
    - Start the reading: count it in the label tallies. Apply the answer only when the sheet's `token` is unchanged.
    - The reading runs whatever the `labels` setting is; that setting is for dashboard labels.
  - **`wfEarlier`** re-reads with `back + 1` and a new token.
  - **`wfRemove`** is `applyOps([{ op: 'remove', item }])`, with the old draft pushed to `undo`.
  - **`wfKeep`:**
    - list the folder;
    - `uniqueName` against the saved names;
    - `slug`, made unique among the file names;
    - `toSaved`;
    - `$.fs.write`;
    - toast;
    - clear the sheet.

    A failed write toasts `Couldn't save · <reason>` and leaves the sheet open with its draft.
  - **`wfClose`** clears the sheet, and the mode, which is Task 9's.
  - **The panel:** with `v.workflow` set, it draws `WorkflowSheet` in place, as for `v.inspecting`.
  - **Bottom placement:** the bar gets a `Workflows` button (`wf-bar`), which opens `redhelm-workflow` (`closeOnEscape`, `rows: 24`) on the section. The sheet draws in that pane, and `ui.close` of it clears the sheet.
  - Rename `Workflows` to `Boards` in `view.tsx`.
- [ ] **Step 4: Run the tests and the typecheck.** Both pass. Then run `claude plugin validate --strict plugins/redhelm`, which must pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: Save reads the session into a review sheet and keeps it in the library"`.

### Task 9: Edit, Load, Run and Delete

**Files:**
- Modify: `plugins/redhelm/hooks/register.tsx`:
  - the `prompt.submit` branches, placed before the `→` branch;
  - the actions;
  - registering types;
  - making `compose` and the modes exclusive.
- Modify: `plugins/redhelm/hooks/view.tsx`: the library list, the saved sheet, `Edit` and `Undo`.
- Test: a new `describe('editing and running a workflow')`.

**Interfaces:**
- Consumes: `editRequest`, `parseEdit`, `checkOps`, `applyOps`, `EDIT_CALL` (Task 6); `listed`, `parseSaved`, `projectKey`, `runText`, `planText`, `agentSpec`, `typeName` (Task 7); `draftKept`, `takeDraft` and `leaveReply` in `register.tsx`.
- Produces, as Actions:

```ts
wfEdit: () => void; wfUndo: () => void; wfLoad: () => void
wfOpen: (id: string) => void; wfRun: (id: string) => void; wfDelete: (id: string) => void
```

Keys:
- `wf-edit`, `wf-undo`;
- `wf-open-<id>`, `wf-run-<id>`, `wf-delete`.

Copy, exact:
- The mode: `✎ Workflow: applying`, `REDhelm: nothing to change`.
- The library: `No saved workflows yet`, `<k> workflow could not be read` / `<k> workflows could not be read`, `Press again to delete`.
- The saved sheet: `The lead ran on <short> · this session runs <short>`.
- Toasts: `Couldn't add <name> · <reason>`, `Could not reach the prompt`.

- [ ] **Step 1: Write the failing tests.** Same `setup` and `settle` as Task 8, plus `prompt.read`, `prompt.fill` and `prompt.submit` as in "messaging an agent".
  - **"✎ never reaches Claude, applies the ops, and your draft comes back."**
    - The box starts as `half a prompt`. Press `wf-save`, then `wf-edit`. The box is `✎ Workflow: `.
    - The model answers `{"ops":[{"op":"remove","item":2}]}`.
    - `$.prompt.submit({ text: '✎ Workflow: drop the review' })` has a `drop` matching `/applying/`. After 200 ms the box is `half a prompt`, and `wf-item-2` is gone.
  - **"a bad edit keeps the draft and says why":** the answer `{"ops":[{"op":"remove","item":9}]}` gives `No item 10` on the sheet, and `wf-item-2` stays. `wf-undo` after a good edit brings `wf-item-2` back.
  - **"▶ becomes the run text plus a plan in context":**
    - Saved workflow `Tests, then a review` (Lineup). Press `wf-load`, `wf-run-tests-then-a-review`. The box is `▶ Tests, then a review: `.
    - Submit `▶ Tests, then a review: only src/store.js`.
    - The passed-on prompt's `text` is `Run my saved REDhelm workflow "Tests, then a review". My notes for this run: only src/store.js`.
    - Its `context[0]` contains `Stage 1, start together:`.
  - **"a name with a colon runs":** the same, for `Build: phase two`.
  - **"deleting the mark ends the mode":** with Run's mode on, submit `something else`. It passes on as `something else`, and the mode is `null`.
  - **"Reply ends Edit and Edit ends Reply, handing the draft on":** compose to `a1`, then `wf-edit`. The box is `✎ Workflow: `, and `composing` is `null`. Cancel brings back what was typed before Reply.
  - **"an empty library says so":** `fs.list` rejects with a missing folder. `wf-load` shows `No saved workflows yet`.
  - **"Load lists this project's first and counts bad files":** shows `1 workflow could not be read`.
  - **"Delete needs two presses":** after one press, `Press again to delete`. After two, `fs.write` writes `''` to that path, and the list no longer has it.
  - **"Run registers a copied type this project lacks; one it has, it doesn't":**
    - The saved `types` holds `store-reviewer`, whose file has `hooks:` and `permissionMode:`.
    - With no local file, `agent.register` is called once with `name: 'store-reviewer'` and no `hooks`, `mcpServers` or `permissionMode`, and the context names `subagent_type redhelm:store-reviewer`.
    - With `/p/.claude/agents/store-reviewer.md` present, it is not called.
    - When `agent.register` rejects, the toast is `Couldn't add store-reviewer · <reason>` and the context names `general-purpose`.
  - **"no prompt box":** `prompt.fill` gives `{ isFilled: false }`. Both `wf-run-…` and `wf-edit` toast `Could not reach the prompt`, and the mode stays `null`.
- [ ] **Step 2: Run the tests.** Expected to FAIL.
- [ ] **Step 3: Implement.**
  - **`wfEdit`** calls `leaveReply` first, keeps the box in `draftKept`, fills `✎ Workflow: `, and sets the mode to `{ kind: 'edit' }`.
  - **The `✎` branch:**
    - Drop at once.
    - After 100 ms, fill back `takeDraft`.
    - Set `busy`.
    - Run the edit call, counted in the label tallies, with `parseEdit`, then `checkOps`, then `applyOps` (pushing to `undo`). A failure sets `error` to the reason, and `{ cannot }` sets it to the text.
    - Clear `busy`. A second `✎` while busy waits on the first.
  - **`wfRun`:**
    1. `leaveReply`.
    2. For each saved type, look for a local file with that `typeName` in the project and personal agent folders. Without one, run `agentSpec`, then `$.agent.register(spec)`, and record `registered` and `leftBehind`.
    3. Fill `▶ <name>: `.
    4. Set the mode.
  - **The `▶` branch:** when the mode is `run` and the text starts with `▶ ${name}: `, call `next({ ...e, text: runText(name, notes), context: [...(e.context ?? []), planText(w, registered, leftBehind)] })`, clear the mode, and fill back the kept draft after 100 ms.
  - **Text without the mark** while a mode is set clears the mode and passes on, the same as Reply's "deleted mark" path.
  - **`wfLoad`** toggles `workflowList`: list and read `~/.claude/redhelm/workflows/*.json`, then `listed`. **`wfOpen`** sets `{ mode: 'saved', id }`. **`wfDelete`** arms on the first press and writes `''` on the second.
  - **`compose`** clears any mode before filling `→`.
- [ ] **Step 4: Run the tests, the typecheck and the validator.** All pass.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: edit in the prompt box, load, run through Claude, delete"`.

### Task 10: Live check, docs and the whole-branch review (the lead runs this)

**Files:**
- Modify: `README.md`:
  - a **Workflows** feature section: Save, Load, Run, what's saved and where;
  - the old bullet renamed **Boards**;
  - Privacy: the library path, and that the reading and edit calls go to Sonnet with prompts at their first 300 characters;
  - the call tally in `/redhelm models`.
- Modify: `plugins/redhelm/README.md`: one Workflows line in the feature list.

- [ ] **Step 1: Live run.**
  - Use the sample project `/Users/Shared/notes-app`, with `--model haiku`. Load the worktree's build instead of the live install, and never `/model`.
  - Save twice from a real session: once after `/redmanager` (Roles, Lead) and once without a skill (Playbook, Lineup).
  - Edit one, check Undo, Load, then Run each. Confirm Claude starts the plan's roles or stages and names `redhelm:` types where they were copied.
  - Check the sidebar at 48 and 22 columns, the bottom bar, and light and dark themes. Screenshots must show no usage limits, time of day or home paths.
- [ ] **Step 2: Docs.** Write the two README changes.
- [ ] **Step 3: Whole-branch review.** Dispatch a `reviewer` agent on Opus, giving it the branch diff, the spec and this plan, but not our conclusions. Send its confirmed findings back to the implementer and review again. Escalate after two rounds.
- [ ] **Step 4: Final evidence.** Run the tests, the typecheck and the validator, then the privacy scan over files and `git log -p main..workflows`.
- [ ] **Step 5: Commit:** `git commit -m "Workflows: docs"`. Leave merging, the version and the release to the owner.

---

## Findings (Task 1 writes these)

Task 1 records each answer here, numbered as in the spec's "To check first" list, with the rule it gives and the task it changes.

Probe run: Claude Code 2.1.312, Haiku 5.5, sample project `/Users/Shared/notes-app`, 96 main messages, 14 agents.

1. **Non-prompt user messages.** A tool result is `{ role: 'user', text: '', toolResults: [...] }`. A background agent's finish is `{ role: 'user', text: '<task-notification> <task-id>…</task-id> <tool-use-id>…</tool-use-id> …' }`. Each assistant content block is its own message: a call, then its result, then the next call. → Task 3: the `isPrompt` rule and the "lead message is a run of assistant messages" rule.
2. **A `/` skill** is `{ role: 'user', text: '<command-message>probe-skill</command-message> <command-name>/probe-skill</command-name>' }`, followed by assistant messages. The Skill tool's use has `input.skill`, and its result has `commandName`. Claude also loaded `workflow-authoring` by itself before a Workflow call: a helper, which `Save as` corrects. Mod commands (`/wfprobe`) leave no message. → Task 3: the `/` skill rule and the `slash` fixture.
3. **`agentId`** is on every Agent tool use, background ones included. The result also carries `isAsync`, `status`, `resolvedModel`, `prompt` and `outputFile`. → No change.
4. **A `prompt.submit` `context` entry** reached the model: asked for the code word, it answered `HELM-7`. A rewritten `text` is what the transcript keeps (`Run my saved REDhelm workflow "Probe".`), and the context never shows. → No change.
5. **Workflow-run agents:**
   - At `agent.spawn` they have `subagentType: 'workflow-subagent'`, `provider: engine/core`, `workflow: { runId: 'wf_…', agentIndex }`, `background: false`, the script's label as `description` (`read:src/notes.js`), and the real prompt. A local run has no placeholder.
   - The Workflow use's input is `{ script }`. Its result is `{ status, taskId, taskType, workflowName, runId, summary, transcriptDir, scriptPath }`.
   - → Task 4: `runCalls` saves them as `general-purpose`.
6. **Plan shapes.** Roles: Claude started two Explore readers on haiku, waited for both, then one general-purpose reviewer on haiku. Lineup: stage 1's two agents, then stage 2 after both finished. Both shapes were followed as written. → No change.
7. **Agent types.**
   - A project agent in a subfolder (`.claude/agents/team/probe-local.md`) was found and dispatched.
   - `provider` names the source: `{ plugin: 'project', tier: 'user' }` for the project's own, `{ plugin: 'user', tier: 'user' }` for a personal one, `{ plugin: 'wfprobe@inline', tier: 'user' }` for a plugin's, and `{ plugin: 'engine', tier: 'core' }` for built-ins.
   - Name versus file name was not told apart (they matched).
   - → Task 2 records `origin`; Task 8 copies only `origin: 'project'`, looking recursively by `typeName`.
8. **A type registered by a command** (`$.agent.register` → `{ agent: 'wfprobe:probe-reviewer' }`) was dispatched by the next prompt's Agent call. → No change; Run registering before your Enter is enough.
