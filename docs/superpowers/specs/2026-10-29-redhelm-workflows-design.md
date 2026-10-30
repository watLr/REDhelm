# REDhelm Workflows

Date: 2026-10-29 · Status: approved direction, spec for review

## Why

A session that went well had a lead and a team: main Claude orchestrating, and agents with
these briefs, models, tools and skills, some together and some after. Today all of it is gone
when the session ends. REDhelm Workflows saves it into REDhelm's own library and hands it back
to Claude on request, so the next problem of that kind starts from a way of working that worked.

Some people lead with a process skill (REDManager, say); most do not. Both have to come back:
the skill when there was one, and how the lead actually worked when there was not.

## Red thread

**A workflow is how the work was led and staffed, never a script.** It records the lead (a
skill, or practices read from what the lead did) and the team (who ran, with what settings,
tools and skills). It never fixes loops, rounds or checks: a practice says when it applies,
and the lead decides each time whether it fits the problem. An agent type the project defined
itself travels with the team, copied whole; nothing is invented.

Signature: the review sheet, where every saved fact is either seen in the session or marked as
REDhelm's reading of it, with the evidence one press away.

## Users and constraints

- One person who ran a session with agents and wants that way of working again, in this project
  or another, with or without a process skill of their own.
- REDhelm's surfaces as today: right sidebar, bottom bar, desktop, VS Code; mobile has no prompt box.
- Claude Code 2.1.311 engine API: `$.session.messages()`, `$.prompt.fill`, `prompt.submit` with
  `context`, `$.model.complete`, `$.agent.register`, `$.fs`.
- Nothing is saved inside the project. A saved workflow can carry real briefs, so it lives under `~/.claude`.

## 1. What a saved workflow holds

```ts
type SavedWorkflow = {
  version: 1
  id: string            // file name: slug of the name
  name: string          // ≤ 40 characters
  purpose: string       // one line, ≤ 90 characters
  savedAt: number
  project: string       // the folder's name, for "from notes-app"; never a full path
  projectKey: string    // hash of the session root, to list this project's workflows first
  lead: Lead
  form: 'roles' | 'lineup'
  roles: SavedRole[]    // form 'roles': the team as roles
  stages: { agents: SavedAgent[] }[]   // form 'lineup': the team as it ran; a stage starts together
  types: SavedType[]    // the project's own agent types the team ran as, copied (§9)
}

type Lead = {
  skills: string[]      // skills the lead loaded, in order, no repeats: ["redmanager"]
  playbook: Practice[]  // how the lead worked, read from the session and confirmed (§4)
  briefParts: string[]  // paragraphs most briefs shared, verbatim (§4)
  model?: string        // what the lead ran on
  effort?: string
}

type Practice = { when: string; do: string }   // each ≤ 120 characters

type SavedRole = {
  label: string         // ≤ 16 characters: "Implementer"
  role: string          // one line: "Builds one slice in its own worktree"
  type: string          // subagent_type; a copied type keeps its own name
  model?: string
  effort?: string
  isolation?: 'worktree' | 'remote'
  background: boolean
  teammate: boolean
  tools: Record<string, number>   // summed over the agents that filled it; MCP as "mcp:<server>"
  skills: string[]
  ran: number           // how many agents filled it
  team?: SavedRole[]    // the roles its own agents filled, one level down (§3)
}

type SavedAgent = {
  label: string         // ≤ 16 characters: "Tests"
  description: string   // the Agent call's description
  brief: string         // the Agent call's prompt, whole, as given
  type: string
  model?: string
  effort?: string
  name?: string
  background: boolean
  teammate: boolean
  isolation?: 'worktree' | 'remote'
  tools: Record<string, number>
  skills: string[]
  team?: SavedRole[]
}

type SavedType = {
  name: string          // as the project named it: "store-reviewer"
  definition: string    // its agent file, whole, as it was at Save
}
```

Never saved: loop or round counts the lead chose, check commands, agent answers, file lists,
the conversation itself, and a project's run state (`.redmanager/` and the like).

## 2. Flow

### The section (foot of the sidebar, below the agents)

```
Workflows                          Save   Load
```

Nothing else shows by default. In the bottom bar the section is one button, `Workflows`,
which opens a sheet holding the same `Save` and `Load`.

### Save

