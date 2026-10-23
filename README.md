# REDhelm

A live sidebar for your Claude Code agents. See what every agent is doing, where its
work is landing, and which one needs you — and know which model is actually answering.

![REDhelm docked beside the conversation: one agent asks a question, two are working](docs/images/redhelm-right.png)

> **Status: early release (0.7.0).** Covered by tests and checked with real agents:
> the agent list and sheet, **Message** and **Stop**, the model guard, settings and
> workflows. Issues welcome.

## What it does

<img src="docs/images/redhelm-sheet.png" alt="An agent's sheet: its live trace, task, steps, files, model and last words" width="300" align="right">

- **Every agent is a live signal.** One row per agent, on one aligned grid: a state
  glyph, its name, a trace of its tool calls over the last half minute, and how long it
  has run. The trace moves while the agent works and flattens when it goes quiet. Under
  the name, a few words on what it is doing.
- **Each agent has its colour.** A stripe down its row, and its trace drawn as a comet
  tail: full colour at the newest call, fading to grey into the past. Under REDhelm's
  name, a thin line in the same colours shows each working agent's share of the last
  minute's tool calls, so the busiest one is the longest.
- **A live background.** In the sidebar, REDhelm sits on black with a quiet grid of `+`
  signs. Each tool call sends a ring through the grid in its agent's colour, from its
  place on the activity line. Rows sit on plates of the background's colour, so text
  never lands on the pattern. The **Background** setting also offers a still grid, drifting
  ASCII clouds (the way an ASCII video renderer draws), a slow red glow, or none.
- **States at a glance.** `▶` working · `▷` quiet (no action for 15 minutes) · `◆`
  waiting on another agent or on work it started · `⚑` asks you · `✓` finished · `✕`
  failed or stopped. The header counts them: `⚑ 1  ▶ 2  ✓ 1`.
- **Words written for you.** Claude Code's small model (Haiku, low effort) writes each
  working agent's headline ("Editing setup.md troubleshooting") and each question's
  short title, the way `/btw` answers a side question. REDhelm's own plain words show
  until a label arrives, and whenever the model is slow or switched off.
- **Agent sheet.** Click an agent for its trace over the last minute, its task, latest
  steps, the files it changed, its model and effort, and its last words. Agents that
  started before REDhelm are filled in from Claude Code's record of their conversation.
  In the sidebar the sheet takes the panel's place, with **← Back** to your agents; from
  the bar above the prompt it opens on its own and closes with Esc.
- **Message and Stop** appear when you point at a working agent, and sit at the top of
  its sheet.
- **Messaging an agent.** Message fills your prompt with `→ name: `; type and press Enter
  to send it to that agent instead of Claude (you can also type `→ name: message`
  yourself). What you were typing to Claude is kept and comes back after. Changed your
  mind? **Cancel** on the "Writing to …" line puts your draft back.
- **Needs you.** An agent that asks you something gets a card with an amber edge, its
  question in a line and a **Reply** button; the whole question is in its sheet. Claude
  Code's small, fast model tells a question from a report (with a plain check of the
  wording if the model can't be reached); a report is not a question, so it pops up
  briefly and becomes the agent's last words in its sheet instead. A
  question clears once you or Claude answer it. From an agent that has ended, it stays
  30 minutes (a reply still resumes that agent), with **Dismiss** to put it away sooner.
- **Updates.** When a newer REDhelm is published, a quiet line at the bottom of the
  panel says so, with **Update**. Nothing pops up. A copy run from a local folder is
  its own source and is never offered one.
- **Where work lands.** A warning when two live agents edit the same file.
- **Workflows.** Picks up lane boards (`docs/aaa/board/lanes.json`), status boards
  (`.status-board/`), REDStudio (`.redstudio/`) and REDManager (`.redmanager/`) in the
  project and shows their progress.
- **Model guard.** If Claude Code switches models on its own, your next prompt and
  Claude's tools wait until you choose with `/model`. If your saved default moved to a
  newer version, the session tells you once.
