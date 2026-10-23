<div align="center">

# REDhelm

**A live control panel for your Claude Code agents.**<br>
See what every agent is doing, answer the ones that need you, and know which model is really answering, without leaving the terminal.

[![Release](https://img.shields.io/github/v/release/watLr/redhelm?color=d6363c&label=release)](https://github.com/watLr/redhelm/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-555)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.289%2B-555)](https://claude.com/claude-code)

<img src="docs/images/redhelm-right.png" alt="REDhelm docked beside a Claude Code conversation: one agent asks a question, three are working" width="920">

</div>

## Install

```sh
claude plugin marketplace add watLr/redhelm
claude plugin install redhelm@redhelm
```

Then restart running sessions (`/restart`). REDhelm opens by itself when agents start, or run `/redhelm`.

**Needs:** Claude Code 2.1.289 or newer. The sidebar needs the fullscreen layout (`/tui fullscreen`) and a terminal at least 110 columns wide; otherwise REDhelm sits above the prompt.

## At a glance

<img src="docs/images/redhelm-live.gif" alt="REDhelm live: activity traces grow, rings cross the background, an agent finishes" width="360" align="right">

- **Live agent list.** One aligned row per agent: its state, name, a trace of its tool calls, and how long it has run.
- **Questions first.** An agent that asks you something gets an amber card with **Reply**, at the top.
- **Plain words.** A short headline under each agent, written by Claude Code's small model.
- **One click deep.** Click an agent for its task, steps, files, model and last words.
- **Message and Stop.** Point at a working agent to message it or stop it.
- **Model guard.** Holds your prompt if Claude Code switches models on its own.
- **A live background.** Each tool call sends a ring through the sidebar in its agent's colour.
- **Light and dark.** Follows Claude Code's theme.

<br clear="right">

## What you see

### Every agent is a live signal

Each agent has its own colour: a stripe down its row, and a trace of its tool calls over the last half minute, brightest at the newest call and fading into the past. The trace moves while the agent works and flattens when it goes quiet. Under REDhelm's name, a thin line in the same colours shows each working agent's share of the last minute's calls, so the busiest one is the longest.

| Glyph | State |
|:---:|---|
| `▶` | working |
| `▷` | quiet: no action for 15 minutes |
| `◆` | waiting on another agent, or on work it started |
| `⚑` | asks you something |
| `✓` | finished |
| `✕` | failed or stopped |

The header counts them (`⚑ 1  ▶ 3  ✓ 2`). Finished agents fold into one line until you want them.

### Questions that wait for you

An agent that asks you something gets an amber-edged card with its question in a line, **Reply**, and **Details**. Reply fills your prompt with `→ name: `; type and press Enter, and it goes to that agent instead of Claude. Anything you were typing to Claude is kept and comes back after.

REDhelm tells a question from a report: Claude Code's small model reads each message (with a plain check of the wording if it can't be reached). A report becomes the agent's last words instead of asking for you. A question clears once you or Claude answer it; one from an agent that has ended stays 30 minutes (a reply still reaches it), with **Dismiss** to put it away sooner.

### Everything about one agent

<img src="docs/images/redhelm-sheet.png" alt="An agent's sheet: its trace over the last minute, task, steps, files, model and last words" width="330" align="right">

Click an agent to open its sheet in place of the list:

- its activity over the last minute
- **Message** and **Stop**, first, so they're never scrolled away
- the task it was given (with **More** for the whole brief)
- its latest steps, with how long ago
- the files it changed
- its model, effort and context size
- its last words

**← Back** returns to your agents. Agents that started before REDhelm loaded are filled in from Claude Code's record of their conversation.

<br clear="right">

### A background that moves with the work

<img src="docs/images/redhelm-backgrounds.png" alt="The four sidebar backgrounds: ripples, lattice, field and ember" width="920">

The sidebar sits on black with a quiet grid of `+` signs. Each tool call sends a ring through the grid in its agent's colour, starting from its place on the activity line. Rows sit on plates of the background colour, so text never lands on the pattern. Choose another in `/config` → **Background**: a still grid, drifting ASCII clouds, a slow red glow, or none.

### Light and dark

<img src="docs/images/redhelm-light.png" alt="REDhelm in Claude Code's light theme" width="330" align="right">

REDhelm follows Claude Code's theme (`/theme`): black with a grey grid in a dark theme, white with a light grey grid in a light theme. With `auto` it follows your desktop's appearance.

If your terminal is light but Claude Code's theme is dark, Claude Code draws dark-theme colours, and so does REDhelm. Set `/theme` to light to match.

<br clear="right">

### Above the prompt

<img src="docs/images/redhelm-bottom.png" alt="REDhelm as a bar above the prompt: a question and two working agents, one line each" width="920">

`/redhelm bottom` lays the same panel out as a bar above the prompt, one line per agent, with names in one column. With the panel closed, a single line appears there only when something needs you.

### And quietly, in the background

- **Model guard.** If Claude Code switches models on its own, your next prompt and Claude's tools wait until you choose with `/model`. If your saved default moved to a newer version, the session tells you once. `/redhelm models` shows which models actually answered.
- **Where work lands.** A warning when two live agents edit the same file.
- **Workflows.** Shows progress from lane boards (`docs/aaa/board/lanes.json`), status boards (`.status-board/`), REDStudio (`.redstudio/`) and REDManager (`.redmanager/`) in the project.
- **Long-turn notifications.** A desktop notification (macOS, Linux) when a long turn finishes.
- **Updates.** When a newer REDhelm is published, a quiet line at the bottom of the panel offers **Update**. Nothing pops up.

## Commands

| Command | What it does |
|---|---|
| `/redhelm` | Open or close the panel |
| `/redhelm right` · `/redhelm bottom` | Sidebar beside the conversation, or a bar above the prompt |
| `/redhelm setup` | Review the Claude Code settings REDhelm recommends |
| `/redhelm models` | Which models answered this session, recent switches, and what REDhelm's labels used |
| `/redhelm update` | Install a newer REDhelm, if there is one (then `/reload-plugins`) |

You can also write to an agent directly: `→ name: your message`.

## Settings

Every option is a row in `/config`:

| Setting | Values | Default |
|---|---|---|
| Placement | right · bottom | right |
| Background (sidebar, terminal) | ripples · lattice · field · ember · none | ripples |
| Motion: traces move, a new question's edge flashes | on · off | on |
| Labels: headlines and question titles | haiku · plain | haiku |
| When the model changes without you | hold · warn · off | hold |
| REDhelm line under the prompt | off · problems · always | off |
| Desktop notification after (seconds) | number, 0 = off | 120 |
| Open REDhelm by itself | on · off | on |
| Pop-ups when agents finish or message you | on · off | on |

On first run REDhelm also offers a short setup card of Claude Code settings it recommends. Nothing changes until you press **Apply**:

- pause instead of switching models when safeguards flag a message
- show how long each turn took, and timestamp messages
- push to your phone when a question is waiting (where available)
- a status line with the model that actually answers and its effort, plus model and effort on each agent row (needs `python3`)

## Troubleshooting

<details>
<summary><b>Buttons don't respond to clicks</b></summary>

Clicks need Claude Code's fullscreen layout; on the classic layout the terminal keeps the mouse, and REDhelm says so under its name. Run `/tui fullscreen`. Claude Code also turns fullscreen off by itself after a couple of launches that fail to start; it stays off until you run `/tui fullscreen` (or set `CLAUDE_CODE_NO_FLICKER=1`).
</details>

<details>
<summary><b>REDhelm opens above the prompt instead of on the right</b></summary>

The sidebar needs the fullscreen layout and a terminal at least 110 columns wide. That minimum is Claude Code's own; plugins can't change it.
</details>

<details>
<summary><b>REDhelm is dark in my light terminal</b></summary>

REDhelm follows Claude Code's theme, not the terminal's. Run `/theme` and pick light (or auto).
</details>

<details>
<summary><b>I don't want the background, or the motion</b></summary>

`/config` → **Background** → none brings back the plain pane; **Motion** → off holds every trace and background still.
</details>

## Privacy and cost

REDhelm reads your project folder and Claude Code's own session data on your machine. What it remembers (model switches, the newest model versions seen, which setup items you handled) stays in Claude Code's plugin storage on your machine. It reaches out in two ways:

- **Update check.** A few times a day it reads REDhelm's published version number from GitHub. It sends nothing about you or your work.
- **Labels.** While REDhelm is on screen, it asks Claude Code's small model (Haiku, low effort) for short headlines and question titles. Each request carries an agent's task (first 300 characters), its latest steps and words, or a question an agent asked. It goes through Claude Code, to the same provider as the rest of your session, and counts toward your usage: a few hundred tokens each. One request at a time; an agent's headline is asked for again only when its steps change, at most every 45 seconds; no more than 30 requests an hour; answers are reused. `/redhelm models` shows what labels used. Set **Labels** to plain to turn them off.

REDhelm runs only in interactive sessions (`claude -p`, the SDK and other headless runs are left alone), and if it ever errors, the call it was watching goes through unchanged.

## Develop

```sh
claude plugin validate plugins/redhelm
claude plugin test plugins/redhelm
claude --plugin-dir ./plugins/redhelm   # try a working copy without installing
```

REDhelm is a Claude Code plugin built on function hooks: [`hooks/register.tsx`](plugins/redhelm/hooks/register.tsx) wires the events, [`hooks/view.tsx`](plugins/redhelm/hooks/view.tsx) draws the panel, and the traces and backgrounds are pure modules ([`trace.ts`](plugins/redhelm/hooks/trace.ts), [`backdrop.ts`](plugins/redhelm/hooks/backdrop.ts)) repainted in place on the terminal. The design notes live in [`docs/superpowers`](docs/superpowers).

## License

MIT. See [LICENSE](LICENSE).