1. **Save** reads the latest stretch of work (§3) and opens the review sheet, drawn in the
   panel like an agent's sheet, with `← Back`. What REDhelm saw shows at once; what it reads
   (§5) fills in a few seconds later, under `Reading…`.
2. The sheet, for a session led by a skill:

```
Save workflow
  REDManager build                                        read
  Phased build, implementers in worktrees, independent review

  Lead       redmanager skill · opus
  Save as    Roles · Lineup
  Roles      Implementer  general-purpose · opus · worktree   ran 7×
             Reviewer     store-reviewer · sonnet · type copied  ran 3×
             Explorer     Explore · haiku · low               ran 2×

  Save    Edit    Earlier    Cancel
```

   And for one led without a skill:

```
Save workflow
  Build, check, review                                    read
  Parallel implementers, then your checks and a separate review

  Lead       no skill · opus
  Playbook                                                read
    1  When the work splits cleanly, start implementers together, each in its own worktree
    2  When an implementer reports done, run the checks yourself before moving on
    3  When shared code changed, have a separate reviewer check it
    4  When a review finds problems, send them back to the implementer who wrote it
  Briefs     every brief ended with a status report         seen
  Save as    Roles · Lineup
  Roles      Implementer  general-purpose · opus · worktree   ran 2×
             Reviewer     reviewer · sonnet                   ran 2×

  Save    Edit    Earlier    Cancel
```

   - `Save as` switches between Roles and Lineup (§4); Lineup shows stages and agents with
     their briefs, as the session ran them.
   - Selecting a practice shows the moments it was read from (§5). Selecting a role or agent
     shows its tools, skills, its own team, and in Lineup its whole brief; its `Remove` drops it.
   - `Briefs` shows the shared parts whole. `type copied` marks a project's own type; its
     detail shows the definition that will be saved and what stays behind (§9).
   - `Earlier` widens the stretch by one (§3); hidden when there is no earlier one.
   - Empty: "No agent work in this session yet" and `Cancel`.
3. **Edit** takes over the prompt box the way Reply does (§6). Each change redraws the sheet;
   `Undo` steps back one change at a time.
4. **Save** writes the workflow to the library (§7). Toast: `Saved · Build, check, review`.
   The section is back to `Save  Load`.

### Load and Run

1. **Load** lists the library in the section, this project's first, then newest first:

```
Workflows                          Save   Load
  REDManager build      skill · 3 roles             Run
  Build, check, review  playbook · 2 roles · from api   Run
```

2. Selecting a name opens its sheet: the review sheet's view, with `Run`, `Delete` and
   `Close`. When this session's model differs from the lead's, it says so in one dim line
   (`The lead ran on opus · this session runs sonnet`); nothing is changed for you.
   `Delete` asks once more ("Press again to delete") before it removes the file.
3. **Run** puts `▶ Build, check, review: ` in the prompt box. You may add notes for this run
   and press Enter; that Enter is the go-ahead. Claude does the rest (§8).

## 3. How Save reads the session

**Sources.**
- The main conversation, `$.session.messages()`: your prompts; the lead's skill loads; its
  Agent tool uses with their whole input (`description`, `prompt`, `subagent_type`, `model`,
  `effort`, `name`, `run_in_background`, `isolation`) and the started `agentId`; and the lead's
  other steps (messages to agents, questions to you, commands, commits) for the playbook (§4).
- REDhelm's own record of each agent (§10): when it started and ended, its parent, its run,
  whether it is a teammate, and its tools and skills.
- An agent's own conversation, `$.session.messages({ agentId })`: its own Agent tool uses
  (its team), and tools and skills for an agent REDhelm did not watch.
- The project's agent files (`.claude/agents/`), to copy a type the project defined (§9).

**Stretches.** Your prompts split the conversation. A stretch begins at a prompt of yours
after which the lead started at least one agent, and runs until the next such prompt; your
prompts inside it that started no agent belong to it. When the lead loaded a skill before its
first agent, the stretch starts at your prompt before that load and runs to the end: a skill
like REDManager leads across many turns and prompts. Save opens on the latest stretch;
`Earlier` adds the one before it, again and again.

**Which agents.** The agents the lead started in the main conversation. An agent that started
agents of its own gets them as its `team`, grouped into roles as below, one level down;
deeper agents count only in their parent's tools (`Agent 3`).

