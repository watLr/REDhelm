export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type Agent = {
  id: string
  name: string
  type: string
  description: string
  status: AgentStatus
  model?: string
  effort?: string
  /** The instructions it was started with (first 2000 characters). */
  brief?: string
  /** Its last few actions, newest first, for the agent sheet. */
  /** Newest first; `at` is unknown for steps read back from a conversation REDhelm did not watch. */
  steps: { text: string; at?: number }[]
  /** The last thing it wrote while working, a sentence or two. */
  thinking?: string
  /** The agent it messaged and is waiting on, until it gets back to work. */
  waitingOn?: string
  /** What it is doing right now: the last tool call, short. */
  activity?: string
  /** The kinds of its last few tool calls, newest last; its phase is read from them. */
  recent: Phase[]
  /** Files it changed, newest last, relative to the session root. */
  files: string[]
  edits: number
  /** Commands that came back as errors. */
  fails: number
  /** Tokens in its context at the last model request. */
  context: number
  startedAt: number
  endedAt?: number
  /** First meaningful line of its final answer. */
  answer?: string
  /** What it is doing, in six words or fewer, from the small model; the plain words show without it. */
  headline?: string
  /** What the headline was written from (labels.headlineKey) and when: it changes only when the work did, at most every 45 seconds. */
  headlineFor?: string
  headlineAt?: number
  /** The built-in workflow run that started it (`wf_…`). */
  run?: string
  /** The agent that started it; absent when the main conversation did. */
  parent?: string
  teammate?: boolean
  /** Where its type comes from: `project`, `user`, a plugin id, or `engine` for a built-in. */
  origin?: string
  /** Its tool calls by tool, an MCP tool under `mcp:<server>`; absent on records from before REDhelm kept them. */
  tools?: Record<string, number>
  /** The skills it loaded, once each, in order. */
  skills?: string[]
}

export type Phase = 'exploring' | 'building' | 'checking' | 'delegating'

export type NoteKind = 'spawn' | 'done' | 'fail' | 'ask' | 'report' | 'reply' | 'guard'

export type Note = { at: number; kind: NoteKind; text: string; agentId?: string }

/**
 * What an agent sent you. `ask`: it waits on an answer (absent on messages kept from before REDhelm told
 * them apart). `title`: the question in eight words or fewer, from the small model.
 */
export type Message = { id: string; agentId: string; text: string; at: number; ask?: boolean; title?: string }

/** A newer REDhelm than the one installed, and how updating it went. */
export type Release = { id: string; installed: string; latest: string; state?: 'updating' | 'updated' | 'failed'; detail?: string }

export type StageRow = { id: string; stages: Record<string, string>; note: string; at: number }

export type Lane = { id: string; title: string; done: number; total: number; active?: string; agent?: string }

export type Run = { name: string; status: string; next?: string; open: number }

export type Workspace = {
  dir: string
  name: string
  /** REDStudio: standards count and the newest one's title. */
  studio?: { standards: number; latest?: string }
  /** status-board: stage names and the rows still open. */
  board?: { stages: string[]; rows: StageRow[]; total: number }
  /** Lane board: lanes.json and per-lane events. */
  lanes?: Lane[]
  /** REDManager runs, newest first. */
  runs?: Run[]
}

/** One Claude Code setting REDhelm would change, shown on the setup card. */
export type SetupItem = { key: string; label: string; value: string | boolean }

/** This session's model requests: what actually answered, main thread and agents together. */
export type Usage = Record<string, { requests: number; output: number; agents: number }>

/** Where the person wants REDhelm: the right dock (inline when the layout cannot dock) or the band above the prompt. */
export type Placement = 'right' | 'bottom'

export type Guard = {
  model?: string
  effort?: string
  /** "from → to" when Claude Code switched models on its own. */
  fallback?: string
  /** The saved default this session no longer matches. */
  stale?: string
}

export type SavedWorkflow = {
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

export type Lead = {
  skills: string[]      // skills the lead loaded, in order, no repeats: ["redmanager"]
  playbook: Practice[]  // how the lead worked, read from the session and confirmed (§4)
  briefParts: string[]  // paragraphs most briefs shared, verbatim (§4)
  model?: string        // what the lead ran on
  effort?: string
}

export type Practice = { when: string; do: string }   // each ≤ 120 characters

export type SavedRole = {
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

export type SavedAgent = {
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

export type SavedType = {
  name: string          // as the project named it: "store-reviewer"
  definition: string    // its agent file, whole, as it was at Save
}

/** What Save read from the session. It carries both `roles` and `stages`, so `Save as` switches without reading again. */
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

declare module 'claude-code' {
  interface PluginState {
    redhelm: {
      agents: Record<string, Agent>
      notes: Note[]
      inbox: Message[]
      workspaces: Workspace[]
      guard: Guard
      composing: string | null
      now: number
      placement: Placement
      /** Bottom placement only: folded down to the one-line alert. */
      collapsed: boolean
      /** Settings still to apply; empty once applied or set aside. */
      setup: SetupItem[]
      usage: Usage
      /** Whether finished agents are listed or folded into one line. */
      showDone: boolean
      /** What you were writing to Claude, kept while you write to an agent; it comes back after. */
      draft: string | null
      release: Release | null
      /** The agent whose sheet is open. */
      inspecting: string | null
      /** Whether the sheet shows the agent's whole brief. */
      briefOpen: boolean
    }
  }
}
