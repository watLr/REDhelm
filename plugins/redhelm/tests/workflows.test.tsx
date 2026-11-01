import { describe, expect, test } from 'claude-code/testing'
import type { Draft, SavedAgent, SavedRole, SavedWorkflow } from '../types'
import { hash } from '../hooks/labels'
import { agentCalls, applyReading, checkReading, command, defaultForm, foldRepeats, groupRoles, isPrompt, leadSkills, leadTrace, readingRequest, readWorkflow, READING_CALL, READING_SYSTEM, distinctLabels, runCalls, sharedParts, stagesOf, stretches, teamOf, typedPrompts, usedIn, widen, type Msg } from '../hooks/workflows'
import { applyOps, checkOps, editable, editRequest, listed, missingSkills, parseEdit, parseSaved, planText, projectKey, runReasons, runText, slug, toSaved, uniqueName, EDIT_CALL, EDIT_SYSTEM, type Op } from '../hooks/library'
import { agentSpec, typeName } from '../hooks/agentfile'
import { agent, PANE, openSheet, clock, engine, spawn } from './helpers'
/** The test runtime has timers; the hooks environment's declarations leave them out. */
declare const setTimeout: (fn: () => void, ms: number) => unknown

/**
 * A plugin beside REDhelm that hands a test REDhelm's agent records: a test's own `$` has no `$.state`,
 * and the host lets a hook read state only from a scanned hooks module, which the test's `on` is not.
 */
const RECORDS = {
  name: 'records',
  register(on: any) {
    on('tool.call', async ($: any, e: any, next: any) =>
      e.tool === 'RedhelmRecords' ? { result: (await $.state.get({ plugin: 'redhelm', key: 'agents' })).value } : next(e))
  },
}