**Stages** (Lineup). Walk the stretch's agents in start order. An agent joins the current
stage when it started in the same lead message as the stage's first agent, or while an agent
of the stage was still running; otherwise it opens a new stage. Without times (an agent
REDhelm did not watch), only the same-message rule applies.

**Repeats** (Lineup). A second round must not become another stage: that would save a loop by
unrolling it. An agent with the same type and the same name, or the same type and the same
description, as one in an earlier stage is a repeat (two alike in one stage are peers, both
kept). It is not saved; the first is, and the sheet says `Implement ran 2 times · saved once`.
A stage left empty is dropped. A round with a new description is not caught; `Remove` handles it.

**Roles** (Roles). The stretch's agents grouped by setup: the same type, model, effort and
isolation make one role, however many agents filled it and in whatever order. `ran` counts
them; tools are summed and skills joined. The reading (§5) names each role and writes its line.

**Built-in workflow runs.** A run's agents carry its `runId` at `agent.spawn`. REDhelm saves
them like any other agents, from its own record, never the run's script, since the script is
where loops live; the script's text does go to the reading as evidence of how the lead worked.
A run that kept its prompts out of events gives a placeholder brief; that agent shows
`Brief not available` and saves without one.

## 4. The lead

**Lead skills.** Every skill the lead loaded in the stretch, by the Skill tool or by your `/`
command, in order, saved by name. The plan tells Claude to lead with them. A personal skill
(`~/.claude/skills/`) or a plugin's is there in other projects; a project's own skill is not
copied in this version, and the plan says so where it is missing.

**Roles or Lineup.** The default is Roles when the lead loaded a skill before its first agent
(the skill writes each run's briefs and phases; last run's would be wrong), and Lineup
otherwise (the same job again, with the briefs that did it). `Save as` switches either way: a
helper skill loaded first can make Roles the default wrongly, and a team without a skill may
be worth saving as roles.

**The playbook.** How the lead orchestrated, so a way of working survives without a skill of
your own. Read from the lead's steps in the stretch (§5): how it started agents (together,
after, in worktrees), what it did when they reported (ran checks itself, sent findings back to
the same agent, started a reviewer, asked you), and what you steered (a practice you asked for
says so: "you asked for this"). Each practice is a condition and an action:

- It says **when** it applies, so the lead can see it does not fit a different problem.
- It carries **no fixed number** (rounds, workers, attempts) unless you said one in a prompt.
- At most eight. Practices that restate a lead skill's own process are left out.

Read for every stretch. With a lead skill it holds only what the lead did on top of the
skill, and is often empty; an empty playbook is not shown on the sheet or in the plan.

**Shared brief parts.** Paragraphs (split at blank lines, whitespace evened out) that appear
word for word in at least two briefs and in at least half of them: a report format, a rule
every agent got. At most three, each up to 1,500 characters, saved verbatim and marked seen.
They matter most in Roles, where the briefs themselves are not saved.

**The lead's model.** Main's model and effort at the stretch's last request, from REDhelm's
guard record. Shown, never applied: Claude cannot switch its own model.

## 5. The reading

One `$.model.complete` call per Save: **Sonnet, low effort**, with a fixed answer shape. It
runs on every Save, whatever the `labels` setting (that setting is for dashboard labels; Save
is something you asked for).

- **Input**, built by REDhelm and never saved:
  - the lead trace: the stretch's events, numbered, one line each: `#1 you: "<first 300
    characters>"`, `#2 lead loaded skill brainstorming`, `#3 lead started 2 × general-purpose ·
    opus · worktree together`, `#4 an agent finished`, `#5 lead ran npm test`, `#6 lead sent a
    message to an agent`, `#7 lead asked you a question`, `#8 lead ran git commit`. Commands
    are program and subcommand only.
  - any built-in workflow script in the stretch, first 6,000 characters.
  - each agent's (or role's) description and the first 300 characters of its brief.
- **Answer**: `{ name, purpose, labels: string[], roles: { label, role }[], playbook: { when,
  do, evidence: number[] }[] }`.
- **Checks**, after which anything failing is dropped, never shown:
  - lengths (§1); one label per agent and one entry per role, in order;
  - a practice must cite events that exist; one citing none is dropped;
  - a practice whose text has a number is dropped unless a cited event is one of your prompts
    holding that number;
  - at most eight practices.
- **Labels told apart**, after the reading or the fallbacks: within the lineup (all its stages) and
  within the roles, a second and later label alike gets ` 2`, ` 3`…, cut to stay within 16 characters.