- **Long-turn notifications.** A desktop notification (macOS, Linux) when a long turn
  finishes.

## Install

Requires Claude Code with function-hook mods (2.1.289 or newer).

```
claude plugin marketplace add watLr/redhelm
claude plugin install redhelm@redhelm
```

Restart running sessions (`/restart`) to load it.

## Use

| Command | |
|---|---|
| `/redhelm` | Open or close the panel |
| `/redhelm right` · `/redhelm bottom` | Sidebar beside the conversation, or a bar above the prompt |
| `/redhelm setup` | Review the Claude Code settings REDhelm recommends |
| `/redhelm models` | Which models actually answered this session, recent switches, and what REDhelm's labels used |
| `/redhelm update` | Install the newer REDhelm, if there is one (then `/reload-plugins`) |

![REDhelm above the prompt](docs/images/redhelm-bottom.png)

The right sidebar needs Claude Code's fullscreen layout (`"tui": "fullscreen"`) and a
terminal at least 110 columns wide. That minimum is Claude Code's own and plugins cannot
change it; in a narrower terminal, or the classic layout, REDhelm opens above the prompt
instead.

REDhelm's buttons need the fullscreen layout too: on the classic layout the terminal keeps
the mouse, so clicks never reach them, and REDhelm says so under its name. Run
`/tui fullscreen` to turn fullscreen on. Claude Code also switches fullscreen off by itself
after a couple of launches that fail to start, and the classic layout stays until you run
`/tui fullscreen` (or set `CLAUDE_CODE_NO_FLICKER=1`).

### Setup card

On first run REDhelm offers a short list of Claude Code settings. Nothing changes until
you press **Apply**:

- Pause instead of switching models when safeguards flag a message
- Show how long each turn took, and timestamp messages
- Push to your phone when a question is waiting (where available)
- A status line with the model that actually answers and its effort, plus model and
  effort on each row of the agent panel (needs `python3`)

### Settings

Every option is a row in `/config`, per user:

| Setting | Values | Default |
|---|---|---|
| Placement | right · bottom | right |
| REDhelm line under the prompt | off · problems · always | off |
| When the model changes without you | hold · warn · off | hold |
| Desktop notification after (seconds) | number, 0 = off | 120 |
| Open REDhelm by itself | on · off | on |
| Pop-ups when agents finish or message you | on · off | on |
| Motion: traces move, a new question's edge flashes | on · off | on |
| Labels: headlines and question titles | haiku · plain | haiku |
| Background (sidebar, terminal) | ripples · lattice · field · ember · none | ripples |

## Privacy

REDhelm reads your project folder and Claude Code's own session data on your machine.
What it remembers (model switches, the newest model versions seen, which setup items you
handled) stays in Claude Code's plugin storage on your machine.

It reaches out in two ways:

- **Update check.** A few times a day it reads REDhelm's published version number from
  GitHub. It sends nothing about you or your work.
- **Labels.** While REDhelm is on screen, it asks Claude Code's small model for short
  headlines and question titles. Each request carries an agent's task (first 300
  characters), its latest steps and words, or a question an agent asked; it goes through
  Claude Code, to the same provider as the rest of your session, and counts toward your
  usage: a few hundred tokens each. At most one request runs at a time; an agent's
  headline is asked for again only when its steps change, at most every 45 seconds; no
  more than 30 requests go out in an hour; answers are reused. `/redhelm models` shows
  what labels have used this session. Set Labels to `plain` to turn them off.

## Behaviour notes

- Runs only in interactive sessions; `claude -p`, SDK and other headless runs are left
  untouched.
- If REDhelm itself ever errors, the call it was watching goes through unchanged.

## Develop

```
claude plugin validate plugins/redhelm
claude plugin test plugins/redhelm
```

Load a working copy without installing: `claude --plugin-dir ./plugins/redhelm`.

## License

MIT — see [LICENSE](LICENSE).