describe('workflow records', () => {
  const agents = async ($: any) => (await $.tool.call({ tool: 'RedhelmRecords' } as any)).result
  test('an agent of a built-in workflow run is still working past the 20-second grace', { plugins: [RECORDS] }, async ($: any, on: any) => {
    on('agent.list', () => ({ value: [] })) // Claude Code's list never names a run's agents
    on('turn.complete', () => ({ text: '' }))
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Probe the parser', subagentType: 'general-purpose', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
    await clock.advance(25_000)
    expect((await agents($)).a1.status).toBe('running')
    expect((await agents($)).a1.run).toBe('wf_1')
    await $.turn.complete({ answer: 'done', durationMs: 9000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    expect((await agents($)).a1.status).toBe('completed')
  })
  test('tools are counted per agent, MCP tools by server, skills once each in order', { plugins: [RECORDS] }, async ($: any, on: any) => {
    await engine(on, true)($)
    await spawn($)
    for (const call of [{ tool: 'Read', file_path: 'a' }, { tool: 'Read', file_path: 'b' }, { tool: 'mcp__notes__search', q: 'x' },
      { tool: 'Skill', skill: 'tdd' }, { tool: 'Skill', skill: 'tdd' }, { tool: 'Skill', skill: 'brainstorming' }])
      await $.tool.call({ ...call, agentId: 'a1' } as any)
    const a = (await agents($)).a1
    expect(a.tools).toEqual({ Read: 2, 'mcp:notes': 1, Skill: 3 })
    expect(a.skills).toEqual(['tdd', 'brainstorming'])
  })
  test('a spawn records its parent, whether it is a teammate and where its type comes from', { plugins: [RECORDS] }, async ($: any, on: any) => {
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Scout', subagentType: 'Explore', parentAgentId: 'lead1', isTeammate: true, provider: { plugin: 'project', tier: 'user' } } as any)
    expect((await agents($)).a1).toMatchObject({ parent: 'lead1', teammate: true, origin: 'project' })
  })
})

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
  test('a skill loaded in your prompts before the agents leads from the prompt before the load', () => {
    const msgs = [you('Build the store'), lead(call('a1')), slash('redmanager'), lead(), you('approved'), lead(call('a2', { description: 'Add tests' }))]
    expect(stretches(msgs)).toEqual([{ from: 0, to: 2, led: false }, { from: 2, to: 6, led: true }])
    expect(defaultForm(msgs, stretches(msgs)[1]!)).toBe('roles')
  })
  test('notifications are not your prompts', () => {
    expect(isPrompt(notice('agent a1 finished'))).toBe(false)
    expect(isPrompt(result())).toBe(false)
    expect(isPrompt(you('[Request interrupted by user]'))).toBe(false)
    expect(isPrompt(slash('probe-skill'))).toBe(true)
    expect(isPrompt(you('hi'))).toBe(true)
    expect(stretches([you('go'), lead(call('a1', { run_in_background: true })), notice('done'), lead(call('a2'))])).toHaveLength(1)
  })
  test("a `!` command and its output are not your prompts", () => {
    const bash = you('<bash-input>npm test</bash-input>')
    const output = you('<bash-stdout>3 passed</bash-stdout><bash-stderr></bash-stderr>')
    expect(isPrompt(bash)).toBe(false)
    expect(isPrompt(output)).toBe(false)
    // Run between two agents' starts, it splits no stretch.
    expect(stretches([you('go'), lead(call('a1')), bash, output, lead(call('a2', { description: 'Add tests' }))])).toEqual([{ from: 0, to: 5, led: false }])
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
    const msgs = [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' })), result(), lead(call('a3', { description: 'Check types' })), result(), lead(call('a4', { description: 'Review' }))]
    const s = { from: 0, to: 6, led: false }
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
    const msgs = [you('go'), lead(impl('a1')), result(), lead(rev('a2')), result(), lead(impl('a3')), result(), lead(rev('a4')), result(),
      lead(call('a5', { subagent_type: 'Explore' }), call('a6', { subagent_type: 'Explore' }))]
    const st = stagesOf(agentCalls(msgs, { from: 0, to: 10, led: false }), {})
    const r = foldRepeats(st)
    expect(r.stages.map(x => x.map(c => c.agentId))).toEqual([['a1'], ['a2'], ['a5', 'a6']])
    expect(r.folded).toEqual([{ label: 'Build the slice', times: 2 }, { label: 'Review the slice', times: 2 }])
  })
  test('the default form is Roles when a skill loaded before the first agent', () => {
    expect(defaultForm([you('go'), lead(skill('redmanager')), lead(call('a1'))], { from: 0, to: 3, led: true })).toBe('roles')
    expect(defaultForm([you('go'), lead(call('a1')), lead(skill('status-board'))], { from: 0, to: 3, led: false })).toBe('lineup')
  })
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
  // Beyond the plan's tests: the rules it states but does not pin.
  test("a workflow run's agents come from records, in start order, as general-purpose, placed in stages by time", () => {
    const records = {
      w2: agent({ id: 'w2', run: 'wf_1', type: 'workflow-subagent', description: 'read:b', brief: 'Read b', startedAt: 20, endedAt: 30, model: 'claude-haiku-5-5' }),
      w1: agent({ id: 'w1', run: 'wf_1', type: 'workflow-subagent', description: 'read:a', brief: 'Read a', startedAt: 10, endedAt: 15 }),
      w9: agent({ id: 'w9', run: 'wf_other', startedAt: 5 }),
      w3: agent({ id: 'w3', run: 'wf_1', parent: 'w1', startedAt: 12 }), // w1's own: it counts only in w1's tools
    }
    // Shapes seen in Task 1: the run's result names its task, and the run's finish is a notice of that task.
    const finished: Msg = { role: 'user', text: '<task-notification>\n<task-id>ws1</task-id>\n<summary>Dynamic workflow "read" completed</summary>\n</task-notification>', toolUses: [] }
    const msgs = [you('go'), lead({ tool: 'Workflow', input: { script: 'agent(…)' }, result: { status: 'async_launched', taskId: 'ws1', runId: 'wf_1', workflowName: 'read', scriptPath: '/s.js' } }),
      result(), finished, notice('done')]
    const s = { from: 0, to: msgs.length, led: false }
    expect(runCalls(msgs, s, records).map(c => [c.agentId, c.input.subagent_type, c.input.prompt])).toEqual([['w1', 'general-purpose', 'Read a'], ['w2', 'general-purpose', 'Read b']])
    const d = readWorkflow({ msgs, records, teams: {}, list: [s], back: 0, root: '/p', lead: {} })!
    // Their script started them, not the lead message: w1 ended before w2 started, so two stages.
    expect(d.stages.map(st => st.agents.map(a => a.description))).toEqual([['read:a'], ['read:b']])
    expect(d.roles.map(r => [r.type, r.model, r.ran])).toEqual([['general-purpose', undefined, 1], ['general-purpose', 'haiku', 1]])
    expect(leadTrace(msgs, s).map(e => e.line)).toEqual(['you: "go"', 'lead started a workflow', 'a workflow finished', 'an agent finished'])
  })
  test('the trace tells one agent, a finished agent, edits, a workflow and your / command apart', () => {
    const edit = (file_path: string) => ({ tool: 'Edit', input: { file_path } })
    const msgs = [you('Fix it\n\nplease'), lead(call('a1', { subagent_type: 'Explore', model: 'haiku' }), { ...call('a9'), isError: true }), result(), notice('done'),
      lead(edit('/p/a.ts')), result(), lead(edit('/p/b.ts')), result(), lead(edit('/p/a.ts')), lead({ ...edit('/p/c.ts'), isError: true }),
      slash('redmanager'), lead(), lead({ tool: 'Bash', input: { command: '' } })]
    const t = leadTrace(msgs, { from: 0, to: msgs.length, led: false })
    expect(t.map(e => e.line)).toEqual(['you: "Fix it please"', 'lead started Explore · haiku', 'an agent finished', 'lead edited 2 files',
      'you: "/redmanager"', 'lead ran a command'])
    expect(t.map(e => e.yours)).toEqual(['Fix it\n\nplease', undefined, undefined, undefined, '/redmanager', undefined])
  })
  test('the steps left out are numbered 0, so no practice can cite them; the rest keep their numbers', () => {
    const msgs = [you('go'), ...Array.from({ length: 300 }, () => lead({ tool: 'Bash', input: { command: 'npm test' } }))]
    const t = leadTrace(msgs, { from: 0, to: msgs.length, led: false })
    expect([t[19]!.n, t[20]!.n, t[21]!.n, t[200]!.n]).toEqual([20, 0, 122, 301])
  })
  test('shared parts: whitespace evened out to compare, at most three, each as first written', () => {
    expect(sharedParts(['Rules:  keep   it\n  short.\n\nx', 'Rules: keep it short.\n\ny'])).toEqual(['Rules:  keep   it\n  short.'])
    expect(sharedParts(['a\n\nb\n\nc\n\nd', 'd\n\nc\n\nb\n\na'])).toEqual(['a', 'b', 'c'])
    expect(sharedParts(['same\n\nsame', 'other'])).toEqual([])
    expect(sharedParts(['Report: DONE', 'Report: DONE', '', '', ' '])).toEqual(['Report: DONE'])
  })
  test('commands drop paths, file arguments and quoted values', () => {
    expect(command('/usr/local/bin/node server.js')).toBe('node')
    expect(command('FOO="a b" pytest tests/ -k x')).toBe('pytest')
    expect(command('npm test\nnpm run lint')).toBe('npm test')
    expect(command('cd /p')).toBe('cd')
  })
  test("a program's first argument is never kept, unless the program has subcommands; a wrapper names the command it runs", () => {
    expect(command('echo sk_live_abc123')).toBe('echo')
    expect(command('cat notes')).toBe('cat')
    expect(command('mkdir secretdir')).toBe('mkdir')
    expect(command('grep hunter2 file')).toBe('grep')
    expect(command('sudo rm -rf build')).toBe('rm')
    expect(command('env FOO=1 npm test')).toBe('npm test')
    // A wrapper given flags stays alone: a flag's value (`-u root`) is never read as the program.
    expect(command('sudo -u root rm -rf build')).toBe('sudo')
    expect(command('time /usr/bin/git push --force')).toBe('git push')
    expect(command('npx tsc -p plugins/redhelm')).toBe('npx tsc')
    // The brief's cases still hold.
    expect(command('cd app && FOO=1 npm test -- --watch')).toBe('npm test')
    expect(command('git commit -m "token=abc"')).toBe('git commit')
    expect(command('ls -la /p')).toBe('ls')
  })
  test("readWorkflow: each agent and role gets its own team; labels cut at a word; Earlier while there is one before", () => {
    const msgs = [you('one'), lead(call('a1', { description: 'Review the whole store module' })), you('two'), lead(call('a2', { description: 'Add tests' }))]
    const list = stretches(msgs)
    const read = (back: number) => readWorkflow({ msgs, records: {}, teams: { a1: [lead(call('b1', { subagent_type: 'Explore' }))] }, list, back, root: '/Users/Shared/notes-app/', lead: {} })!
    expect([read(0).more, read(1).more]).toEqual([true, false])
    expect(read(0).stages.map(st => st.agents.map(a => a.label))).toEqual([['Add tests']])
    const d = read(1)
    expect(d.stages.map(st => st.agents.map(a => a.label))).toEqual([['Review the whole'], ['Add tests']])
    expect(d.stages[0]!.agents[0]!.team?.map(r => [r.type, r.ran])).toEqual([['Explore', 1]])
    expect(d.stages[1]!.agents[0]!.team).toBeUndefined()
    expect(d.roles.map(r => r.team?.map(t => t.type))).toEqual([['Explore']])
    expect(d).toMatchObject({ project: 'notes-app', projectKey: hash('/Users/Shared/notes-app/'), types: [], notCopied: [], evidence: [], folded: [] })
  })
  test("an agent's own conversation says what it used, as REDhelm's records count it: every call, MCP by server, skills once each in order", () => {
    const own = [you('Write docs/api.md'), lead({ tool: 'Read', input: { file_path: 'a' } }, { tool: 'Read', input: { file_path: 'b' } }), result(),
      lead({ tool: 'mcp__notes__search', input: { q: 'x' } }, { tool: 'Skill', input: { skill: 'tdd' } }),
      lead({ tool: 'Skill', input: { skill: 'tdd' } }, { tool: 'Skill', input: { skill: 'brainstorming' } }, { tool: 'toString', input: {} })]
    expect(usedIn(own)).toEqual({ tools: { Read: 2, 'mcp:notes': 1, Skill: 3, toString: 1 }, skills: ['tdd', 'brainstorming'] })
    expect(usedIn([])).toEqual({ tools: {}, skills: [] })
  })
  test("readWorkflow takes an agent's tools and skills from its record, and from its own conversation where the record holds no tools", () => {
    const msgs = [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' }), call('a3', { description: 'Review' }))]
    const records = { a1: agent({ id: 'a1', tools: { Edit: 3 }, skills: ['tdd'] }), a2: agent({ id: 'a2' }) }
    // a1's record wins; a2's holds no tools; a3 has none at all (REDhelm let it go).
    const used = { a1: { tools: { Read: 9 }, skills: [] }, a2: { tools: { Bash: 2 }, skills: ['debugging'] }, a3: { tools: { Read: 2, 'mcp:notes': 1 }, skills: ['tdd'] } }
    const d = readWorkflow({ msgs, records, teams: {}, used, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p', lead: {} })!
    expect(d.stages[0]!.agents.map(a => [a.tools, a.skills])).toEqual([[{ Edit: 3 }, ['tdd']], [{ Bash: 2 }, ['debugging']], [{ Read: 2, 'mcp:notes': 1 }, ['tdd']]])
    expect(d.roles).toHaveLength(1)
    expect(d.roles[0]).toMatchObject({ ran: 3, tools: { Edit: 3, Bash: 2, Read: 2, 'mcp:notes': 1 }, skills: ['tdd', 'debugging'] })
  })
})

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
  // Beyond the plan's tests: the rules it states but does not pin.
  test('the request gives the steps, the lead skills, the start of a script and of each brief, and how many labels and roles', () => {
    const draft = readWorkflow({ msgs: [you('go'), lead(call('a1', { prompt: `Line one\n\n${'p'.repeat(400)}` }), call('a2', { description: 'Add tests' }))],
      records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p', lead: {} })!
    const q = readingRequest({ ...draft, lead: { ...draft.lead, skills: ['redmanager'] } }, [...trace(), { n: 0, line: '… 5 earlier steps left out' }], 's'.repeat(7000))
    expect(q.system).toBe(READING_SYSTEM)
    expect(q.prompt).toContain('#1 you: "Build the store, 3 rounds of review at most"\n#2 lead started 2 × general-purpose together\n… 5 earlier steps left out\n')
    expect(q.prompt).toContain('Lead skills: redmanager')
    expect(q.prompt).toContain(`Workflow script:\n${'s'.repeat(6000)}\n`)
    expect(q.prompt).not.toContain('s'.repeat(6001))
    expect(q.prompt).toContain(`Give 2 labels, one per agent, in this order. Each label names the job the agent did, at most 16 characters; a longer one is dropped.\n`
      + `1. Write the docs — brief: Line one ${'p'.repeat(291)}\n2. Add tests — brief: Write docs/api.md`)
    expect(q.prompt).toContain('Give 1 role, one per role, in this order, each as {"label", "role"}. ')
    expect(q.prompt).toContain('A longer one is dropped.\n1. general-purpose, ran 2×, agents 1, 2')
    expect(READING_CALL).toEqual({ model: 'sonnet', effort: 'low', maxTokens: 1500, timeoutMs: 30_000 })
  })
  test('the line of steps left out is no step; a number must be one you said; one bad label falls back; nothing kept is no reading', () => {
    const t = [...trace(), { n: 0, line: '… 5 earlier steps left out' }]
    const c = (over: any) => checkReading(reply(over), t, d())!
    expect(c({ playbook: [{ when: 'Always', do: 'x', evidence: [0] }] }).playbook).toEqual([])
    expect(c({ playbook: [{ when: 'When a review fails', do: 'review again, 30 rounds at most', evidence: [1] }] }).playbook).toEqual([])
    expect(c({ playbook: [{ when: 'Always', do: 'x', evidence: [2, 2, 99] }] }).evidence).toEqual([[2]])
    expect(c({ labels: ['Docs', 'x'.repeat(17)] }).labels).toEqual(['Docs', 'Add tests'])
    expect(c({ roles: [{ label: 'Writer', role: 'x'.repeat(91) }] }).roles).toEqual([{ label: 'Writer', role: '' }])
    expect(checkReading(JSON.stringify({ name: 'x'.repeat(41), labels: [], roles: [], playbook: [] }), t, d())).toBeUndefined()
    expect(checkReading('Sorry, I cannot read this.', t, d())).toBeUndefined()
  })
  test('a number in words is a number too: it survives only when a cited prompt of yours holds it', () => {
    const p = (doing: string, evidence: number[]) => checkReading(reply({ playbook: [{ when: 'When a review fails', do: doing, evidence }] }), trace(), d())!.playbook
    expect(p('review three rounds', [2])).toEqual([])
    expect(p('review twice', [2])).toEqual([])
    expect(p('Review Three rounds', [2])).toEqual([]) // any case
    expect(p('start one reader per file', [2])).toHaveLength(1) // "one" mostly means "each"
    expect(p('review often', [2])).toHaveLength(1) // whole words: "often" holds no "ten"
    expect(p('review again, three rounds at most', [1])).toHaveLength(1) // your prompt said "3 rounds"
    expect(p('Three rounds at most, then stop', [1])).toHaveLength(1)
  })
  test('a reading without a name is named from its labels; a fallback name is cut to 40 at a word', () => {
    expect(applyReading(d(), checkReading(reply({ name: undefined }), trace(), d()), trace())).toMatchObject({ name: 'Docs, Tests', read: 'done' })
    const four = readWorkflow({ msgs: [you('go'), lead(call('a1', { description: 'Review the whole store' }), call('a2', { description: 'Check every type here' }),
      call('a3', { description: 'Write the new docs' }), call('a4', { description: 'Extra' }))], records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p', lead: {} })!
    expect(applyReading(four, undefined, []).name).toBe('Review the whole, Check every type')
  })
})

describe('labels that tell items apart', () => {
  const read = (msgs: Msg[]) => readWorkflow({ msgs, records: {}, teams: {}, list: [{ from: 0, to: msgs.length, led: false }], back: 0, root: '/p', lead: {} })!
  const t = (msgs: Msg[]) => leadTrace(msgs, { from: 0, to: msgs.length, led: false })
  test('a second and later duplicate gets " 2", " 3"…, cut so it stays within 16 characters, never a label the list already has', () => {
    expect(distinctLabels(['Describe', 'Describe', 'Review', 'Describe'])).toEqual(['Describe', 'Describe 2', 'Review', 'Describe 3'])
    expect(distinctLabels(['Describe', 'describe'])).toEqual(['Describe', 'describe 2']) // alike to read, whatever the case
    expect(distinctLabels(['Review the whole', 'Review the whole'])).toEqual(['Review the whole', 'Review the 2']) // 16: cut at a word
    expect(distinctLabels(['Parsersandlexers', 'Parsersandlexers'])).toEqual(['Parsersandlexers', 'Parsersandlexe 2']) // no word: cut hard
    expect(distinctLabels(['general-purpose', 'general-purpose'])).toEqual(['general-purpose', 'general 2']) // a hyphen ends a word
    expect(distinctLabels(Array.from({ length: 10 }, () => 'Describe the API'))[9]).toBe('Describe the 10')
    expect(distinctLabels(['A', 'A', 'A 2'])).toEqual(['A', 'A 3', 'A 2'])
    expect(distinctLabels(['Docs', 'Tests'])).toEqual(['Docs', 'Tests'])
    expect(distinctLabels([])).toEqual([])
  })
  test('the fallback labels of two agents alike are told apart, across stages; so are two roles of one type', () => {
    const msgs = [you('Explain the parser and the lexer'), lead(call('a1', { description: 'Describe parser.ts' }), call('a2', { description: 'Describe lexer.ts', model: 'opus' })),
      result(), lead(call('a3', { description: 'Describe tests.ts', subagent_type: 'Explore' }))]
    const d = read(msgs)
    expect(d.stages.map(st => st.agents.map(a => a.label))).toEqual([['Describe', 'Describe 2'], ['Describe 3']])
    expect(d.roles.map(r => r.label)).toEqual(['general-purpose', 'general 2', 'Explore'])
    const failed = applyReading(d, undefined, [])
    expect(failed.stages.flatMap(st => st.agents.map(a => a.label))).toEqual(['Describe', 'Describe 2', 'Describe 3'])
    expect(failed.roles.map(r => r.label)).toEqual(['general-purpose', 'general 2', 'Explore'])
  })
  test('labels the reading gives alike are told apart: the lineup across all its stages, the roles on their own', () => {
    const msgs = [you('Explain the parser and the lexer'), lead(call('a1', { description: 'Read parser.ts' }), call('a2', { description: 'Read lexer.ts', model: 'opus' })),
      result(), lead(call('a3', { description: 'Read both', subagent_type: 'Explore' }))]
    const d = read(msgs)
    const answer = JSON.stringify({ name: 'Read the sources', labels: ['Describe', 'Describe', 'Describe'],
      roles: [{ label: 'Reader', role: 'Reads one file' }, { label: 'Reader', role: 'Reads one file, on opus' }, { label: 'Describe', role: 'Reads both' }], playbook: [] })
    const r = applyReading(d, checkReading(answer, t(msgs), d), t(msgs))
    expect(r.stages.map(st => st.agents.map(a => a.label))).toEqual([['Describe', 'Describe 2'], ['Describe 3']])
    expect(r.roles.map(x => x.label)).toEqual(['Reader', 'Reader 2', 'Describe']) // roles are their own list
  })
})

describe('role labels from the reading', () => {
  // A Roles draft: a lead skill loaded first; two Explore readers together, then one general-purpose bug hunter.
  const msgs = [you('Explain both files, then hunt bugs'), lead(skill('redmanager')), lead(call('a1', { description: 'Describe parser.ts', subagent_type: 'Explore' }),
    call('a2', { description: 'Describe lexer.ts', subagent_type: 'Explore' })), result(), lead(call('a3', { description: 'Hunt bugs in both files' }))]
  const s = { from: 0, to: msgs.length, led: true }
  const d = () => readWorkflow({ msgs, records: {}, teams: {}, list: [s], back: 0, root: '/p', lead: {} })!
  const trace = () => leadTrace(msgs, s)
  test('a good answer names both roles', () => {
    expect(d()).toMatchObject({ form: 'roles', roles: [{ label: 'Explore', type: 'Explore', ran: 2 }, { label: 'general-purpose', ran: 1 }] })
    const answer = JSON.stringify({ name: 'Read, then hunt bugs', purpose: 'Two readers explain the files, then one hunts bugs', labels: ['Parser reader', 'Lexer reader', 'Bug hunter'],
      roles: [{ label: 'Reader', role: 'Explains one source file' }, { label: 'Bug hunter', role: 'Lists bugs across both files' }], playbook: [] })
    const r = applyReading(d(), checkReading(answer, trace(), d()), trace())
    expect(r.roles.map(x => [x.label, x.role])).toEqual([['Reader', 'Explains one source file'], ['Bug hunter', 'Lists bugs across both files']])
    expect(r.read).toBe('done')
  })
  test('a role label past 16 characters is dropped, never cut: the role keeps its type for a label, and its line', () => {
    const answer = JSON.stringify({ roles: [{ label: 'Source file reader', role: 'Explains one source file' }, { label: 'Bug hunter', role: 'Lists bugs across both files' }] })
    expect(checkReading(answer, trace(), d())!.roles).toEqual([{ label: 'Explore', role: 'Explains one source file' }, { label: 'Bug hunter', role: 'Lists bugs across both files' }])
  })
  test('the request lists each role with its count and the agents that filled it, and asks for one label and one line per role, each limit stated', () => {
    const q = readingRequest(d(), trace())
    expect(q.prompt).toContain('Agents, in order. Give 3 labels, one per agent, in this order. Each label names the job the agent did, at most 16 characters; a longer one is dropped.\n'
      + '1. Describe parser.ts — brief: Write docs/api.md\n')
    expect(q.prompt).toContain('Roles, in order. Give 2 roles, one per role, in this order, each as {"label", "role"}. '
      + 'label: a name for the job its agents did, at most 16 characters, not its type. role: one line on what they did, at most 90 characters. A longer one is dropped.\n'
      + '1. Explore, ran 2×, agents 1, 2\n2. general-purpose, ran 1×, agents 3')
  })
})

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

  // Beyond the plan's tests: the rules it states but does not pin.
  /** Two stages: Docs and Tests together, then Review; three roles; two practices with evidence and two shared parts. */
  const x = () => {
    const w = readWorkflow({ msgs: [you('go'), lead(call('a1'), call('a2', { description: 'Add tests', prompt: 'Test it', subagent_type: 'Explore' })), result(),
      lead(call('a3', { description: 'Review it', prompt: 'Review the change', model: 'opus' }))], records: {}, teams: {}, list: [{ from: 0, to: 4, led: false }], back: 0, root: '/p', lead: {} })!
    return { ...w, lead: { ...w.lead, skills: ['redmanager'], briefParts: ['Part A', 'Part B'],
      playbook: [{ when: 'When parts are independent', do: 'start them together' }, { when: 'When a check fails', do: 'send it back' }] },
      evidence: [['#2 lead started 2 agents'], ['#5 lead ran npm test']] }
  }
  const labels = (r: { stages: { agents: { label: string }[] }[] }) => r.stages.map(s => s.agents.map(a => a.label))
  const BAD = "That isn't an edit REDhelm can make"

  test('numbers mean the draft as listed, whatever ran before them; a stage left empty is dropped', () => {
    expect(labels(applyOps(x(), [{ op: 'remove', item: 0 }, { op: 'remove', item: 1 }]))).toEqual([['Review it']])
    expect(labels(applyOps(x(), [{ op: 'move', item: 2, stage: 0 }, { op: 'remove', item: 0 }]))).toEqual([['Add tests', 'Review it']])
    // A stage "new" adds takes the next number.
    expect(labels(applyOps(x(), [{ op: 'move', item: 0, stage: 'new' }, { op: 'move', item: 1, stage: 2 }]))).toEqual([['Review it'], ['Write the docs', 'Add tests']])
    expect(checkOps(x(), [{ op: 'remove', item: 1 }, { op: 'set', item: 1, field: 'label', value: 'Gone' }])).toBe('No item 2')
    // After `form`, items are the other form's.
    expect(applyOps(x(), [{ op: 'form', value: 'roles' }, { op: 'remove', item: 1 }]).roles.map(r => r.type)).toEqual(['general-purpose', 'general-purpose'])
  })

  test('practices, shared parts and lead skills; a practice you rewrite leaves its evidence behind', () => {
    const r = applyOps(x(), [{ op: 'practice', add: { when: 'When  the docs\nchange', do: 'rebuild them' }, at: 1 }, { op: 'practice', remove: 0 },
      { op: 'practice', add: { when: 'Last', do: 'appended' } }, { op: 'part', remove: 0 }, { op: 'lead', add: ['brainstorming', 'brainstorming'], remove: ['redmanager'] }])
    expect(r.lead.playbook).toEqual([{ when: 'When the docs change', do: 'rebuild them' }, { when: 'When a check fails', do: 'send it back' }, { when: 'Last', do: 'appended' }])
    expect(r.evidence).toEqual([[], ['#5 lead ran npm test'], []])
    expect(r.lead.briefParts).toEqual(['Part B'])
    expect(r.lead.skills).toEqual(['brainstorming'])
    const set = applyOps(x(), [{ op: 'practice', index: 0, set: { when: 'When work splits', do: 'start 3 together' } }])
    expect(set.lead.playbook[0]).toEqual({ when: 'When work splits', do: 'start 3 together' })
    expect(set.evidence).toEqual([[], ['#5 lead ran npm test']])
    expect(applyOps(x(), [{ op: 'practice', add: { when: 'At the end', do: 'x' }, at: 2 }]).lead.playbook[2]).toEqual({ when: 'At the end', do: 'x' })
  })

  test('each item op, in Lineup and in Roles', () => {
    const r = applyOps(x(), [{ op: 'set', item: 2, field: 'model', value: null }, { op: 'set', item: 0, field: 'isolation', value: 'worktree' },
      { op: 'set', item: 0, field: 'effort', value: 'high' }, { op: 'set', item: 0, field: 'background', value: true }, { op: 'set', item: 1, field: 'label', value: 'Tests' },
      { op: 'set', item: 1, field: 'type', value: 'store-tester' }, { op: 'brief', item: 1, append: 'Run them twice.' },
      { op: 'brief', item: 2, find: 'the', replace: '$& $1' }, { op: 'skills', item: 0, add: ['tdd'] }, { op: 'tools', item: 0, add: ['Bash', 'constructor'] },
      { op: 'add', stage: 0, item: { label: 'Lint', type: 'general-purpose', description: 'Lint it', brief: 'Run the linter', effort: 'low' } },
      { op: 'add', stage: 'new', item: { label: 'Ship', type: 'general-purpose', description: 'Ship it', brief: 'Ship' } }])
    expect(labels(r)).toEqual([['Write the docs', 'Tests', 'Lint'], ['Review it'], ['Ship']])
    const [docs, tests, lint] = r.stages[0]!.agents
    expect(docs).toMatchObject({ isolation: 'worktree', effort: 'high', background: true, skills: ['tdd'] })
    expect(Object.entries(docs!.tools)).toEqual([['Bash', 0], ['constructor', 0]]) // a tool added was never used
    expect(tests).toMatchObject({ type: 'store-tester', brief: 'Test it\n\nRun them twice.' })
    expect('model' in r.stages[1]!.agents[0]!).toBe(false)
    expect(r.stages[1]!.agents[0]!.brief).toBe('Review $& $1 change') // the replacement is text, never a pattern
    expect(lint).toEqual({ label: 'Lint', description: 'Lint it', brief: 'Run the linter', type: 'general-purpose', effort: 'low', background: false, teammate: false, tools: {}, skills: [] })
    const roles = applyOps({ ...x(), form: 'roles' }, [{ op: 'set', item: 0, field: 'role', value: 'Writes the docs' }, { op: 'remove', item: 1 },
      { op: 'skills', item: 0, add: ['a', 'b'] }, { op: 'skills', item: 0, remove: ['a'] }, { op: 'set', item: 2, field: 'teammate', value: true },
      { op: 'add', item: { label: 'Linter', type: 'general-purpose', role: 'Lints each change', model: 'haiku' } }])
    // Two roles of one type, told apart by their labels.
    expect(roles.roles.map(r => [r.label, r.role, r.skills, r.teammate])).toEqual([['general-purpose', 'Writes the docs', ['b'], false],
      ['general 2', '', [], true], ['Linter', 'Lints each change', [], false]])
    expect(roles.roles[2]).toMatchObject({ model: 'haiku', ran: 0, tools: {} })
    expect(roles.stages).toEqual(x().stages) // the other form is left as it was
  })

  test('removing an agent drops the repeats folded into it', () => {
    const f = readWorkflow({ msgs: [you('go'), lead(call('a1'), call('a2', { description: 'Add tests' })), result(), lead(call('a3', { description: 'Add tests' }))],
      records: {}, teams: {}, list: [{ from: 0, to: 4, led: false }], back: 0, root: '/p', lead: {} })!
    expect(f.folded).toEqual([{ label: 'Add tests', times: 2 }])
    expect(applyOps(f, [{ op: 'remove', item: 1 }]).folded).toEqual([])
    expect(applyOps(f, [{ op: 'remove', item: 0 }]).folded).toEqual([{ label: 'Add tests', times: 2 }])
  })

  test('every reason, in one line', () => {
    const c = (...ops: Op[]) => checkOps(x(), ops)
    const roles = (...ops: Op[]) => checkOps({ ...x(), form: 'roles' }, ops)
    expect(c({ op: 'move', item: 0, stage: 2 })).toBe('No stage 3')
    expect(c({ op: 'add', stage: 5, item: { label: 'X', type: 'general-purpose', description: 'X', brief: 'X' } })).toBe('No stage 6')
    expect(c({ op: 'practice', remove: 2 })).toBe('No practice 3')
    expect(c({ op: 'practice', index: 2, set: { when: 'a', do: 'b' } })).toBe('No practice 3')
    expect(c({ op: 'practice', add: { when: 'a', do: 'b' }, at: 3 })).toBe('No practice 4')
    expect(c({ op: 'part', remove: 0 }, { op: 'part', remove: 0 })).toBe('No shared part 1')
    expect(c({ op: 'set', item: 0, field: 'isolation', value: 'sideways' })).toBe("sideways isn't an isolation")
    expect(c({ op: 'set', item: 0, field: 'effort', value: true })).toBe("true isn't an effort")
    expect(c({ op: 'add', stage: 0, item: { label: 'X', type: 'general-purpose', description: 'X', brief: 'X', effort: 'turbo' } })).toBe("turbo isn't an effort")
    expect(c({ op: 'set', item: 0, field: 'role', value: 'Writes' })).toBe('That only applies to Roles')
    expect(c({ op: 'add', stage: 0, item: { label: 'X', type: 'general-purpose', description: 'X', brief: 'X', role: 'Writes' } })).toBe('That only applies to Roles')
    expect(roles({ op: 'brief', item: 0, append: 'x' })).toBe('That only applies to Lineup')
    expect(roles({ op: 'add', stage: 0, item: { label: 'X', type: 'general-purpose', role: 'Writes' } })).toBe('That only applies to Lineup')
    expect(c({ op: 'practice', add: { when: 'x'.repeat(121), do: 'b' } })).toBe('A practice is at most 120 characters')
    expect(c({ op: 'practice', add: { when: 'a', do: 'x'.repeat(120) } })).toBeUndefined()
    expect(c({ op: 'brief', item: 0, find: `${'long '.repeat(20)}\nfind`, replace: 'x' })).toBe(`"${'long '.repeat(12).trim()}…" isn't in that brief`)
    expect(c({ op: 'rename', name: 'x'.repeat(41) })).toBe('A name is at most 40 characters')
    expect(c({ op: 'purpose', text: 'x'.repeat(91) })).toBe('A purpose is at most 90 characters')
    expect(c({ op: 'set', item: 0, field: 'label', value: 'x'.repeat(17) })).toBe('A label is at most 16 characters')
    expect(roles({ op: 'set', item: 0, field: 'role', value: 'x'.repeat(91) })).toBe('A role is at most 90 characters')
    expect(c({ op: 'purpose', text: '' }, { op: 'set', item: 0, field: 'isolation', value: null })).toBeUndefined()
  })

  test('anything malformed is refused with a reason, never thrown, and leaves the draft as it was', () => {
    const bad: unknown[] = [null, 'rename', [], {}, { op: 'constructor' }, { op: '__proto__' }, { op: 'toString', name: 'X' }, { op: 'rename' }, { op: 'rename', name: 3 },
      { op: 'rename', name: '  ' }, { op: 'form', value: 'both' }, { op: 'set', item: 0, field: 'toString', value: 'x' }, { op: 'set', item: '0', field: 'model', value: 'x' },
      { op: 'set', item: 0, field: 'background', value: 'yes' }, { op: 'set', item: 0, field: 'label', value: null }, { op: 'remove', item: -1 }, { op: 'remove', item: 1.5 },
      { op: 'remove' }, { op: 'move', item: 0, stage: 'next' }, { op: 'practice', add: { when: 'a', do: 'b' }, remove: 0 }, { op: 'practice', add: 'When x, do y' },
      { op: 'practice', index: 0 }, { op: 'practice', add: { when: 'a', do: 'b' }, at: -1 }, { op: 'part' }, { op: 'brief', item: 0, find: 'Write', replace: 'b', append: 'c' },
      { op: 'brief', item: 0, find: '', replace: 'x' }, { op: 'brief', item: 0, find: 'Write' }, { op: 'brief', item: 0 }, { op: 'lead', add: 'x' }, { op: 'lead', remove: [''] },
      { op: 'skills', item: 0, add: [1] }, { op: 'tools', item: 0, remove: {} }, { op: 'add', stage: 'new', item: { label: 'X', type: 'general-purpose', description: 'd' } },
      { op: 'add', item: { label: 'X', type: 'general-purpose', description: 'd', brief: 'b' } }, { op: 'add', stage: 'new' }, { op: 'add', stage: 'new', item: [] }]
    for (const op of bad) {
      const before = x()
      expect([op, checkOps(before, [op as Op])]).toEqual([op, BAD])
      expect(applyOps(before, [{ op: 'rename', name: 'Changed' }, op as Op])).toBe(before)
    }
    expect(checkOps(x(), 'ops' as any)).toBe(BAD)
    expect(checkOps({ ...x(), form: 'roles' }, [{ op: 'add', item: { label: 'X', type: 'general-purpose' } } as any])).toBe(BAD) // Roles needs a role
  })

  test('the draft you pass is never changed', () => {
    const deepFreeze = (o: any): any => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }
    const all: Op[] = [{ op: 'rename', name: 'New' }, { op: 'purpose', text: 'New purpose' }, { op: 'lead', add: ['tdd'], remove: ['redmanager'] },
      { op: 'practice', add: { when: 'a', do: 'b' }, at: 0 }, { op: 'practice', remove: 1 }, { op: 'practice', index: 0, set: { when: 'c', do: 'd' } }, { op: 'part', remove: 1 },
      { op: 'set', item: 0, field: 'model', value: 'opus' }, { op: 'set', item: 2, field: 'model', value: null }, { op: 'brief', item: 0, find: 'docs', replace: 'guide' },
      { op: 'brief', item: 1, append: 'More' }, { op: 'skills', item: 0, add: ['s'] }, { op: 'tools', item: 1, add: ['Bash'] }, { op: 'move', item: 0, stage: 'new' },
      { op: 'add', stage: 0, item: { label: 'L', type: 'general-purpose', description: 'L', brief: 'L' } }, { op: 'remove', item: 1 },
      { op: 'form', value: 'roles' }, { op: 'set', item: 0, field: 'role', value: 'Writes' }, { op: 'skills', item: 0, add: ['r'] }, { op: 'tools', item: 0, remove: ['Read'] },
      { op: 'add', item: { label: 'R', type: 'Explore', role: 'Looks' } }, { op: 'remove', item: 2 }]
    const before = x()
    const seen = JSON.stringify(before)
    const r = applyOps(deepFreeze(before), all)
    expect(JSON.stringify(before)).toBe(seen)
    expect(r).not.toBe(before)
    expect(r.name).toBe('New')
    expect(r.roles.map(role => role.label)).toEqual(['general-purpose', 'Explore', 'R'])
  })

  test('the request lists both forms numbered as the sheet numbers them, with what an op names each by', () => {
    const w = x()
    const long = { ...w, name: 'Docs', stages: [{ agents: [{ ...w.stages[0]!.agents[0]!, brief: `Line one\n${'p'.repeat(400)}`, effort: 'low', skills: ['tdd'], tools: { Read: 3 } }] }, ...w.stages.slice(1)] }
    const q = editRequest(long, '  drop the review  ')
    expect(q.system).toBe(EDIT_SYSTEM)
    expect(q.prompt).toContain('Name: "Docs"\nPurpose: none\nForm: lineup\nLead skills: redmanager\n')
    expect(q.prompt).toContain('Practices:\n1. [0] when "When parts are independent", do "start them together"\n2. [1] when "When a check fails", do "send it back"\n')
    expect(q.prompt).toContain('Shared brief parts:\n1. [0] "Part A"\n2. [1] "Part B"\n')
    expect(q.prompt).toContain(`Stage 1 [0]:\n1. [0] Write the docs · general-purpose · effort low · skills tdd · tools Read · description "Write the docs" · brief ${JSON.stringify(`Line one\n${'p'.repeat(400)}`)}\n`)
    expect(q.prompt).toContain('Stage 2 [1]:\n2. [1] Review it · general-purpose · model opus · description "Review it" · brief "Review the change"\n')
    expect(q.prompt).toContain('Roles, the items while the form is roles:\n1. [0] general-purpose · general-purpose · ran 1 time · role ""\n2. [1] Explore · Explore · ran 1 time · role ""\n')
    expect(q.prompt.endsWith('\n\nThe change asked for: drop the review')).toBe(true)
    expect(editRequest({ ...w, lead: { ...w.lead, skills: [], playbook: [], briefParts: [] }, evidence: [] }, 'x').prompt).toContain('Lead skills: none\nPractices: none\nShared brief parts: none\n')
    for (const op of ['rename', 'purpose', 'form', 'lead', 'practice', 'part', 'remove', 'move', 'set', 'brief', 'skills" | "tools', 'add']) expect(EDIT_SYSTEM).toContain(`"op": "${op}"`)
    expect(EDIT_SYSTEM).toContain('{"cannot": "')
    expect(EDIT_CALL).toEqual({ model: 'sonnet', effort: 'low', maxTokens: 1200, timeoutMs: 30_000 })
  })

  test('the edit call gets each brief and shared part whole, up to 6,000 characters, so a find can quote any of it', () => {
    const w = x()
    const withBrief = (brief: string, part = 'Part A') =>
      editRequest({ ...w, lead: { ...w.lead, briefParts: [part] }, stages: [{ agents: [{ ...w.stages[0]!.agents[0]!, brief }] }] }, 'x').prompt
    const thousand = `Start ${'a'.repeat(989)} end.`
    expect(thousand).toHaveLength(1000)
    expect(withBrief(thousand)).toContain(`brief ${JSON.stringify(thousand)}\n`)
    const seven = 'b'.repeat(7000)
    expect(withBrief(seven)).toContain(`brief ${JSON.stringify('b'.repeat(6000))} … cut\n`)
    expect(withBrief(seven)).not.toContain('b'.repeat(6001))
    expect(withBrief('x', 'c'.repeat(7000))).toContain(`Shared brief parts:\n1. [0] ${JSON.stringify('c'.repeat(6000))} … cut\n`)
    expect(withBrief('b'.repeat(6000))).toContain(`brief ${JSON.stringify('b'.repeat(6000))}\n`) // exactly 6,000 is whole
    expect(editRequest(w, `append ${'z'.repeat(7000)}`).prompt.endsWith(`The change asked for: append ${'z'.repeat(7000)}`)).toBe(true) // your ask stays whole
  })

  test('an answer is the JSON object in it: fenced or prefaced still parses; anything else is no answer', () => {
    expect(parseEdit('Here you go:\n```json\n{"ops": [{"op": "remove", "item": 2}]}\n```')).toEqual({ ops: [{ op: 'remove', item: 2 }] })
    expect(parseEdit('{"ops": [], "cannot": "  There is no reviewer  "}')).toEqual({ cannot: 'There is no reviewer' })
    expect(parseEdit('{"ops": []}')).toEqual({ ops: [] })
    for (const t of [undefined, '', '[{"op": "rename", "name": "X"}]', '"ops"', '{}', '{"ops": [1]}', '{"ops": [null]}', '{"ops": "rename"}', '{"cannot": ""}', '{"cannot": 3}', '{"ops": [{"op": "rename"']) {
      expect([t, parseEdit(t)]).toEqual([t, undefined])
    }
  })
})

/** The least a saved workflow, a role and a lineup agent need. */
const emptySaved: SavedWorkflow = { version: 1, id: 'empty', name: 'Empty', purpose: '', savedAt: 0, project: 'notes-app', projectKey: 'k0',
  lead: { skills: [], playbook: [], briefParts: [] }, form: 'lineup', roles: [], stages: [], types: [] }
const role: SavedRole = { label: 'Writer', role: '', type: 'general-purpose', background: false, teammate: false, tools: {}, skills: [], ran: 1 }
const savedAgent: SavedAgent = { label: 'Agent', description: '', brief: '', type: 'general-purpose', background: false, teammate: false, tools: {}, skills: [] }

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
  test("Run's question: each reason's words, in order, none in a fresh session; a skill this session has is never missing", () => {
    const none = { busy: 0, prompts: 0, other: false, missing: [] }
    expect(runReasons(none)).toBe('')
    expect(runReasons({ busy: 1, prompts: 1, other: true, missing: ['tdd'] })).toBe('1 agent busy · 1 prompt · other project · tdd missing')
    expect(runReasons({ ...none, busy: 2, prompts: 9, missing: ['tdd', 'ship'] })).toBe('2 agents busy · 9 prompts · 2 skills missing')
    expect(runReasons({ ...none, other: true, missing: ['ship'] })).toBe('other project · ship missing')
    // A `/` command (a skill run by hand too) and an agent's notice are no prompts you typed.
    expect(typedPrompts(FRESH)).toBe(0)
    expect(typedPrompts([slash('redhelm'), you('Fix the login'), notice('done'), lead(call('a1')), slash('redmanager'), you('And the tests')])).toBe(2)
    // Claude Code lists a plugin's skill as `<plugin>:<skill>` and some of yours bare; the lead may have named either.
    expect(missingSkills(['tdd', 'kit:tdd', 'redmanager', 'tools:docx', 'other:tdd', 'ship'], ['kit:tdd', 'redmanager', 'docx'])).toEqual(['other:tdd', 'ship'])
  })
  test('the run text and each plan shape', () => {
    expect(runText('Build: phase two', '', 'The plan.')).toBe('Run my saved REDhelm workflow "Build: phase two".\n\nThe plan.')
    expect(runText('Docs', 'only src/store.js', 'The plan.')).toBe('Run my saved REDhelm workflow "Docs". My notes for this run: only src/store.js\n\nThe plan.')
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

  // Beyond the plan's tests: the rules it states but does not pin.
  test('a slug is ASCII words, cut at a word to 48 characters; a name with none gets its hash', () => {
    expect(slug('  Build: phase two!  ')).toBe('build-phase-two')
    expect(slug('Café crème')).toBe('cafe-creme')
    expect(slug("Don't panic")).toBe('dont-panic')
    expect(slug('Ｔｅｓｔｓ')).toBe('tests')
    expect(slug('word '.repeat(20))).toBe(Array(9).fill('word').join('-')) // 44 characters; a tenth word would pass 48
    expect(slug('a'.repeat(60))).toBe('a'.repeat(48))
    for (const none of ['', '---', 'Тесты ✓']) expect(slug(none)).toBe(`workflow-${hash(none)}`)
    expect(slug('Тесты ✓')).not.toBe(slug('Другое'))
    expect(uniqueName('Tests', [])).toBe('Tests')
    expect(uniqueName('Tests', ['Tests 2'])).toBe('Tests')
    expect(uniqueName('Tests', ['Tests', 'Tests 3'])).toBe('Tests 2')
  })

  /** A draft with both forms, a team, copied types and every transient field set. */
  const draft = (): Draft => {
    const d = readWorkflow({ msgs: [you('go'), lead(call('a1'))], records: {}, teams: {}, list: [{ from: 0, to: 2, led: false }], back: 0, root: '/p/notes-app', lead: { model: 'opus' } })!
    const def = (name: string, body = 'You work.') => ({ name, definition: `---\nname: ${name}\ndescription: Works\n---\n${body}` })
    return { ...d, name: 'Docs', purpose: 'Docs, then a review',
      lead: { ...d.lead, skills: ['redmanager'], playbook: [{ when: 'When parts are independent', do: 'start them together' }], briefParts: ['Never push.'] },
      stages: [{ agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', tools: { Read: 2 }, skills: ['tdd'], team: [{ ...role, type: 'store-writer' }] }] }, { agents: [] }],
      roles: [{ ...role, type: 'store-tester', tools: { Bash: 1 } }],
      types: [def('store-reviewer'), def('store-tester'), def('store-writer'), def('store-reviewer', 'A second copy.'), def('unused')],
      folded: [{ label: 'Review', times: 2 }], notCopied: ['store-linter'], evidence: [['#1 you: "go"']], read: 'done', back: 0, more: false }
  }

  test("a saved file holds the saved fields only, the types its form still uses, and nothing it shares with the draft", () => {
    const d = draft()
    const w = toSaved(d, 7, 'docs')
    expect(Object.keys(w).sort()).toEqual(['form', 'id', 'lead', 'name', 'project', 'projectKey', 'purpose', 'roles', 'savedAt', 'stages', 'types', 'version'])
    expect(w).toMatchObject({ project: 'notes-app', form: 'lineup', roles: [], lead: { model: 'opus' } })
    expect(w.stages).toHaveLength(1) // the empty stage is dropped
    expect(w.types.map(t => [t.name, t.definition.endsWith('You work.')])).toEqual([['store-reviewer', true], ['store-writer', true]]) // a team's type is used too; once each
    expect(toSaved({ ...d, form: 'roles' }, 7, 'docs').types.map(t => t.name)).toEqual(['store-tester'])
    expect(toSaved({ ...d, stages: [] }, 7, 'docs').types).toEqual([]) // an edit removed the last agent of each type
    const objects = (o: unknown, into = new Set<unknown>()) => {
      if (o && typeof o === 'object') { into.add(o); Object.values(o).forEach(v => objects(v, into)) }
      return into
    }
    for (const form of ['roles', 'lineup'] as const) {
      const fresh = toSaved({ ...d, form }, 7, 'docs')
      const theirs = objects({ ...d, form })
      expect([...objects(fresh)].filter(o => theirs.has(o))).toEqual([])
      expect(parseSaved(JSON.stringify(fresh))).toEqual(fresh)
    }
  })

  const full: SavedWorkflow = { ...emptySaved, id: 'full', name: 'Full', purpose: 'All of it', savedAt: 9, form: 'roles',
    lead: { skills: ['redmanager'], playbook: [{ when: 'When x', do: 'do y' }], briefParts: ['Part'], model: 'opus', effort: 'high' },
    roles: [{ ...role, model: 'sonnet', effort: 'low', isolation: 'worktree', background: true, tools: { Read: 2, Edit: 0 }, skills: ['tdd'], team: [{ ...role }] }],
    stages: [{ agents: [{ ...savedAgent, name: 'docs', model: 'haiku', isolation: 'remote', teammate: true, team: [{ ...role }] }] }],
    types: [{ name: 'store-reviewer', definition: '---\nname: store-reviewer\n---\n' }] }

  test('a saved file is read only when every field has its shape; unknown fields are dropped', () => {
    expect(parseSaved(JSON.stringify(full))).toEqual(full)
    expect(parseSaved(`\uFEFF${JSON.stringify(full)}`)).toEqual(full)
    const changed = (change: (o: any) => void) => {
      const o = JSON.parse(JSON.stringify(full))
      change(o)
      return JSON.stringify(o)
    }
    expect(parseSaved(changed(o => { o.extra = 1; o.lead.extra = 2; o.roles[0].extra = 3; o.stages[0].extra = 4; o.stages[0].agents[0].extra = 5; o.types[0].extra = 6 }))).toEqual(full)
    expect(parseSaved(changed(o => { o.lead.model = null; o.roles[0].isolation = null; o.roles[0].team = null }))).toEqual({
      ...full, lead: { skills: ['redmanager'], playbook: [{ when: 'When x', do: 'do y' }], briefParts: ['Part'], effort: 'high' },
      roles: [{ ...role, model: 'sonnet', effort: 'low', background: true, tools: { Read: 2, Edit: 0 }, skills: ['tdd'] }] })
    const bad: ((o: any) => void)[] = [
      o => { o.version = 2 }, o => { o.version = '1' }, o => { delete o.version }, o => { o.id = '' }, o => { o.id = '../../x' }, o => { o.id = 'a\\b' }, o => { o.id = 3 },
      o => { o.name = '' }, o => { o.name = 3 }, o => { o.purpose = null }, o => { o.savedAt = '5' }, o => { o.project = 3 }, o => { delete o.projectKey },
      o => { o.lead = [] }, o => { o.lead.skills = 'redmanager' }, o => { o.lead.playbook = [{ when: 'x' }] }, o => { o.lead.briefParts = [1] }, o => { o.lead.effort = 3 },
      o => { o.form = 'both' }, o => { o.roles = {} }, o => { o.roles = [null] }, o => { o.roles[0].ran = -1 }, o => { o.roles[0].ran = 1.5 }, o => { delete o.roles[0].role },
      o => { o.roles[0].tools = { Read: '2' } }, o => { o.roles[0].tools = ['Read'] }, o => { o.roles[0].tools = { Read: -1 } }, o => { o.roles[0].skills = 'tdd' },
      o => { o.roles[0].isolation = 'sideways' }, o => { o.roles[0].background = 'yes' }, o => { o.roles[0].type = '' }, o => { o.roles[0].model = 4 },
      o => { o.roles[0].team = [{ ...role, team: [role] }] }, o => { o.roles[0].team = role }, o => { o.stages = [{}] }, o => { o.stages = [{ agents: 'x' }] },
      o => { o.stages[0].agents[0].brief = 3 }, o => { delete o.stages[0].agents[0].description }, o => { o.stages[0].agents[0].name = 7 }, o => { o.stages[0].agents[0].teammate = 1 },
      o => { o.types = [{ name: 'x' }] }, o => { o.types = [{ name: '', definition: '' }] }, o => { o.types = 'store-reviewer' },
    ]
    for (const change of bad) {
      const text = changed(change)
      expect([text, parseSaved(text)]).toEqual([text, undefined])
    }
    for (const text of ['', 'not json', '{', '[]', 'null', '1', '"x"', '{}', `[${JSON.stringify(full)}]`, `{"__proto__": ${JSON.stringify(full)}}`, '['.repeat(100_000)]) {
      expect([text.slice(0, 40), parseSaved(text)]).toEqual([text.slice(0, 40), undefined])
    }
  })

  test("a listed workflow's id is its file's name; files that are not .json or are blank are passed over", () => {
    const mk = (id: string, savedAt: number, key = 'k') => JSON.stringify({ ...emptySaved, id, name: id, savedAt, projectKey: key })
    const r = listed([{ name: 'notes.txt', text: mk('notes', 5) }, { name: 'blank.json', text: '  \n' }, { name: 'renamed.json', text: mk('original', 2) },
      { name: 'z.json', text: mk('z', 2) }, { name: 'newer.json', text: JSON.stringify({ ...emptySaved, version: 2 }) }, { name: 'list.json', text: '[]' }], 'k')
    expect(r.workflows.map(w => [w.id, w.name])).toEqual([['renamed', 'original'], ['z', 'z']]) // the same time: by id
    expect(r.unreadable).toBe(2)
    expect(listed([], 'k')).toEqual({ workflows: [], unreadable: 0 })
  })

  test('notes are trimmed, and blank notes are none', () => {
    expect(runText('Docs', '  \n ', 'The plan.')).toBe('Run my saved REDhelm workflow "Docs".\n\nThe plan.')
    expect(runText('Docs', ' only the store \n', 'The plan.')).toBe('Run my saved REDhelm workflow "Docs". My notes for this run: only the store\n\nThe plan.')
  })

  const NOT_THEIRS = "It is not one of Claude Code's saved workflows, so don't look it up by name: start the agents below with the Agent tool, or write a Workflow script from them."
  const OPENING = 'It is how this kind of work was led and staffed before: start from it, and fit it to this problem and to my notes. It fixes no loops, rounds or checks; choose those for this problem. If an agent type or skill is not available here, go without it and say so.'

  test("right after its first line, the plan says it is not one of Claude Code's saved workflows, so Claude never looks it up by name", () => {
    const plan = planText({ ...emptySaved, name: 'Notes review', form: 'lineup', stages: [{ agents: [{ ...savedAgent, label: 'Docs' }] }] }, {}, {})
    expect(plan.split('\n').slice(0, 3)).toEqual(['Saved REDhelm workflow "Notes review".',
      "It is not one of Claude Code's saved workflows, so don't look it up by name: start the agents below with the Agent tool, or write a Workflow script from them.", OPENING])
  })

  test('the Roles plan, whole', () => {
    const w: SavedWorkflow = { ...emptySaved, name: 'Build, check, review', purpose: 'Parallel implementers, then your checks and a separate review', form: 'roles',
      lead: { skills: ['redmanager', 'tdd'], playbook: [{ when: 'When the work splits cleanly,', do: 'start implementers together, each in its own worktree' },
        { when: 'When an implementer reports done', do: 'run the checks yourself before moving on.' }], briefParts: ['End with STATUS: DONE or BLOCKED.', 'Never push.'] },
      roles: [
        { ...role, label: 'Implementer', role: 'Builds one slice in its own worktree', model: 'opus', isolation: 'worktree', background: true,
          tools: { Read: 3, Edit: 9, Bash: 5 }, ran: 7, team: [{ ...role, label: 'Writer', model: 'sonnet', ran: 3 }, { ...role, label: 'Scout', type: 'store-scout' }] },
        { ...role, label: 'Reviewer', role: 'API checks', type: 'store-reviewer', model: 'sonnet', effort: 'high', teammate: true, tools: { Read: 4, Grep: 0 }, skills: ['code-review'] },
        { ...role, label: 'Linter', ran: 0, tools: { Bash: 0 } }, // added by an edit: it has not run
      ],
      stages: [{ agents: [{ ...savedAgent, label: 'Not in Roles' }] }] }
    expect(planText(w, { 'store-reviewer': 'redhelm:store-reviewer', 'store-scout': 'general-purpose' }, { 'store-reviewer': ['permissionMode', 'hooks'] })).toBe([
      'Saved REDhelm workflow "Build, check, review": Parallel implementers, then your checks and a separate review.',
      NOT_THEIRS,
      OPENING,
      '',
      'Lead: use the redmanager and tdd skills to run this.',
      '',
      'How the lead worked last time. Use the practices that fit this problem:',
      '1. When the work splits cleanly, start implementers together, each in its own worktree.',
      '2. When an implementer reports done, run the checks yourself before moving on.',
      '',
      "Every agent's brief should include:",
      'End with STATUS: DONE or BLOCKED.',
      '',
      'Never push.',
      '',
      'Staff it with these roles, as many of each as the work needs:',
      '- Implementer: Builds one slice in its own worktree. subagent_type general-purpose, model opus, isolation worktree, background. Tools it used: Edit, Bash, Read. Skills: none. Ran 7 times.',
      '  It started its own team: Writer (general-purpose, sonnet, ran 3 times), Scout (general-purpose, ran once; store-scout could not be added here). Ask it to staff its work that way.',
      '- Reviewer: API checks. subagent_type redhelm:store-reviewer (its hooks and permission mode stayed behind), model sonnet, effort high, teammate. Tools it used: Read. Also give it: Grep. Skills: code-review. Ran once.',
      '- Linter: subagent_type general-purpose. Tools it used: none. Also give it: Bash. Skills: none.',
    ].join('\n'))
    expect(planText({ ...w, lead: { skills: ['a', 'b', 'c'], playbook: [], briefParts: [] }, roles: [] }, {}, {})).toBe(
      `Saved REDhelm workflow "Build, check, review": Parallel implementers, then your checks and a separate review.\n${NOT_THEIRS}\n${OPENING}\n\nLead: use the a, b and c skills to run this.`)
  })

  test('the Lineup plan, whole', () => {
    const w: SavedWorkflow = { ...emptySaved, name: 'Docs, then a review', form: 'lineup', lead: { skills: [], playbook: [], briefParts: ['Never push.'] },
      roles: [{ ...role, label: 'Not in Lineup' }],
      stages: [
        { agents: [{ ...savedAgent, label: 'Docs', name: 'docs', model: 'sonnet', effort: 'medium', background: true, tools: { Edit: 5, Read: 9, Bash: 0 },
          brief: '\nWrite the docs.\n\n  Keep the examples.\nNever push.\n\n' }, { ...savedAgent, label: 'Tests', brief: 'Add tests' }] },
        { agents: [] },
        { agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', skills: ['code-review'], team: [{ ...role, label: 'Checker', type: 'Explore', model: 'haiku', ran: 2 }],
          brief: 'Review the change' }, { ...savedAgent, label: 'Lint', type: 'store-linter', brief: 'Lint it' }] },
      ] }
    expect(planText(w, { 'store-reviewer': 'redhelm:store-reviewer', 'store-linter': 'general-purpose' },
      { 'store-reviewer': ['hooks', 'mcpServers', 'permissionMode'], 'store-linter': ['hooks'] })).toBe([
      'Saved REDhelm workflow "Docs, then a review".',
      NOT_THEIRS,
      OPENING,
      '',
      'Stage 1, start together:',
      '- Docs: subagent_type general-purpose, name docs, model sonnet, effort medium, background',
      '  Tools it used: Read 9, Edit 5. Also give it: Bash. Skills it used: none.',
      '  Brief:',
      '  Write the docs.',
      '',
      '    Keep the examples.',
      '  Never push.',
      '- Tests: subagent_type general-purpose',
      '  Tools it used: none. Skills it used: none.',
      '  Brief:',
      '  Add tests',
      'Stage 2, after stage 1 finishes:',
      '- Review: subagent_type redhelm:store-reviewer (its hooks, MCP servers and permission mode stayed behind)',
      '  Tools it used: none. Skills it used: code-review.',
      '  It started its own team: Checker (Explore, haiku, ran 2 times). Ask it to staff its work that way.',
      '  Brief:',
      '  Review the change',
      '- Lint: subagent_type general-purpose (store-linter could not be added here)',
      '  Tools it used: none. Skills it used: none.',
      '  Brief:',
      '  Lint it',
    ].join('\n'))
  })

  test('a tool you added with ✎ never ran: the plan still asks for it, after the tools that did', () => {
    const lineup = (tools: Record<string, number>) => planText({ ...emptySaved, form: 'lineup', stages: [{ agents: [{ ...savedAgent, tools }] }] }, {}, {})
    const roles = (tools: Record<string, number>) => planText({ ...emptySaved, form: 'roles', roles: [{ ...role, tools }] }, {}, {})
    expect(lineup({ Read: 2, WebFetch: 0 })).toContain('\n  Tools it used: Read 2. Also give it: WebFetch. Skills it used: none.')
    expect(lineup({ WebFetch: 0, Grep: 0 })).toContain('\n  Tools it used: none. Also give it: WebFetch, Grep. Skills it used: none.')
    // A role names its tools without counts, as spec §8 does.
    expect(roles({ Read: 2, WebFetch: 0 })).toContain(' Tools it used: Read. Also give it: WebFetch. Skills: none.')
    expect(roles({ WebFetch: 0 })).toContain(' Tools it used: none. Also give it: WebFetch. Skills: none.')
    expect(lineup({ Read: 2 })).not.toContain('Also give it')
    expect(roles({})).not.toContain('Also give it')
  })

  test('an agent file in each YAML form it may take', () => {
    const file = [
      '---', 'name: "store-builder"', 'description: >', '  Builds the store,', '  one slice at a time', 'tools:', '  - Read', "  - 'Edit'",
      'disallowedTools: [Bash(rm:*), WebFetch]', 'skills: tdd, brainstorming  # both', 'model: opus', 'effort: high', 'maxTurns: 30',
      'initialPrompt: |', '  Read the plan first.', '  Then build.', 'memory: project', 'background: true', 'isolation: worktree', 'color: blue', '# a comment',
      '---', '', 'You build the store.', '', 'One slice at a time.', '',
    ].join('\r\n')
    expect(typeName(file)).toBe('store-builder')
    expect(agentSpec(file)).toEqual({ leftBehind: [], spec: { name: 'store-builder', description: 'Builds the store, one slice at a time',
      prompt: 'You build the store.\n\nOne slice at a time.', tools: ['Read', 'Edit'], disallowedTools: ['Bash(rm:*)', 'WebFetch'], skills: ['tdd', 'brainstorming'],
      model: 'opus', effort: 'high', maxTurns: 30, initialPrompt: 'Read the plan first.\nThen build.', memory: 'project', background: true, isolation: 'worktree' } })
    const more = '---\nname: a\ndescription: Does\n  more than one line\ntools:\n- Read\n- Bash(git add:*, git commit:*)\nskills: []\nbackground: false\n---\nBody'
    expect(agentSpec(more)).toEqual({ leftBehind: [], spec: { name: 'a', description: 'Does more than one line', prompt: 'Body', tools: ['Read', 'Bash(git add:*, git commit:*)'], skills: [] } })
  })

  test("an indented block is its key's value: never read as keys of its own", () => {
    const file = '---\nname: store-reviewer\ndescription: Reviews\nhooks:\n  name: other\n  tools: Bash\n  PreToolUse:\n    - command: echo hi\nmcpServers:\n  notes:\n    command: echo notes\n---\nBody'
    expect(typeName(file)).toBe('store-reviewer')
    expect(agentSpec(file)).toEqual({ spec: { name: 'store-reviewer', description: 'Reviews', prompt: 'Body' }, leftBehind: ['hooks', 'mcpServers'] })
    expect(agentSpec('---\nname: a\ndescription: b\npermissionMode: plan\n---\n')).toEqual({ spec: { name: 'a', description: 'b', prompt: '' }, leftBehind: ['permissionMode'] })
  })

  test('an agent file REDhelm cannot carry as written says why, never carries less than it asks', () => {
    const fm = (...lines: string[]) => `---\nname: a\ndescription: b\n${lines.join('\n')}\n---\nBody`
    const cases: [string, string][] = [
      ['---\nname: a\ndescription: b\nBody', 'The front matter never ends'],
      ['\n---\nname: a\n---\n', 'No front matter'],
      ['---\ndescription: b\n---\n', 'No name'],
      ['---\nname: a\n---\n', 'No description'],
      ['---\nname: ""\ndescription: b\n---\n', 'No name'],
      [fm('tools:', '  Read: yes'), "tools isn't a list"],
      [fm('tools: Read', '  - Grep'), "tools isn't a list"],
      [fm('tools: {Read: 1}'), "tools isn't a list"],
      [fm('tools: [Read'), "tools isn't a list"],
      [fm('model: [opus]'), "model isn't text"],
      [fm('initialPrompt:', '  - one'), "initialPrompt isn't text"],
      [fm('maxTurns: lots'), "maxTurns isn't a whole number"],
      [fm('maxTurns: 0'), "maxTurns isn't a whole number"],
      [fm('memory: global'), "memory isn't user, project or local"],
      [fm('isolation: sideways'), "isolation isn't worktree or remote"],
      [fm('background: maybe'), "background isn't true or false"],
      [fm('just words'), "Front matter line 4 isn't key: value"],
      [fm('tools:Read'), "Front matter line 4 isn't key: value"],
      ['---\n  name: a\n---\n', "Front matter line 2 isn't key: value"],
      [fm('tools: Read', 'tools: Bash'), 'tools is set twice'],
    ]
    for (const [file, error] of cases) expect([file, agentSpec(file)]).toEqual([file, { error }])
    expect(agentSpec(fm('color: blue', 'color: red')).hasOwnProperty('spec')).toBe(true) // a key it never reads may repeat
    expect(typeName(fm('just words'))).toBe('a') // finding a file by its name is never stricter than that
    expect(typeName('---\ndescription: b\n---\n')).toBeUndefined()
    expect(typeName('no frontmatter')).toBeUndefined()
    expect(typeName("---\nname: 'it''s'  # quoted\n---\n")).toBe("it's")
  })

  test('a block scalar, text after a closing quote or an empty list is never read as tool names', () => {
    const fm = (...lines: string[]) => `---\nname: a\ndescription: b\n${lines.join('\n')}\n---\nBody`
    const cases: [string, string][] = [
      [fm('tools: |', '  Read', '  Grep'), "tools isn't a list"],
      [fm('tools: >', '  Read, Grep'), "tools isn't a list"],
      [fm('tools: "Read" Grep'), "tools isn't a list"],
      [fm('disallowedTools: >', '  Bash'), "disallowedTools isn't a list"], // a denial lost would leave the agent Bash
      [fm('tools:', '  - "Read" Grep'), "tools isn't a list"],
      [fm('tools: ["Read" Grep]'), "tools isn't a list"],
      [fm('model: "opus" sonnet'), "model isn't text"],
      [fm('tools: []'), 'tools is empty'],
      [fm('disallowedTools: []'), 'disallowedTools is empty'],
      [fm('tools: ""'), 'tools is empty'],
    ]
    for (const [file, error] of cases) expect([file, agentSpec(file)]).toEqual([file, { error }])
    expect(agentSpec(fm('tools: "Read"  # just that'))).toMatchObject({ spec: { tools: ['Read'] } }) // a comment after the quote is no text
  })

  test('a YAML anchor, alias or tag is never read as a name: the type may not use what its own file denies', () => {
    const fm = (...lines: string[]) => `---\nname: a\ndescription: b\n${lines.join('\n')}\n---\nBody`
    const cases: [string, string][] = [
      [fm('disallowedTools: &deny Bash'), "disallowedTools isn't a list"],
      [fm('x-deny: &d [Bash]', 'disallowedTools: *d'), "disallowedTools isn't a list"],
      [fm('tools: !!str Read'), "tools isn't a list"],
      [fm('disallowedTools:', '  - &b Bash'), "disallowedTools isn't a list"],
      [fm('disallowedTools: [Edit, *b]'), "disallowedTools isn't a list"],
      [fm('tools: Read, !!str Bash'), "tools isn't a list"],
      [fm('model: *m'), "model isn't text"],
      [fm('model: !!str opus'), "model isn't text"],
      ['---\nname: &n a\ndescription: b\n---\n', "name isn't text"],
    ]
    for (const [file, error] of cases) expect([file, agentSpec(file)]).toEqual([file, { error }])
    expect(typeName('---\nname: &n a\ndescription: b\n---\n')).toBeUndefined()
    // Quoted, or inside a value, the marks are only text.
    expect(agentSpec(fm('model: "*m"', 'disallowedTools: ["&deny"]', 'initialPrompt: Use Bash & Read!'))).toMatchObject({ spec: { model: '*m', disallowedTools: ['&deny'], initialPrompt: 'Use Bash & Read!' } })
  })

  test('a value or item that opens with any YAML indicator plain text cannot open with is no text either', () => {
    const fm = (...lines: string[]) => `---\nname: a\ndescription: b\n${lines.join('\n')}\n---\nBody`
    const cases: [string, string][] = [
      [fm('disallowedTools: - Bash'), "disallowedTools isn't a list"], // a sequence on the key's line: Bash was never denied as written
      [fm('disallowedTools: Edit, - Bash'), "disallowedTools isn't a list"],
      [fm('disallowedTools:', '  - - Bash'), "disallowedTools isn't a list"],
      [fm('tools: @Read'), "tools isn't a list"],
      ['---\nname: a\ndescription: %x\n---\n', "description isn't text"],
      [fm('model: ?opus'), "model isn't text"],
      [fm('tools: `Read`'), "tools isn't a list"],
      [fm('tools: ,Read'), "tools isn't a list"],
      [fm('tools: Read, |Grep'), "tools isn't a list"],
      [fm('tools: Read, >Grep'), "tools isn't a list"],
      [fm('tools: Read, {Grep}'), "tools isn't a list"],
      [fm('tools: [[Read]]'), "tools isn't a list"],
      [fm('tools: ]Read'), "tools isn't a list"],
      [fm('model: }x'), "model isn't text"],
      [fm('model: : x'), "model isn't text"],
      [fm('model: -'), "model isn't text"],
    ]
    for (const [file, error] of cases) expect([file, agentSpec(file)]).toEqual([file, { error }])
    // Valid values still read: an indicator inside a value, a closed flow list, items on their own lines, a dash before a word.
    expect(agentSpec('---\nname: a\ndescription: A reviewer - checks things\nmodel: sonnet\ntools: [Read, Grep]\ndisallowedTools:\n  - Bash\n  - Edit\nskills: -x, tdd\ninitialPrompt: What next? Then @mention, 100% & done\n---\nBody'))
      .toEqual({ leftBehind: [], spec: { name: 'a', description: 'A reviewer - checks things', prompt: 'Body', model: 'sonnet', tools: ['Read', 'Grep'],
        disallowedTools: ['Bash', 'Edit'], skills: ['-x', 'tdd'], initialPrompt: 'What next? Then @mention, 100% & done' } })
  })

  test('CRLF reads as LF, in an agent file and in a brief', () => {
    const file = '---\nname: store-reviewer\ndescription: Reviews the store\ntools: Read, Grep\nhooks:\n  Stop: echo\ninitialPrompt: |\n  One\n  Two\n---\nYou review.\n\nCarefully.'
    const crlf = file.replace(/\n/g, '\r\n')
    expect(agentSpec(file)).toMatchObject({ spec: { initialPrompt: 'One\nTwo', prompt: 'You review.\n\nCarefully.' }, leftBehind: ['hooks'] })
    expect(agentSpec(crlf)).toEqual(agentSpec(file))
    expect(typeName(crlf)).toBe('store-reviewer')
    const plan = planText({ ...emptySaved, stages: [{ agents: [{ ...savedAgent, label: 'Docs', brief: 'One\r\nTwo\r\n\r\nThree\r\n' }] }] }, {}, {})
    expect(plan).not.toContain('\r')
    expect(plan.endsWith('\n  Brief:\n  One\n  Two\n\n  Three')).toBe(true)
  })
})

/** The home the test engine reports, as the status-line tests have it. */
const HOME = '/h'
const said = [you('Write the docs and tests'), lead(call('a1', { model: 'sonnet' }), call('a2', { description: 'Add tests', effort: 'high' })),
  lead(call('a3', { description: 'Review the change', subagent_type: 'store-reviewer' }))]
const reading = JSON.stringify({ name: 'Tests, then a review', purpose: 'Docs and tests, then a review', labels: ['Docs', 'Tests', 'Review'],
  roles: [{ label: 'Writer', role: 'Writes one part' }, { label: 'Reviewer', role: 'Checks the change' }],
  playbook: [{ when: 'When parts are independent', do: 'start writers together', evidence: [2] }] })
/** The model's answer to a call, as `$.model.complete` resolves it. */
const answered = (text: string) => ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
/**
 * The session, the model, the home folder and the files a Save and a Load read. `asked`, `write` and `own` serve the tests after
 * Task 8's five: the requests the model got, how a write answers, agents' own conversations. `answer` gets the request, and its
 * undefined means the reading. `links`: files `fs.list` reports as symbolic links. `list`: how a listing answers instead.
 * An agent's own conversation given as 'deny' is one the engine will not read.
 */
const setup = (on: any, opts: { said?: Msg[]; answer?: (e: any) => any; files?: Record<string, string>; asked?: any[]; write?: (e: any) => any; own?: Record<string, Msg[] | 'deny'>;
  links?: string[]; list?: (path: string) => any } = {}) => {
  const writes: Record<string, string> = {}
  const files = () => opts.files ?? {}
  on('env.get', () => ({ value: HOME }))
  on('session.messages', (_$: any, e: any) => {
    const own = e.agentId ? opts.own?.[e.agentId] ?? [] : opts.said ?? said
    return own === 'deny' ? { deny: 'no transcript' } : { value: own }
  })
  on('model.complete', (_$: any, e: any) => (opts.asked?.push(e), opts.answer?.(e) ?? answered(reading)))
  on('fs.list', (_$: any, e: any) => opts.list?.(e.path) ?? ({ value: Object.keys(files()).filter(f => f.startsWith(`${e.path}/`))
    .map(f => (opts.links?.includes(f) ? { name: f.slice(e.path.length + 1), kind: 'other', isLink: true } : { name: f.slice(e.path.length + 1), kind: 'file' })) }))
  on('fs.read', (_$: any, e: any) => (e.path in files() ? { value: files()[e.path] } : { deny: 'missing' }))
  on('fs.exists', (_$: any, e: any) => ({ value: Object.keys(files()).some(f => f === e.path || f.startsWith(`${e.path}/`)) }))
  on('fs.write', (_$: any, e: any) => opts.write?.(e) ?? ((writes[e.path] = e.text), { value: undefined }))
  return writes
}
const settle = () => new Promise<void>(r => setTimeout(() => r(), 60))

describe('saving a workflow', () => {
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

  // Beyond the plan's five: the paths the plan names but does not press.
  test('a session with no agent work says so, with Cancel', async ($: any, on: any) => {
    setup(on, { said: [you('What does this function do?'), lead()] })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^No agent work in this session yet$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-keep' })).toBeUndefined()
    await ui.press({ key: 'wf-cancel' })
    expect(await ui.find({ key: 'wf-save' })).toBeDefined()
    await ui.unmount()
  })
  test('a session REDhelm cannot read says so', async ($: any, on: any) => {
    on('session.messages', () => ({ deny: 'no transcript' }))
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^Couldn't read this session$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-cancel' })).toBeDefined()
    await ui.unmount()
  })
  test('the reading runs once per Save whatever the labels setting, and /redhelm models counts it', { options: { labels: 'plain' } } as any, async ($: any, on: any) => {
    const asked: any[] = []
    setup(on, { asked })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ model: 'sonnet', effort: 'low', maxTokens: 1500, timeoutMs: 30_000 })
    expect(asked[0].prompt).toMatch(/#2 lead started general-purpose · sonnet/)
    const report = (await $.command.run({ command: 'redhelm', args: 'models', origin: { kind: 'person' }, presentation: {} } as any)).text
    expect(report).toMatch(/: 1 request, /)
    // Labels are off, and the line still counts the reading: it says what it counts.
    expect(report).toMatch(/\nREDhelm's own model calls \(labels: off; workflows: Sonnet, low effort\): 1 request, /)
    await ui.unmount()
  })
  test("an item's detail shows its brief, Remove drops it, and Save as Roles saves the roles", async ($: any, on: any) => {
    const toasts: string[] = []
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
    const writes = setup(on)
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-item-1' })
    expect(await ui.find({ type: 'Text', text: /^Write docs\/api\.md$/ })).toBeDefined() // the whole brief, as given
    await ui.press({ key: 'wf-remove-1' }) // in Lineup, an item is an agent
    expect(await ui.find({ key: 'wf-item-2' })).toBeUndefined()
    expect((await ui.find({ key: 'wf-item-1' }))?.text).toMatch(/Review/)
    await ui.press({ key: 'wf-roles' }) // in Roles, a role: the three setups, each filled once
    expect(await ui.find({ type: 'Text', text: /ran 1×/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-item-2' })).toBeDefined()
    await ui.press({ key: 'wf-item-1' }); await ui.press({ key: 'wf-remove-1' })
    await ui.press({ key: 'wf-keep' }); await settle()
    const saved = JSON.parse(Object.values(writes)[0]!)
    expect(saved).toMatchObject({ name: 'Tests, then a review', form: 'roles', stages: [] })
    expect(saved.roles.map((r: any) => [r.type, r.model])).toEqual([['general-purpose', 'sonnet'], ['store-reviewer', undefined]]) // the effort-high role went
    expect(toasts).toContain('Saved · Tests, then a review')
    expect(await ui.find({ key: 'wf-save' })).toBeDefined() // the section is back
    await ui.unmount()
  })
  test("a write that fails says why and keeps the sheet open", async ($: any, on: any) => {
    const toasts: string[] = []
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
    setup(on, { write: () => ({ deny: 'disk full' }) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle(); await ui.press({ key: 'wf-keep' }); await settle()
    expect(toasts.some(t => /^Couldn't save · .*disk full/.test(t))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^Save workflow$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-item-2' })).toBeDefined()
    await ui.unmount()
  })
  test("a project's type whose file is gone is marked; a repeat folds with its count; an agent's own team is in its detail", async ($: any, on: any) => {
    const review = { description: 'Review the change', subagent_type: 'store-reviewer' }
    setup(on, {
      // a3 has no record (REDhelm let it go), so only its lead message places it: a later stage, where it is a repeat of a1.
      said: [you('Review it, plan, review again'), lead(call('a1', review)), result(), lead(call('a2', { description: 'Plan the fix' })), result(), lead(call('a3', review))],
      own: { a2: [you('Plan the fix'), lead(call('b1', { description: 'Scout', subagent_type: 'Explore', model: 'haiku' }))] },
      answer: () => ({ value: { isAnswered: false } }),
    })
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Review the change', subagentType: 'store-reviewer', provider: { plugin: 'project', tier: 'user' } } as any) // a1
    await $.agent.spawn({ prompt: 'x', description: 'Plan the fix', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } } as any) // a2
    await $.tool.call({ tool: 'Agent', description: 'Scout', prompt: 'Look', agentId: 'a2' } as any) // a2 started an agent of its own
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /store-reviewer · type not copied/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Review the change ran 2 times · saved once$/ })).toBeDefined()
    await ui.press({ key: 'wf-item-1' })
    expect(await ui.find({ type: 'Text', text: /^Team: Explore · haiku · ran 1×$/ })).toBeDefined()
    await ui.unmount()
  })
  test("an agent REDhelm holds no tools of saves what its own conversation shows, and its team; one whose conversation can't be read saves none", async ($: any, on: any) => {
    const writes = setup(on, {
      said: [you('Write the docs, add tests, review'), lead(call('a1'), call('a7', { description: 'Add tests' }), call('a8', { description: 'Check it' }))],
      own: {
        // a1: recorded at its spawn, but REDhelm saw none of its calls.
        a1: [you('Write docs/api.md'), lead({ tool: 'Edit', input: { file_path: 'docs/api.md' } })],
        // a7: no record at all (it ran before REDhelm, or its record was let go).
        a7: [you('Add tests'), lead({ tool: 'Read', input: { file_path: 'a' } }, { tool: 'Read', input: { file_path: 'b' } }), result(),
          lead({ tool: 'mcp__notes__search', input: { q: 'x' } }, { tool: 'Skill', input: { skill: 'tdd' } }), result(),
          lead(call('b1', { description: 'Scout', subagent_type: 'Explore', model: 'haiku' }))],
        a8: 'deny',
      },
      answer: () => ({ value: { isAnswered: false } }),
    })
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Write the docs', subagentType: 'general-purpose' }) // a1
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle(); await ui.press({ key: 'wf-keep' }); await settle()
    const saved = JSON.parse(Object.values(writes)[0]!)
    const agents = saved.stages.flatMap((s: any) => s.agents)
    expect(agents.map((a: any) => [a.description, a.tools, a.skills])).toEqual([
      ['Write the docs', { Edit: 1 }, []],
      ['Add tests', { Read: 2, 'mcp:notes': 1, Skill: 1, Agent: 1 }, ['tdd']],
      ['Check it', {}, []],
    ])
    expect(agents[1].team).toMatchObject([{ type: 'Explore', model: 'haiku', ran: 1 }])
    expect(planText(saved, {}, {})).toContain('  Tools it used: Read 2, mcp:notes 1, Skill 1, Agent 1. Skills it used: tdd.\n')
    await ui.unmount()
  })

  // The kit raises no ui.close, so the pane closing (Esc) is left to the live check; Back here takes the same path.
  test('in the bottom bar, Workflows opens its own pane, where the sheet draws; Back returns to Save', async ($: any, on: any) => {
    const opened: any[] = []
    setup(on)
    await engine(on, true, { opened })($)
    await $.command.run({ command: 'redhelm', args: 'bottom', origin: { kind: 'person' }, presentation: {} } as any)
    const band = await $.ui.mount({ plugin: 'redhelm', component: 'AbovePrompt', surface: 'terminal',
      props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120 } } as any)
    expect((await band.find({ key: 'wf-bar' }))?.text).toBe('Workflows')
    await band.press({ key: 'wf-bar' })
    expect(opened.find(o => o.id === 'redhelm-workflow')).toMatchObject({ closeOnEscape: true, rows: 24 })
    const pane = await $.ui.mount({ plugin: 'redhelm', component: 'Pane', requestId: 'redhelm-workflow', surface: 'terminal',
      props: { title: 'Workflows', isFocused: true, bodyColumns: 70, placement: 'inline' } } as any)
    await pane.press({ key: 'wf-save' }); await settle()
    expect(await pane.find({ type: 'Text', text: /^Save workflow$/ })).toBeDefined()
    await pane.press({ key: 'wf-back' }); await settle()
    expect(await pane.find({ type: 'Text', text: /^Save workflow$/ })).toBeUndefined()
    expect(await pane.find({ key: 'wf-save' })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })
})