- **Fallbacks**, when the call fails, times out or is all dropped: agents' descriptions as
  labels, their first three joined as the name ("Docs, Tests, Review"), no purpose, roles
  labelled by type, an empty playbook. The sheet says `Couldn't read this session's lead` and
  Save still works; practices can be added with ✎.
- **Evidence** stays in memory for the sheet (a practice's moments) and is not saved.

## 6. Edit: the prompt box, Reply's way

- `Edit` fills the prompt box with `✎ Workflow: `, keeping what you were writing to Claude
  (the `draftKept` atom Reply uses).
- On Enter, the `prompt.submit` hook matches `/^✎ Workflow: ([\s\S]*)$/`, drops the prompt
  (it never reaches Claude) with `✎ Workflow: applying`, and puts your draft back.
- The change is applied off the hook: one `$.model.complete` call, **Sonnet, low effort**.
  The model returns operations, never a rewritten workflow, so a brief can never be shortened
  or mangled behind your back. `item` is an agent in Lineup and a role in Roles:

```ts
type Op =
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
type EditAnswer = { ops: Op[] } | { cannot: string }
```

- Every op is checked before any is applied: items, stages, practices and parts exist; `find`
  occurs in the brief; `effort` and `isolation` take their tool's values; an op or a field for
  the other form is refused; a practice keeps §1's lengths. A practice you add or write may hold a
  number: it is yours. One bad op rejects the edit; the draft stays as it was and the sheet
  says why in one line. `{ cannot }` is shown as it is.
- While it applies, the sheet shows `Applying…`; another `✎` waits for it.
- Leaving: deleting the `✎ Workflow:` mark, `Cancel` or `Esc` ends the mode and restores your
  draft, exactly as for Reply.
- One mode owns the prompt box at a time: starting Edit or Run ends an open Reply, and Reply
  ends either of them, each handing your draft on rather than losing it.

## 7. The library

- One file a workflow: `~/.claude/redhelm/workflows/<id>.json`, through `$.fs` (beside the
  status lines REDhelm already keeps in `~/.claude/redhelm/`).
- A name already in the library saves as `<name> 2`; nothing is overwritten.
- A file that does not parse, or has a `version` newer than 1, is skipped; the list ends with
  `1 workflow could not be read` when there are any.
- Load reads the folder each time it is pressed; there is no cache to go stale.

## 8. Run: Claude does it, as if you asked

When you press **Run**, before the prompt box is filled, REDhelm registers any copied type
this project lacks (§9): a registered type is dispatchable from the next turn, which your
Enter starts.

On Enter, the `prompt.submit` hook matches `▶ <name>: ` for the workflow that Run chose (kept
in state, not parsed from the text), and rewrites the prompt:

- `text`: ``Run my saved REDhelm workflow "<name>".`` plus ` My notes for this run: <notes>` when you wrote any.
- `context`: the workflow as a plan, which you never see. Its parts, in order:

```
Saved REDhelm workflow "<name>": <purpose>.
It is not one of Claude Code's saved workflows, so don't look it up by name: start the agents
below with the Agent tool, or write a Workflow script from them.
It is how this kind of work was led and staffed before: start from it, and fit it to this
problem and to my notes. It fixes no loops, rounds or checks; choose those for this problem.
If an agent type or skill is not available here, go without it and say so.

Lead: use the redmanager skill to run this.                        (when there are lead skills)

How the lead worked last time. Use the practices that fit this problem:   (when there is a playbook)
1. When the work splits cleanly, start implementers together, each in its own worktree.
2. …

Every agent's brief should include:                                 (Roles, when there are shared parts)
<part, verbatim>

Staff it with these roles, as many of each as the work needs:       (Roles)
- Implementer: builds one slice in its own worktree. subagent_type general-purpose, model opus,
  isolation worktree, background. Tools it used: Edit, Bash, Read. Skills: none. Ran 7 times.
  It started its own team: Writer (general-purpose, sonnet, ran 3 times). Ask it to staff its
  work that way.
- …

Stage 1, start together:                                            (Lineup)
- Docs: subagent_type general-purpose, model sonnet, effort medium, background
  Tools it used: Read 9, Edit 5. Skills it used: none.
  Brief:
  <the brief>
Stage 2, after stage 1 finishes:
- …
```

Each `subagent_type` in the plan is the one that will work here: the type as saved, or
`redhelm:<name>` where REDhelm registered the copy.

Claude starts the agents with the Agent tool, or with the Workflow tool where that is on;
the choice is Claude's. The results land in the conversation. No run state is kept beyond the prompt.

## 9. Agent types that travel

A type is copied, never invented. Where a saved agent's type comes from decides what Save does:

| The type it ran as | Elsewhere | Save |
| --- | --- | --- |
| Built-in (`general-purpose`, `Explore`, `Plan`) | always there | the name only |
| The person's own (`~/.claude/agents/`) | there for them | the name only |
| A plugin's (`<plugin>:<name>`) | where the plugin is installed | the name; the plan names the plugin |
| **The project's own (`.claude/agents/`)** | **missing** | **the name and its agent file, whole** |

**At Save.** REDhelm looks for the project's agent file whose `name` is the agent's type. Found,
the file's text goes into `types` (once per type, however many agents or roles used it). A type
found in both the project and `~/.claude/agents/` counts as the project's, which is the one that ran.

**At Run.** For each saved type:
- This project has a type of that name (its own, the person's or a plugin's): REDhelm registers
  nothing, and the plan uses the local one. What is here wins.
- It has none: REDhelm parses the saved file and calls `$.agent.register` with
  `name: <its name>`, which the engine names `redhelm:<name>`. Registered types last for the
  session; a second Run registers again, which replaces.

**What travels and what stays behind.** Carried: `description`, the body as `prompt`, `tools`,
`disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `initialPrompt`, `memory`,
`background`, `isolation`. Left behind: `hooks`, `mcpServers` and `permissionMode`. The first two
run commands and the third widens permissions; another project should not get them unseen.
The detail on the sheet lists what stays behind, and the plan says so to Claude.

**Failure.** A file that does not parse, or a spec the engine refuses: no type is registered,
a toast says `Couldn't add <name> · <reason>`, and the plan falls back to `general-purpose`
for that agent or role, saying so.

## 10. Changes to what REDhelm records

- At `agent.spawn`: `run` (`e.workflow?.runId`), `parent` (`e.parentAgentId`) and `teammate`
  (`e.isTeammate`).
- At `tool.call`, per agent: `tools[name] += 1` (an MCP tool counted under `mcp:<server>`), and
  for `Skill` its `skill` input appended to `skills` when new.
- The type contract gains the fields; old values without them read as `{}`, `[]` and `false`.

**Fix: agents of a built-in workflow run.** Claude Code's agent list never names them, and
REDhelm ends an unlisted agent 20 seconds after it started (`GRACE_MS`), so they show as done
while still working. An agent with a `run` skips that rule and ends on its own `turn.complete`.

## 11. Naming

The new section is **Workflows**. The existing board progress (lane boards, status boards,
REDStudio, REDManager) becomes **Boards**: its README bullet and its component are renamed.
It has no heading in the sidebar, so nothing on screen changes.

## 12. Errors

- Every new hook fails open (`.catch(($, e, next) => next(e))`); bookkeeping runs inside `quietly`.
- Reading the session fails: the sheet says `Couldn't read this session` with `Cancel`.
- The reading call fails, times out or is all dropped: fallbacks (§5), one line on the sheet.
- An edit fails: the draft stays, one line says why (§6).
- A copied type can't be registered: a toast, and `general-purpose` in the plan (§9).
- A project type's file can't be found or read at Save: the agent saves with the type's name
  only, and the sheet says `type not copied`.
- Writing fails: toast `Couldn't save · <reason>`; the sheet stays open with the draft.
- No prompt box (mobile, `-p`): Edit and Run toast `Could not reach the prompt`, as Reply does.

## 13. Privacy

- Saved only under `~/.claude/redhelm/workflows/`: never in the project, never published.
- `project` is the folder's name; the full path is only ever hashed (`projectKey`).
- Briefs (Lineup), shared brief parts and copied agent files are saved as written, and shown
  whole on the sheet before Save, so what is stored is what you saw.
- No commands, file lists, agent answers or conversation are saved. The lead trace and the
  evidence behind practices live in memory for the sheet and go when it closes.
- A copied agent file's hooks, MCP servers and permission mode are kept in the file but never
  registered (§9).
- The reading and edit calls go to Claude Code's own model, the channel REDhelm's labels use;
  your prompts reach it as their first 300 characters, commands as program and subcommand.
- Tests use made-up conversations only.

## 14. Code shape

- `hooks/workflows.ts` (new, no engine calls): the types; `stretches(messages)`;
  `readWorkflow(messages, records, teams, stretch)` → draft with lead, roles and stages;
  `foldRepeats`; `groupRoles`; `sharedParts(briefs)`; `leadTrace(messages, records, stretch)`;
  `checkReading(answer, trace, draft)`; `checkOps` and `applyOps`;
  `planText(workflow, notes, registered)`; `parseSaved` with the version check; `slug`;
  `agentSpec(definition)` → the carried fields and what stays behind, or an error.
- `hooks/register.tsx`: the actions (save, earlier, remove, form, edit, undo, keep, cancel,
  load, open, run, delete), the `✎` and `▶` branches of `prompt.submit`, the reading and edit
  calls, the library through `$.fs`, finding and copying project types at Save and registering
  them at Run (§9), the records of §10 and the fix.
- `hooks/view.tsx`: `WorkflowsSection`, `WorkflowSheet` (review and saved, Roles and Lineup,
  practice and item details), the library list; `Workflows` renamed `Boards`.
- `types/index.d.ts`: `Agent` gains `run`, `parent`, `teammate`, `tools`, `skills`; state gains
  `workflowSheet` (draft, undo stack, stretch, evidence, busy, error) and `workflowMode`
  (`edit` or the run's id).

## 15. Testing

- **Stretches:** split at prompts that started agents; a prompt with no agents stays inside;
  a lead skill before the first agent keeps the stretch whole to the end; `Earlier` widens.
- **Lead:** skills from the Skill tool and from a `/` command, in order, once each; the lead's
  model from the guard record; the default form follows a skill loaded before the first agent.
- **Stages and repeats** (Lineup): same message together; a background agent started while
  another runs joins; one started after all ended opens a stage; no times → only the
  same-message rule; same type and name folded with the count; a stage left empty dropped.
- **Roles:** grouped by type, model, effort and isolation; `ran` counted; tools summed.
- **Teams:** an agent's own agents become its `team` as roles; deeper ones only in its tools;
  a run's agents come from records.
- **Shared parts:** a paragraph in two of three briefs kept; one in a single brief not; at most three.
- **Reading checks:** a practice citing no event dropped; a number not in a cited prompt of
  yours dropped; one that is kept; more than eight cut to eight; a failed call gives the
  fallbacks and the line.
- **Ops:** each op applied; a bad one rejects the whole edit and keeps the draft; an op for the
  other form refused; `cannot` shown.
- **Prompt box:** `✎` is dropped and never reaches Claude, and the draft comes back; `▶`
  becomes the text plus a `context` plan with notes, in each shape (skill, playbook, Roles,
  Lineup); deleting the mark ends either mode.
- **Library:** save and read back; a same name becomes `<name> 2`; a bad file is skipped and
  counted; delete needs two presses.
- **Types at Save:** a project type is copied once however many agents used it; built-in,
  personal and plugin types save the name only; a missing file saves the name, marked.
- **Types at Run:** a type this project lacks is registered and the plan names
  `redhelm:<name>`; one it has is not registered and the plan names the local one; `hooks`,
  `mcpServers` and `permissionMode` never reach `$.agent.register`; a refused spec falls back
  to `general-purpose` with a toast.
- **Fix:** a `run` agent past 20 seconds, unlisted, is still working.

## To check first (the first task of the plan)

1. How notifications and other non-prompt messages appear in `$.session.messages()`, so a
   stretch only splits at prompts you typed.
2. How a skill you start with `/` appears there, beside the Skill tool's own uses.
3. That an Agent tool use's entry carries `agentId` for a background agent.
4. That a `prompt.submit` `context` entry reaches the model as written.
5. What a workflow-run agent's `description` holds, for its label.
6. That Claude, handed each plan shape, leads and staffs as written (one live run on Haiku per shape).
7. How Claude Code finds a project's agent files (the folder, subfolders, the `name` field
   versus the file name), and what `agent.spawn`'s `provider` says for a project, personal
   and plugin type.
8. That a type registered when Run is pressed is dispatchable in the turn your Enter starts.

## Out of scope

Fixed loops, rounds and checks (§1); turning a playbook into a skill file of its own; copying
a project's own skills; teams more than one level below an agent; building new agent types
from what an agent did (a written system prompt, a tool list from last time); copying a
plugin's or a built-in type; carrying a type's hooks, MCP servers or permission mode; recurring
runs (`/loop`, schedules); enforcing a saved model, skill or practice at run time; saving into
the project or sharing; showing a run's progress against its workflow.

## Changes made while building

What the build decided beyond this spec, from a probe of Claude Code 2.1.312, the task reviews and a live check.

**Reading the session**
- Claude Code stores each content block as its own message, and a tool result is a user message. So a "lead message" is a run of assistant messages with nothing between them. Background agents, started one per message, group into a stage by timing instead.
- These are not your prompts: tool results, `<task-notification>`, `<local-command`, `<system-reminder>`, `<bash-` and `[Request interrupted` messages. A `/` command counts as a skill only when the model answered it.
- A skill loaded in the planning turn before the first agent (REDManager's intake, then your approval) leads the stretch from the prompt before that skill.
- Each agent's `provider` names where its type comes from (`project`, `user`, a plugin id, `engine`), and REDhelm records it as `origin`. Save copies only `project` types. Without a record, it looks for the project's file by name.
- A built-in workflow run's agents have the type `workflow-subagent`, which the Agent tool can't start. They are saved as `general-purpose`, with their model as a family alias and their brief as REDhelm recorded it (first 2,000 characters). They are placed in stages by timing.
- For an agent REDhelm has no record of, Save reads the agent's own conversation for its tools, skills and team. Records keep only the 20 latest finished agents. A pruned run's agents stay out, because their conversations can't be read.
- Commands keep only the program, plus a subcommand for git, npm, pnpm, yarn, bun, npx, bunx, deno, cargo, go, docker, kubectl, gh, claude and make. Wrappers such as sudo and env are skipped. A wrapper followed by a flag is named alone.
- The trace says `a workflow finished` for a run's own notice. A one-agent start reads `lead started <type> · <model>`.

**The reading**
- The no-numbers check also catches number words: two to twelve, twice, thrice, dozen, but not one or once. A number matches its digits in a prompt you cited.
- A list of the right length falls back item by item. Labels within one form are made distinct ("Describe", "Describe 2"). The request states each field's limit, after the live check found over-long role labels being dropped.
- The step marker for steps left out is sent unnumbered and can't be cited.

**Edit**
- Op numbers refer to the draft as listed.
- The edit call gets each brief and shared part whole, up to 6,000 characters each, because a find-and-replace needs the text.
- An empty `ops` list changes nothing. Edit, Undo, Remove, Save, Earlier and Save as are refused while the reading or an edit is still out.
- A hand-typed `✎ Workflow:` with no edit open says `REDhelm: press Edit first`.

**Run**
- The plan's opening says it is not one of Claude Code's saved workflows. In the live check, Claude first looked it up with the Workflow tool.
- Tools added with ✎ reach the plan as "Also give it: …". Roles list tool names without counts.
- A copied type that can't be added says so in the plan and falls back to `general-purpose`.

**Agent types**
- These are errors, never text: a block list (`|`, `>`), text after a closing quote, an empty `tools: []`, and a value that opens with a YAML indicator (anchor, alias, tag, `- ` on the key's line, and the like). A lost `disallowedTools` entry would widen what the agent may do.
- Windows line endings read like Unix ones.
- The parser lives in `hooks/agentfile.ts`.

**The prompt box**
- Only a prompt you typed answers ✎, ▶ or Reply. A notification or a peer's message never ends a mode or wipes a half-typed reply.
- The model guard is asked before any mode ends, so a held prompt is never overwritten.
- In the bottom bar, Edit closes the Workflows pane to hand over the keys and reopens it once the change lands. Esc still clears it.
- Run ignores a second press while one is in flight. An open library list refreshes after a Save. Removing the last item, or saving an empty workflow, is not offered.

**`/redhelm models`** now names REDhelm's own model calls, labels and workflows alike.

**Known gaps**
- A quoted whole-value list that opens with an indicator (`tools: "*"`) is rejected: the type falls back, saying so.
- Save's local reads have no timeout.
- A run agent whose `turn.complete` never comes (remote isolation, internal builds only) stays running.
- The kept draft has one slot, as Reply's always has.
- Not live-checked: the light theme and a 22-column sidebar.