/** Like RECORDS: a plugin beside REDhelm that hands a test who owns the prompt box, which a test's own `$` cannot read. Keys are literals, as the host requires. */
const PEEK = {
  name: 'peek',
  register(on: any) {
    on('tool.call', async ($: any, e: any, next: any) => {
      if (e.tool === 'RedhelmMode') return { result: { value: (await $.state.get({ plugin: 'redhelm', key: 'workflowMode' })).value ?? null } }
      if (e.tool === 'RedhelmComposing') return { result: { value: (await $.state.get({ plugin: 'redhelm', key: 'composing' })).value ?? null } }
      // A close of the bottom bar's Workflows pane that REDhelm did not start.
      if (e.tool === 'ClosePane') return (await $.ui.close({ id: 'redhelm-workflow' }), { result: { value: null } })
      return next(e)
    })
  },
}
/** A plugin beside REDhelm that hands the model context of its own with each prompt, so a test sees REDhelm keep it and add none. */
const BESIDE = {
  name: 'beside',
  register(on: any) {
    on('prompt.submit', (_$: any, e: any, next: any) => next({ ...e, context: [...(e.context ?? []), 'from beside'] }))
  },
}
const peek = async ($: any, key: 'workflowMode' | 'composing') =>
  (await $.tool.call({ tool: key === 'workflowMode' ? 'RedhelmMode' : 'RedhelmComposing' } as any)).result.value

/** The prompt box: what it holds, and each prompt that went on to Claude. `unreachable`: there is none (mobile, `-p`). */
const promptBox = (on: any, text = '', opts: { unreachable?: boolean } = {}) => {
  const box = { text, passed: [] as any[] }
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_: any, e: any) => (opts.unreachable ? { isFilled: false } : ((box.text = e.text), { isFilled: true })))
  on('prompt.submit', (_: any, e: any) => (box.passed.push(e), { text: e.text, context: e.context }))
  return box
}

/** A saved workflow's file in the library, and a workflow of this project with one agent. */
const lib = (id: string) => `${HOME}/.claude/redhelm/workflows/${id}.json`
const savedOne = (over: Partial<SavedWorkflow>): SavedWorkflow => ({ ...emptySaved, project: 'p', projectKey: projectKey('/p'),
  stages: [{ agents: [{ ...savedAgent, label: 'Tests', description: 'Add tests', brief: 'Add tests for the store' }] }], ...over })
const library = (...ws: SavedWorkflow[]) => Object.fromEntries(ws.map(w => [lib(w.id), JSON.stringify(w)]))
/** A session where you only ran /redhelm: Run asks nothing. */
const FRESH = [slash('redhelm')]

const REVIEWER = '---\nname: store-reviewer\ndescription: Reviews the store\ntools: Read, Grep\npermissionMode: bypassPermissions\nhooks:\n  Stop: echo\n---\nYou review the store.'

describe('editing and running a workflow', () => {
  const editsWith = (...answers: string[]) => (e: any) => (e.system === EDIT_SYSTEM ? answered(answers.shift()!) : undefined)
  const toastsOf = (on: any) => {
    const toasts: string[] = []
    on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
    return toasts
  }

  test('✎ never reaches Claude, applies the ops, and your draft comes back', async ($: any, on: any) => {
    const asked: any[] = []
    const box = promptBox(on, 'half a prompt')
    setup(on, { asked, answer: editsWith('{"ops":[{"op":"remove","item":2}]}') })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    expect(box.text).toBe('✎ Workflow: ')
    const r = await $.prompt.submit({ text: '✎ Workflow: drop the review' })
    expect(r.drop).toMatch(/applying/)
    await clock.advance(200); await settle()
    expect(box.text).toBe('half a prompt')
    expect(await ui.find({ key: 'wf-item-2' })).toBeUndefined()
    expect(box.passed).toEqual([])
    // One edit call, Sonnet at low effort, with what you asked; counted with the reading in /redhelm models.
    expect(asked.map(a => a.system === EDIT_SYSTEM)).toEqual([false, true])
    expect(asked[1]).toMatchObject(EDIT_CALL)
    expect(asked[1].prompt).toMatch(/The change asked for: drop the review$/)
    const report = (await $.command.run({ command: 'redhelm', args: 'models', origin: { kind: 'person' }, presentation: {} } as any)).text
    expect(report).toMatch(/: 2 requests, /)
    await ui.unmount()
  })

  test('a bad edit keeps the draft and says why', async ($: any, on: any) => {
    const box = promptBox(on)
    setup(on, { answer: editsWith('{"ops":[{"op":"remove","item":9}]}', '{"ops":[{"op":"remove","item":2}]}') })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const edit = async (ask: string) => {
      await ui.press({ key: 'wf-edit' }); await settle()
      await $.prompt.submit({ text: `${box.text}${ask}` }); await clock.advance(200); await settle()
    }
    await ui.press({ key: 'wf-save' }); await settle()
    await edit('drop the tenth')
    expect(await ui.find({ type: 'Text', text: /^No item 10$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-item-2' })).toBeDefined()
    expect(await ui.find({ key: 'wf-undo' })).toBeUndefined() // nothing changed, so nothing to undo
    await edit('drop the review')
    expect(await ui.find({ key: 'wf-item-2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /No item 10/ })).toBeUndefined()
    await ui.press({ key: 'wf-undo' }); await settle()
    expect(await ui.find({ key: 'wf-item-2' })).toBeDefined()
    expect(await ui.find({ key: 'wf-undo' })).toBeUndefined()
    await ui.unmount()
  })

  test('▶ becomes the run text with the plan written out under it, and context passes as it came', { plugins: [BESIDE] }, async ($: any, on: any) => {
    const box = promptBox(on, 'half a prompt')
    setup(on, { said: FRESH, files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle()
    expect(box.text).toBe('▶ Tests, then a review: ')
    await $.prompt.submit({ text: '▶ Tests, then a review: only src/store.js' })
    expect(box.passed).toHaveLength(1)
    const [ask, plan] = box.passed[0].text.split(/\n\n(.*)/s)
    expect(ask).toBe('Run my saved REDhelm workflow "Tests, then a review". My notes for this run: only src/store.js')
    expect(plan).toMatch(/^Saved REDhelm workflow "Tests, then a review"\.\n/)
    expect(plan).toContain('Stage 1, start together:')
    expect(plan).toContain('Add tests for the store')
    // What you see is all Claude gets: REDhelm adds nothing to the context, and keeps what another plugin put there.
    expect(box.passed[0].context).toEqual(['from beside'])
    await clock.advance(200); await settle()
    expect(box.text).toBe('half a prompt') // your draft, once Claude Code took the prompt
    // The run is over: the mark typed again is your own text.
    await $.prompt.submit({ text: '▶ Tests, then a review: again' })
    expect([box.passed[1].text, box.passed[1].context]).toEqual(['▶ Tests, then a review: again', ['from beside']])
    await ui.unmount()
  })

  test('a name with a colon runs', async ($: any, on: any) => {
    const box = promptBox(on)
    setup(on, { said: FRESH, files: library(savedOne({ id: 'build-phase-two', name: 'Build: phase two' })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-build-phase-two' }); await settle()
    expect(box.text).toBe('▶ Build: phase two: ')
    await $.prompt.submit({ text: '▶ Build: phase two: only src/store.js' })
    expect(box.passed[0].text).toMatch(/^Run my saved REDhelm workflow "Build: phase two"\. My notes for this run: only src\/store\.js\n\nSaved REDhelm workflow "Build: phase two"\.\n/)
    expect(box.passed[0].text).toContain('Stage 1, start together:')
    // No notes: Enter at once.
    await ui.press({ key: 'wf-run-build-phase-two' }); await settle()
    await $.prompt.submit({ text: box.text })
    expect(box.passed[1].text).toMatch(/^Run my saved REDhelm workflow "Build: phase two"\.\n\nSaved REDhelm workflow /)
    await ui.unmount()
  })

  test('deleting the mark ends the mode', { plugins: [PEEK] }, async ($: any, on: any) => {
    const box = promptBox(on, 'my draft')
    setup(on, { said: FRESH, files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle()
    expect(await peek($, 'workflowMode')).toMatchObject({ kind: 'run', id: 'tests-then-a-review', name: 'Tests, then a review' })
    await $.prompt.submit({ text: 'something else' })
    expect(box.passed.map(p => [p.text, p.context])).toEqual([['something else', undefined]])
    expect(await peek($, 'workflowMode')).toBeNull()
    await clock.advance(200); await settle()
    expect(box.text).toBe('my draft')
    await ui.unmount()
  })

  test('Reply ends Edit and Edit ends Reply, handing the draft on', { plugins: [PEEK] }, async ($: any, on: any) => {
    const box = promptBox(on, 'half a prompt')
    on('session.send', () => ({ isDelivered: true }))
    setup(on)
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' }); await sheet.unmount(); await settle()
    expect(box.text).toBe('→ docs: ')
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    expect(box.text).toBe('✎ Workflow: ')
    expect(await peek($, 'composing')).toBeNull()
    expect(await peek($, 'workflowMode')).toEqual({ kind: 'edit' })
    await ui.press({ key: 'wf-cancel' }); await settle()
    expect(box.text).toBe('half a prompt')
    expect(await peek($, 'workflowMode')).toBeNull()
    await ui.unmount()
  })

  test('an empty library says so', async ($: any, on: any) => {
    setup(on, { list: path => (path.endsWith('/workflows') ? { deny: 'ENOENT: no such file or directory' } : undefined) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^No saved workflows yet$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /could not be read/ })).toBeUndefined()
    await ui.press({ key: 'wf-load' }); await settle() // Load again puts the list away
    expect(await ui.find({ type: 'Text', text: /^No saved workflows yet$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a Save while the library is listed lists it again, with what was saved; one while it is put away leaves it away', async ($: any, on: any) => {
    const files: Record<string, string> = {}
    setup(on, { files, write: e => ((files[e.path] = e.text), { value: undefined }) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^No saved workflows yet$/ })).toBeDefined()
    await ui.press({ key: 'wf-save' }); await settle(); await ui.press({ key: 'wf-keep' }); await settle()
    expect(await ui.find({ key: 'wf-open-tests-then-a-review' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^No saved workflows yet$/ })).toBeUndefined()
    await ui.press({ key: 'wf-load' }); await settle() // put away
    await ui.press({ key: 'wf-save' }); await settle(); await ui.press({ key: 'wf-keep' }); await settle()
    expect(Object.keys(files)).toEqual([lib('tests-then-a-review'), lib('tests-then-a-review-2')])
    expect(await ui.find({ key: 'wf-open-tests-then-a-review' })).toBeUndefined()
    await ui.unmount()
  })

  test("Load lists this project's first and counts bad files", async ($: any, on: any) => {
    const here = savedOne({ id: 'here', name: 'Here', savedAt: 1 })
    const there = savedOne({ id: 'there', name: 'There', savedAt: 9, project: 'api', projectKey: 'elsewhere', form: 'roles', roles: [role, { ...role, label: 'Reviewer' }], stages: [],
      lead: { skills: [], playbook: [{ when: 'When x', do: 'do y' }], briefParts: [] } })
    setup(on, { files: { ...library(there, here), [lib('bad')]: '{', [lib('gone')]: '' } })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    const names = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k?.startsWith('wf-open-'))
    expect(names).toEqual(['wf-open-here', 'wf-open-there'])
    expect(await ui.find({ type: 'Text', text: /^1 agent$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^playbook · 2 roles · from api$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 workflow could not be read$/ })).toBeDefined() // the blank (deleted) file is not counted
    await ui.unmount()
  })

  test('Delete needs two presses', async ($: any, on: any) => {
    const writes = setup(on, { files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-open-tests-then-a-review' }); await settle()
    await ui.press({ key: 'wf-delete' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^Press again to delete$/ })).toBeDefined()
    expect(writes).toEqual({})
    await ui.press({ key: 'wf-delete' }); await settle()
    expect(writes).toEqual({ [lib('tests-then-a-review')]: '' })
    expect(await ui.find({ key: 'wf-open-tests-then-a-review' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^No saved workflows yet$/ })).toBeDefined()
    await ui.unmount()
  })

  test("Run registers a copied type this project lacks; one it has, it doesn't", async ($: any, on: any) => {
    const toasts = toastsOf(on)
    const registered: any[] = []
    let refuse = ''
    on('agent.register', (_$: any, e: any) => (registered.push(e), refuse ? { deny: refuse } : { value: { agent: `redhelm:${e.name}` } }))
    const box = promptBox(on)
    const files: Record<string, string> = library(savedOne({ id: 'review', name: 'Review', types: [{ name: 'store-reviewer', definition: REVIEWER }],
      stages: [{ agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', brief: 'Review the store' }] }] }))
    setup(on, { said: FRESH, files })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    const run = async () => {
      await ui.press({ key: 'wf-run-review' }); await settle()
      await $.prompt.submit({ text: `${box.text}go` })
      return box.passed.at(-1).text as string
    }
    let plan = await run()
    expect(registered).toHaveLength(1)
    expect(registered[0]).toEqual({ name: 'store-reviewer', description: 'Reviews the store', prompt: 'You review the store.', tools: ['Read', 'Grep'] })
    expect(plan).toContain('subagent_type redhelm:store-reviewer (its hooks and permission mode stayed behind)')
    files['/p/.claude/agents/store-reviewer.md'] = REVIEWER // what is here wins
    plan = await run()
    expect(registered).toHaveLength(1)
    expect(plan).toContain('- Review: subagent_type store-reviewer\n')
    delete files['/p/.claude/agents/store-reviewer.md']
    files[`${HOME}/.claude/agents/store-reviewer.md`] = REVIEWER // yours too
    plan = await run()
    expect(registered).toHaveLength(1)
    delete files[`${HOME}/.claude/agents/store-reviewer.md`]
    refuse = 'the name is taken'
    plan = await run()
    expect(registered).toHaveLength(2)
    expect(toasts.filter(t => /^Couldn't add store-reviewer · .*the name is taken/.test(t))).toHaveLength(1)
    expect(plan).toContain('subagent_type general-purpose (store-reviewer could not be added here)')
    await ui.unmount()
  })

  test('no prompt box', { plugins: [PEEK] }, async ($: any, on: any) => {
    const toasts = toastsOf(on)
    promptBox(on, '', { unreachable: true })
    setup(on, { files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle()
    await ui.press({ key: 'wf-ask-run' }); await settle() // this session has a prompt: Run asked first
    expect(toasts).toEqual(['Could not reach the prompt'])
    expect(await peek($, 'workflowMode')).toBeNull()
    await ui.press({ key: 'wf-back' }); await settle()
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    expect(toasts).toEqual(['Could not reach the prompt', 'Could not reach the prompt'])
    expect(await peek($, 'workflowMode')).toBeNull()
    await ui.unmount()
  })

  // Beyond the plan's tests: the rules it states but does not press, and Task 8's carried fixes.
  test('Edit and Remove wait for the reading; Undo shows only once something changed', async ($: any, on: any) => {
    let release = () => {}
    setup(on, { answer: e => (e.system === EDIT_SYSTEM ? undefined : new Promise(r => (release = () => r(answered(reading))))) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^Reading…$/ })).toBeDefined()
    await ui.press({ key: 'wf-item-0' })
    expect(await ui.find({ key: 'wf-remove-0' })).toBeUndefined()
    expect(await ui.find({ key: 'wf-edit' })).toBeUndefined()
    expect(await ui.find({ key: 'wf-undo' })).toBeUndefined()
    release(); await settle()
    expect(await ui.find({ key: 'wf-remove-0' })).toBeDefined()
    expect(await ui.find({ key: 'wf-edit' })).toBeDefined()
    expect(await ui.find({ key: 'wf-undo' })).toBeUndefined()
    await ui.unmount()
  })

  test('an empty ✎ changes nothing, an edit of no ops adds no Undo, and a refusal shows as it is', { plugins: [PEEK] }, async ($: any, on: any) => {
    const box = promptBox(on, 'half a prompt')
    setup(on, { answer: editsWith('{"ops": []}', '{"cannot": "There is no step called deploy"}') })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    expect((await $.prompt.submit({ text: '✎ Workflow: ' })).drop).toBe('REDhelm: nothing to change')
    expect((await $.prompt.submit({ text: '✎ Workflow:' })).drop).toBe('REDhelm: nothing to change')
    expect(await peek($, 'workflowMode')).toEqual({ kind: 'edit' }) // still yours to type the change into
    expect((await $.prompt.submit({ text: '✎ Workflow: keep it as it is' })).drop).toMatch(/applying/)
    await clock.advance(200); await settle()
    expect(box.text).toBe('half a prompt')
    expect(await ui.find({ key: 'wf-undo' })).toBeUndefined()
    await ui.press({ key: 'wf-edit' }); await settle()
    await $.prompt.submit({ text: '✎ Workflow: drop the deploy step' }); await clock.advance(200); await settle()
    expect(await ui.find({ type: 'Text', text: /^There is no step called deploy$/ })).toBeDefined()
    expect(box.passed).toEqual([])
    await ui.unmount()
  })

  test('a second ✎ while one applies waits for it, and is asked of the draft the first left', async ($: any, on: any) => {
    const asked: any[] = []
    const releases: (() => void)[] = []
    const ops = ['{"ops":[{"op":"remove","item":2}]}', '{"ops":[{"op":"remove","item":0}]}']
    const box = promptBox(on)
    setup(on, { asked, answer: e => (e.system === EDIT_SYSTEM ? new Promise(r => releases.push(() => r(answered(ops.shift()!)))) : undefined) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    await $.prompt.submit({ text: '✎ Workflow: drop the review' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^Applying…$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-remove-0' })).toBeUndefined()
    expect(await ui.find({ key: 'wf-keep' })).toBeUndefined() // Save would drop the edit you asked for
    await ui.press({ key: 'wf-edit' }); await settle() // Edit stays while one applies
    expect(box.text).toBe('✎ Workflow: ')
    await $.prompt.submit({ text: '✎ Workflow: drop the docs' }); await settle()
    expect(releases).toHaveLength(1) // the second waits
    releases[0]!(); await settle()
    expect(await ui.find({ key: 'wf-item-2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Applying…$/ })).toBeDefined()
    expect(releases).toHaveLength(2)
    expect(asked.at(-1).prompt).not.toMatch(/Review the change/) // asked of the draft without the review
    releases[1]!(); await settle()
    expect(await ui.find({ type: 'Text', text: /^Applying…$/ })).toBeUndefined()
    expect(await ui.find({ key: 'wf-keep' })).toBeDefined()
    expect((await ui.find({ key: 'wf-item-0' }))?.text).toMatch(/Tests/)
    expect(await ui.find({ key: 'wf-item-1' })).toBeUndefined()
    await ui.unmount()
  })

  test('nothing empty is saved: the last item has no Remove, and a form left with no items has no Save', async ($: any, on: any) => {
    const box = promptBox(on)
    setup(on, { said: [you('Write the docs'), lead(call('a1'))], answer: editsWith('{"ops":[{"op":"remove","item":0}]}') })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-item-0' })
    expect(await ui.find({ key: 'wf-remove-0' })).toBeUndefined()
    await ui.press({ key: 'wf-edit' }); await settle()
    await $.prompt.submit({ text: `${box.text}drop it` }); await clock.advance(200); await settle()
    expect(await ui.find({ key: 'wf-item-0' })).toBeUndefined()
    expect(await ui.find({ key: 'wf-keep' })).toBeUndefined()
    await ui.press({ key: 'wf-roles' }) // the other form still has its role
    expect(await ui.find({ key: 'wf-keep' })).toBeDefined()
    await ui.press({ key: 'wf-lineup' })
    await ui.press({ key: 'wf-undo' }); await settle()
    expect(await ui.find({ key: 'wf-keep' })).toBeDefined()
    await ui.unmount()
  })

  test('Reply ends a Run, handing the draft on; a notification or a meta prompt never ends a mode', { plugins: [PEEK] }, async ($: any, on: any) => {
    const box = promptBox(on, 'half a prompt')
    on('session.send', () => ({ isDelivered: true }))
    setup(on, { files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle()
    await ui.press({ key: 'wf-ask-run' }); await settle() // an agent is busy: Run asked first
    await $.prompt.submit({ text: '<task-notification> a1 finished </task-notification>', origin: { kind: 'task-notification' } })
    await $.prompt.submit({ text: 'an idle notice', isMeta: true })
    await clock.advance(200); await settle()
    expect(box.text).toBe('▶ Tests, then a review: ')
    expect(await peek($, 'workflowMode')).toMatchObject({ kind: 'run' })
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' }); await sheet.unmount(); await settle()
    expect(box.text).toBe('→ docs: ')
    expect(await peek($, 'workflowMode')).toBeNull()
    await ui.press({ key: 'cancel-compose' }); await settle()
    expect(box.text).toBe('half a prompt')
    await ui.unmount()
  })

  test("a saved workflow's sheet: its parts, Run, Delete and Close, and the lead's model when this session runs another", async ($: any, on: any) => {
    on('settings.read', () => ({ value: {} }))
    const box = promptBox(on)
    setup(on, { said: FRESH, files: library(savedOne({ id: 'build', name: 'Build', purpose: 'Implementers, then a review', types: [{ name: 'store-reviewer', definition: REVIEWER }],
      lead: { skills: ['redmanager'], playbook: [], briefParts: [], model: 'claude-opus-5-5[1m]' },
      stages: [{ agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', brief: 'Review the store' }] }] })) })
    await engine(on, true)($)
    await ($ as any).classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5', requested_model: null, source: 'picker' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^skill · 1 agent$/ })).toBeDefined()
    await ui.press({ key: 'wf-open-build' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^Implementers, then a review$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^The lead ran on Opus 5\.5 · this session runs Sonnet 5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /redmanager skill/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /store-reviewer · type copied/ })).toBeDefined()
    for (const key of ['wf-run-build', 'wf-delete', 'wf-close']) expect(await ui.find({ key })).toBeDefined()
    for (const key of ['wf-keep', 'wf-edit', 'wf-roles', 'wf-cancel']) expect(await ui.find({ key })).toBeUndefined()
    await ui.press({ key: 'wf-item-0' })
    expect(await ui.find({ type: 'Text', text: /^Review the store$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Stays behind: hooks, permission mode$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-remove-0' })).toBeUndefined()
    await ui.press({ key: 'wf-close' }); await settle()
    expect(await ui.find({ key: 'wf-open-build' })).toBeDefined()
    await ui.press({ key: 'wf-open-build' }); await settle()
    await ui.press({ key: 'wf-run-build' }); await settle() // Run goes to the prompt box: the sheet steps aside
    expect(box.text).toBe('▶ Build: ')
    expect(await ui.find({ key: 'wf-delete' })).toBeUndefined()
    expect(await ui.find({ key: 'wf-open-build' })).toBeDefined()
    await ui.unmount()
  })

  test('Run hands the box to Edit, and Edit back to Run, with your draft kept once', { plugins: [PEEK] }, async ($: any, on: any) => {
    const box = promptBox(on, 'half a prompt')
    setup(on, { files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // This session has a prompt: Run asks first, and Run here runs.
    const run = async () => { await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle(); await ui.press({ key: 'wf-ask-run' }); await settle() }
    await ui.press({ key: 'wf-load' }); await settle()
    await run()
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    expect(box.text).toBe('✎ Workflow: ')
    expect(await peek($, 'workflowMode')).toEqual({ kind: 'edit' })
    await ui.press({ key: 'wf-cancel' }); await settle()
    expect(box.text).toBe('half a prompt') // the draft from before Run, not Run's mark
    await run()
    await run() // Run again: its own mark is no draft either
    await $.prompt.submit({ text: 'something else' }); await clock.advance(200); await settle()
    expect(box.text).toBe('half a prompt')
    await ui.unmount()
  })

  test("a copied type whose file does not parse is not registered: a toast, and general-purpose in the plan", async ($: any, on: any) => {
    const toasts = toastsOf(on)
    const registered: any[] = []
    on('agent.register', (_$: any, e: any) => (registered.push(e), { value: { agent: `redhelm:${e.name}` } }))
    const box = promptBox(on)
    setup(on, { said: FRESH, files: library(savedOne({ id: 'lint', name: 'Lint', types: [{ name: 'store-linter', definition: 'no front matter' }],
      stages: [{ agents: [{ ...savedAgent, label: 'Lint', type: 'store-linter', brief: 'Lint it' }] }] })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-lint' }); await settle()
    await $.prompt.submit({ text: `${box.text}go` })
    expect(registered).toEqual([])
    expect(toasts).toEqual(["Couldn't add store-linter · No front matter"])
    expect(box.passed[0].text).toContain('- Lint: subagent_type general-purpose (store-linter could not be added here)')
    await ui.unmount()
  })

  test('a run the model guard holds waits for you to send it again', async ($: any, on: any) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    const box = promptBox(on)
    setup(on, { said: FRESH, files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    const sw = (source: string, to: string) => ($ as any).classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: to, requested_model: null, source })
    await sw('auto', 'claude-opus-4-8')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle()
    expect((await $.prompt.submit({ text: '▶ Tests, then a review: go' })).drop).toMatch(/switched models on its own/)
    await sw('picker', 'claude-fable-5-1')
    // The mode held: the same text sent again (the guard holds tools too, so the mode is read from what it does).
    await $.prompt.submit({ text: '▶ Tests, then a review: go' })
    expect(box.passed.map(p => p.text.split('\n')[0])).toEqual(['Run my saved REDhelm workflow "Tests, then a review". My notes for this run: go'])
    await ui.unmount()
  })

  test('the library and a saved sheet draw on every surface', async ($: any, on: any) => {
    setup(on, { files: library(savedOne({ id: 'build', name: 'Build', types: [{ name: 'store-reviewer', definition: REVIEWER }],
      stages: [{ agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', brief: 'Review the store' }] }] })) })
    await engine(on, true)($)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as any)
      await ui.press({ key: 'wf-load' }); await settle()
      expect([surface, (await ui.find({ key: 'wf-open-build' }))?.text]).toEqual([surface, 'Build'])
      await ui.press({ key: 'wf-open-build' }); await settle()
      await ui.press({ key: 'wf-item-0' }); await settle()
      expect([surface, !!(await ui.find({ key: 'wf-delete' }))]).toEqual([surface, true])
      await ui.press({ key: 'wf-close' }); await settle()
      await ui.press({ key: 'wf-load' }); await settle() // put away for the next surface
      await ui.unmount()
    }
  })

  // The review's fixes.
  test('a prompt the guard holds changes nothing: a run or a reply stays open, and the box keeps what you typed', async ($: any, on: any) => {
    on('config.list', () => ({ value: [] }))
    on('settings.read', () => ({ value: {} }))
    on('session.send', () => ({ isDelivered: true }))
    const box = promptBox(on, 'half a prompt')
    setup(on, { files: library(savedOne({ id: 'tests-then-a-review', name: 'Tests, then a review' })) })
    await engine(on, true)($)
    await $.agent.spawn({ prompt: 'x', description: 'Rewrite the setup guide', subagentType: 'general-purpose', name: 'docs' })
    const sw = (source: string, to: string) => ($ as any).classic.PostModelSwitch({ from_model: 'claude-fable-5-1', to_model: to, requested_model: null, source })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-tests-then-a-review' }); await settle()
    await ui.press({ key: 'wf-ask-run' }); await settle() // an agent is busy: Run asked first
    await sw('auto', 'claude-opus-4-8')
    expect((await $.prompt.submit({ text: 'something else' })).drop).toMatch(/switched models on its own/)
    await clock.advance(200); await settle()
    expect(box.text).toBe('▶ Tests, then a review: ') // never overwritten with the old draft
    await sw('picker', 'claude-fable-5-1')
    await $.prompt.submit({ text: '▶ Tests, then a review: go' }) // the run was still open
    expect(box.passed.map(p => p.text.split('\n')[0])).toEqual(['Run my saved REDhelm workflow "Tests, then a review". My notes for this run: go'])
    await clock.advance(200); await settle()
    expect(box.text).toBe('half a prompt') // and its draft still kept
    // The same with a Reply open.
    const sheet = await openSheet($, ui, 'a1')
    await sheet.press({ key: 'compose-a1' }); await sheet.unmount(); await settle()
    expect(box.text).toBe('→ docs: ')
    await sw('auto', 'claude-opus-4-8')
    expect((await $.prompt.submit({ text: 'a question for Claude' })).drop).toMatch(/switched models on its own/)
    await clock.advance(200); await settle()
    expect(box.text).toBe('→ docs: ')
    expect(await ui.find({ type: 'Text', text: /Writing to Docs/ })).toBeDefined()
    await ui.unmount()
  })

  test("✎ text is never Claude's while an edit is out or the review sheet is open", async ($: any, on: any) => {
    const asked: any[] = []
    let release = () => {}
    const box = promptBox(on, 'half a prompt')
    setup(on, { asked, answer: e => (e.system === EDIT_SYSTEM ? new Promise(r => (release = () => r(answered('{"ops":[{"op":"remove","item":2}]}')))) : undefined) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    await ui.press({ key: 'wf-edit' }); await settle()
    expect((await $.prompt.submit({ text: '✎ Workflow: drop the review' })).drop).toBe('✎ Workflow: applying')
    // Enter again before the draft is back, while the box still holds the edit just sent.
    expect((await $.prompt.submit({ text: '✎ Workflow: drop the review' })).drop).toBe('✎ Workflow: applying')
    release(); await clock.advance(200); await settle()
    expect(asked.filter(a => a.system === EDIT_SYSTEM)).toHaveLength(1)
    expect(await ui.find({ key: 'wf-item-2' })).toBeUndefined()
    expect(await ui.find({ key: 'wf-item-1' })).toBeDefined()
    // No edit out, but the sheet open: typed by hand, it is still not Claude's, and nothing applies it.
    expect((await $.prompt.submit({ text: '✎ Workflow: drop the docs' })).drop).toBe('REDhelm: press Edit first')
    await settle()
    expect(asked.filter(a => a.system === EDIT_SYSTEM)).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /^Applying…$/ })).toBeUndefined()
    expect(box.passed).toEqual([])
    await ui.press({ key: 'wf-cancel' }); await settle()
    await $.prompt.submit({ text: '✎ Workflow: drop the docs' }) // no sheet: your own text
    expect(box.passed.map(p => p.text)).toEqual(['✎ Workflow: drop the docs'])
    await ui.unmount()
  })

  test('an edit still out when the session restarts never lands, and Applying… does not stick', async ($: any, on: any) => {
    const releases: (() => void)[] = []
    const ops = ['{"ops":[{"op":"remove","item":2}]}', '{"ops":[{"op":"remove","item":0}]}', '{"ops": []}']
    const box = promptBox(on)
    on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
    setup(on, { answer: e => (e.system === EDIT_SYSTEM ? new Promise(r => releases.push(() => r(answered(ops.shift()!)))) : undefined) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const edit = async (ask: string) => {
      await ui.press({ key: 'wf-edit' }); await settle()
      await $.prompt.submit({ text: `${box.text}${ask}` }); await settle()
    }
    const applying = async () => !!(await ui.find({ type: 'Text', text: /^Applying…$/ }))
    await ui.press({ key: 'wf-save' }); await settle()
    await edit('drop the review')
    expect(await applying()).toBe(true)
    await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true }); await settle()
    expect(await applying()).toBe(false)
    await edit('drop the docs')
    expect(await applying()).toBe(true)
    releases[0]!(); await settle() // the last session's edit: it lands nothing and counts nothing
    expect(await ui.find({ key: 'wf-item-2' })).toBeDefined()
    expect(await applying()).toBe(true)
    releases[1]!(); await settle()
    expect(await applying()).toBe(false)
    expect((await ui.find({ key: 'wf-item-0' }))?.text).toMatch(/Tests/)
    await edit('nothing really') // the count is still right
    expect(await applying()).toBe(true)
    releases[2]!(); await settle()
    expect(await applying()).toBe(false)
    await ui.unmount()
  })

  test('a second Run while one is registering is ignored, so its mark never becomes your draft', async ($: any, on: any) => {
    const releases: (() => void)[] = []
    on('agent.register', (_$: any, e: any) => new Promise(r => releases.push(() => r({ value: { agent: `redhelm:${e.name}` } }))))
    const box = promptBox(on, 'half a prompt')
    setup(on, { said: FRESH, files: library(savedOne({ id: 'review', name: 'Review', types: [{ name: 'store-reviewer', definition: REVIEWER }],
      stages: [{ agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', brief: 'Review the store' }] }] })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-review' })
    await ui.press({ key: 'wf-run-review' }); await settle()
    expect(releases).toHaveLength(1)
    releases.forEach(r => r()); await settle()
    expect(box.text).toBe('▶ Review: ')
    await $.prompt.submit({ text: 'something else' }); await clock.advance(200); await settle()
    expect(box.text).toBe('half a prompt')
    await ui.unmount()
  })

  test('with agents busy, Run asks first and does nothing yet; Cancel brings the row back, Run here runs', async ($: any, on: any) => {
    const registered: any[] = []
    on('agent.register', (_$: any, e: any) => (registered.push(e), { value: { agent: `redhelm:${e.name}` } }))
    const box = promptBox(on, 'half a prompt')
    setup(on, { said: FRESH, files: library(savedOne({ id: 'review', name: 'Review', types: [{ name: 'store-reviewer', definition: REVIEWER }],
      stages: [{ agents: [{ ...savedAgent, label: 'Review', type: 'store-reviewer', brief: 'Review the store' }] }] })) })
    await engine(on, true)($)
    await spawn($); await spawn($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const asks = async () => !!(await ui.find({ key: 'wf-ask' }))
    const armed = async () => !!(await ui.find({ type: 'Text', text: /^Press again to delete$/ }))
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-open-review' }); await settle()
    await ui.press({ key: 'wf-delete' }); await settle()
    expect(await armed()).toBe(true)
    await ui.press({ key: 'wf-run-review' }); await settle() // Run clears Delete's ask
    expect(await ui.find({ type: 'Text', text: /^Run it in this session\?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 agents busy$/ })).toBeDefined()
    expect([await armed(), registered, box.text]).toEqual([false, [], 'half a prompt'])
    await ui.press({ key: 'wf-ask-cancel' }); await settle()
    expect(await asks()).toBe(false)
    for (const key of ['wf-run-review', 'wf-delete', 'wf-close']) expect(await ui.find({ key })).toBeDefined()
    expect([registered, box.text]).toEqual([[], 'half a prompt'])
    await ui.press({ key: 'wf-run-review' }); await settle()
    await ui.press({ key: 'wf-ask-run' }); await settle() // no second check
    expect([box.text, registered.length, await asks()]).toEqual(['▶ Review: ', 1, false])
    await ui.unmount()
  })

  test("Run in the list opens the sheet on the question (another project's, a skill missing), in three rows at 22 columns; Back clears it", async ($: any, on: any) => {
    on('command.list', () => ({ value: [{ name: 'kit:tdd', description: '', source: 'plugin', plugin: 'kit' }] }))
    const box = promptBox(on)
    setup(on, { said: FRESH, files: library(savedOne({ id: 'build', name: 'Build', projectKey: 'k0', project: 'notes-app', lead: { skills: ['tdd', 'ship'], playbook: [], briefParts: [] } })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 22 } })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-build' }); await settle()
    expect(await ui.find({ type: 'Text', text: /^from notes-app$/ })).toBeDefined() // its sheet
    expect(await ui.find({ type: 'Text', text: /^other project · ship missing$/ })).toBeDefined()
    // Two lines that truncate (the reasons in line with the buttons' labels) and a row that cannot wrap: never a fourth row.
    const rows = (await ui.find({ key: 'wf-ask' }))!.children as any[]
    expect(rows.map(r => r.type)).toEqual(['Text', 'Box', 'Box'])
    expect([rows[0].props.wrap, rows[1].props.paddingLeft, rows[1].children[0].props.wrap, rows[2].props.flexWrap]).toEqual(['truncate-end', 1, 'truncate-end', undefined])
    expect(box.text).toBe('')
    await ui.press({ key: 'wf-back' }); await settle()
    await ui.press({ key: 'wf-open-build' }); await settle()
    expect(await ui.find({ key: 'wf-ask' })).toBeUndefined()
    await ui.press({ key: 'wf-run-build' }); await settle()
    await ui.press({ key: 'wf-ask-run' }); await settle()
    expect(box.text).toBe('▶ Build: ')
    await ui.unmount()
  })

  test('a Save or another workflow opened while the check reads keeps its sheet: no question, no run', async ($: any, on: any) => {
    const releases: ((v: any) => void)[] = []
    on('command.list', () => new Promise(r => releases.push(r)))
    const box = promptBox(on)
    const tdd = { skills: ['tdd'], playbook: [], briefParts: [] }
    setup(on, { said: FRESH, files: library(savedOne({ id: 'build', name: 'Build', lead: tdd }), savedOne({ id: 'docs', name: 'Docs', savedAt: 1 })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-build' }); await settle()
    await ui.press({ key: 'wf-open-docs' }); await settle()
    releases[0]!({ value: [{ name: 'tdd' }] }); await settle() // nothing applies, and still no run
    expect([await ui.find({ key: 'wf-ask' }), !!(await ui.find({ key: 'wf-run-docs' })), box.text]).toEqual([undefined, true, ''])
    await ui.press({ key: 'wf-close' }); await settle()
    await ui.press({ key: 'wf-run-build' }); await settle()
    await ui.press({ key: 'wf-save' }); await settle()
    releases[1]!({ value: [] }); await settle() // tdd missing
    expect(await ui.find({ type: 'Text', text: /^Save workflow$/ })).toBeDefined()
    expect([await ui.find({ key: 'wf-ask' }), box.text]).toEqual([undefined, ''])
    await ui.unmount()
  })

  test('a read that fails gives no reason, and never holds Run', async ($: any, on: any) => {
    on('command.list', () => ({ deny: 'no commands' }))
    const box = promptBox(on)
    setup(on, { said: FRESH, files: library(savedOne({ id: 'build', name: 'Build', lead: { skills: ['tdd'], playbook: [], briefParts: [] } })) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-load' }); await settle()
    await ui.press({ key: 'wf-run-build' }); await settle()
    expect(box.text).toBe('▶ Build: ')
    await ui.unmount()
  })

  test('Earlier waits out an edit applying', async ($: any, on: any) => {
    let release = () => {}
    const box = promptBox(on)
    setup(on, { said: [you('one'), lead(call('a1')), you('two'), lead(call('a2', { description: 'Add tests' }))],
      answer: e => (e.system === EDIT_SYSTEM ? new Promise(r => (release = () => r(answered('{"ops": []}')))) : undefined) })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ key: 'wf-earlier' })).toBeDefined()
    await ui.press({ key: 'wf-edit' }); await settle()
    await $.prompt.submit({ text: `${box.text}keep it` }); await settle()
    expect(await ui.find({ key: 'wf-earlier' })).toBeUndefined()
    release(); await settle()
    expect(await ui.find({ key: 'wf-earlier' })).toBeDefined()
    await ui.unmount()
  })

  test("Edit in the bottom bar's Workflows pane hands the keys to the prompt, and the pane comes back when the edit lands", { plugins: [PEEK] }, async ($: any, on: any) => {
    const opened: any[] = []
    const closed: any[] = []
    const box = promptBox(on, 'half a prompt')
    setup(on, { answer: editsWith('{"ops":[{"op":"remove","item":2}]}') })
    await engine(on, true, { opened, closed })($)
    await $.command.run({ command: 'redhelm', args: 'bottom', origin: { kind: 'person' }, presentation: {} } as any)
    const band = await $.ui.mount({ plugin: 'redhelm', component: 'AbovePrompt', surface: 'terminal',
      props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120 } } as any)
    await band.press({ key: 'wf-bar' })
    const pane = await $.ui.mount({ plugin: 'redhelm', component: 'Pane', requestId: 'redhelm-workflow', surface: 'terminal',
      props: { title: 'Workflows', isFocused: true, bodyColumns: 70, placement: 'inline' } } as any)
    await pane.press({ key: 'wf-save' }); await settle()
    const shown = () => opened.filter(o => o.id === 'redhelm-workflow').length
    expect(shown()).toBe(1)
    await pane.press({ key: 'wf-edit' }); await settle()
    expect(box.text).toBe('✎ Workflow: ')
    expect(closed.map(c => c.id)).toContain('redhelm-workflow')
    expect(await peek($, 'workflowMode')).toEqual({ kind: 'edit', pane: true }) // REDhelm's own close kept the edit
    expect(await pane.find({ type: 'Text', text: /^Save workflow$/ })).toBeDefined() // and the sheet
    await $.prompt.submit({ text: '✎ Workflow: drop the review' }); await clock.advance(200); await settle()
    expect(shown()).toBe(2)
    expect(opened.at(-1)).toMatchObject({ id: 'redhelm-workflow', closeOnEscape: true, rows: 24 })
    expect(await pane.find({ key: 'wf-item-2' })).toBeUndefined()
    expect(box.text).toBe('half a prompt')
    // A close REDhelm did not start for an edit still takes the sheet, and the edit, with it.
    await pane.press({ key: 'wf-edit' }); await settle()
    await $.tool.call({ tool: 'ClosePane' } as any); await settle()
    expect(await peek($, 'workflowMode')).toBeNull()
    expect(box.text).toBe('half a prompt')
    expect(await pane.find({ type: 'Text', text: /^Save workflow$/ })).toBeUndefined()
    await pane.unmount()
    await band.unmount()
  })

  test("a project's agent file that is a symbolic link is found", async ($: any, on: any) => {
    const file = '/p/.claude/agents/store-reviewer.md'
    setup(on, { files: { [file]: REVIEWER }, links: [file] })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(await ui.find({ type: 'Text', text: /store-reviewer · type copied/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('Workflow reading', () => {
  const OFF = { options: { workflowReading: 'off' } } as any
  const models = async ($: any) => (await $.command.run({ command: 'redhelm', args: 'models', origin: { kind: 'person' }, presentation: {} } as any)).text as string

  test('off: Save and Earlier ask nothing, and what was seen is the draft, shown quietly and saved', OFF, async ($: any, on: any) => {
    const asked: any[] = []
    const writes = setup(on, { asked, said: [you('one'), lead(call('a1')), you('two'), lead(call('a2', { description: 'Add tests' }))] })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect((await ui.find({ key: 'wf-item-0' }))?.text).toMatch(/Add tests/)
    await ui.press({ key: 'wf-earlier' }); await settle()
    expect((await ui.find({ key: 'wf-item-0' }))?.text).toMatch(/Write the docs/)
    // Complete at once: no Reading…, no `read` mark, and no warning, which is for a reading that failed.
    for (const text of [/^Reading…$/, /^read$/, /Couldn't read/]) expect(await ui.find({ type: 'Text', text })).toBeUndefined()
    expect(await ui.find({ key: 'wf-edit' })).toBeUndefined()
    expect(asked).toEqual([])
    await ui.press({ key: 'wf-keep' }); await settle()
    expect(JSON.parse(Object.values(writes)[0]!)).toMatchObject({ name: 'Write the docs, Add tests', purpose: '', lead: { playbook: [] }, stages: [{ agents: [{ label: 'Write the docs' }] }, { agents: [{ label: 'Add tests' }] }] })
    expect(await models($)).toMatch(/\nREDhelm's own model calls \(labels: Haiku, low effort; workflows: off\): 0 requests, /)
    await ui.unmount()
  })

  test('off: ✎ text, or a ✎ mode left from before, asks nothing and never reaches Claude', OFF, async ($: any, on: any) => {
    const asked: any[] = []
    const box = promptBox(on)
    // A ✎ mode from before Workflow reading was turned off (a change in /config reloads REDhelm; its session state stays), until REDhelm writes the mode.
    let stale = false
    on('state.get', async (_$: any, e: any, next: any) => {
      const r = await next(e)
      return stale && e.plugin === 'redhelm' && e.key === 'workflowMode' ? { value: { ...r.value, value: { kind: 'edit' } } } : r
    })
    on('state.set', (_$: any, e: any, next: any) => ((e.plugin === 'redhelm' && e.key === 'workflowMode' && (stale = false)), next(e)))
    setup(on, { asked })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    stale = true
    const off = 'REDhelm: Edit is off · Workflow reading is off in /config'
    expect((await $.prompt.submit({ text: '✎ Workflow: drop the review' })).drop).toBe(off)
    expect(stale).toBe(false) // the mode ended
    await clock.advance(200); await settle()
    expect((await $.prompt.submit({ text: '✎ Workflow: drop the review' })).drop).toBe(off) // typed by hand, the sheet open
    await clock.advance(200); await settle()
    expect(asked).toEqual([])
    expect(box.passed).toEqual([])
    expect(await ui.find({ key: 'wf-item-2' })).toBeDefined()
    await ui.unmount()
  })

  test('Edit is offered, and starts, only on a read draft, and never with Workflow reading off', () => {
    const draft = readWorkflow({ msgs: said, records: {}, teams: {}, list: stretches(said), back: 0, root: '/p', lead: {} })!
    const sheet = (read: Draft['read']) => ({ mode: 'review' as const, draft: { ...draft, read }, undo: [], token: 1 })
    expect(['done', 'failed', 'pending'].map(read => editable(sheet(read as Draft['read']), true))).toEqual([true, true, false])
    // Off: no draft takes an edit, whatever its reading, so neither the sheet's Edit nor a press left from before starts one.
    expect(['done', 'failed', 'off'].map(read => editable(sheet(read as Draft['read']), false))).toEqual([false, false, false])
    expect([editable({ mode: 'review', undo: [], token: 1 }, true), editable({ mode: 'saved', id: 'x' }, true), editable(null, true)]).toEqual([false, false, false])
  })

  test('sonnet, the default: one reading per Save, and Edit is offered', { options: { workflowReading: 'sonnet' } } as any, async ($: any, on: any) => {
    const asked: any[] = []
    setup(on, { asked })
    await engine(on, true)($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'wf-save' }); await settle()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject(READING_CALL)
    expect(await ui.find({ type: 'Text', text: /^Tests, then a review$/ })).toBeDefined()
    expect(await ui.find({ key: 'wf-edit' })).toBeDefined()
    expect(await models($)).toMatch(/workflows: Sonnet, low effort\): 1 request, /)
    await ui.unmount()
  })
})
