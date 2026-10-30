# REDhelm privacy policy

Effective: 2026-10-30

REDhelm is a plugin for Claude Code. It runs on your computer, inside Claude Code. It has no server of its own, no account and no analytics. This policy says what REDhelm reads, what it keeps, what leaves your machine, and how to turn each part off.

## What it reads

Everything REDhelm reads, it reads on your machine.

- **Your project's files.** Work boards in the project folder, in the few folders above it and in the folders right inside it: lane boards (`docs/aaa/board/`), status boards (`.status-board/`), REDStudio (`.redstudio/`) and REDManager (`.redmanager/`). For workflows, the agent type files in the project's `.claude/agents/` folder. When you press **Run** on a workflow that carries copied agent types, also the agent files in `~/.claude/agents/`, to see which types you already have.
- **Claude Code's session data.** This session's conversation, each agent's own conversation, the agents Claude Code lists, and which models answered.
- **Claude Code's settings.** Your model and theme, the `/config` rows its setup card offers, and `~/.claude/settings.json` for its status lines.
- **Your installed plugins.** It runs `claude plugin list` to see which REDhelm is installed and where it came from, for the update check.
- **Your computer.** Whether your desktop is light or dark (for Claude Code's `auto` theme), and whether `python3` runs (for its status lines).
- **Your saved workflows**, in `~/.claude/redhelm/workflows/`, when you press **Load** or **Run**.

If you apply its status lines, their scripts read what Claude Code hands a status line, the session's conversation file and your settings files, to show the model that actually answered.

## What it keeps, and for how long

- **For this session only.** What the panel shows (your agents, their steps, the questions they asked) is kept in Claude Code's session state. It lasts as long as the session.
- **Across sessions, in REDhelm's plugin storage.** This is a file of REDhelm's own that Claude Code keeps in its configuration folder on your machine. It holds:
  - model switches: when, from which model to which, and how the switch was made, such as by you or by Claude Code on its own (the latest 100);
  - the newest version of each model family seen;
  - which setup card items you applied or set aside;
  - the release check: when it ran, which REDhelm is installed and its version, and the latest version published.
- **In `~/.claude/redhelm/`.**
  - `statusline/` and `state/`: copies of REDhelm's status line scripts, and the newest model versions they have seen. These exist only if you applied the status lines.
  - `workflows/`: the workflows you save, one file each, never in your project. A workflow holds what its review sheet showed you before you pressed **Save**: its name and purpose, the lead's skills and practices, the team (and in a lineup each agent's brief, as written), copies of the project's own agent type files, the project folder's name, and when you saved it. The folder's full path is never saved, only a hash of it. A workflow stays until you delete it with **Delete**, which empties its file, or remove the file yourself.
- **In Claude Code's settings.** REDhelm changes them only when you press **Apply** on its setup card, as if you had changed them in `/config`, and writes its status lines into `~/.claude/settings.json`. After that, it keeps a status line you applied pointing at its copy in `~/.claude/redhelm/`, so an update never breaks it. These settings are Claude Code's own, and so is what they do: one of them, if you apply it, has Claude Code push a notification to your phone when a question is waiting. `/redhelm right` and `/redhelm bottom` change REDhelm's own placement setting.

REDhelm writes no file into your project.

## What leaves your machine

- **The update check.** Only a copy installed from REDhelm's own marketplace checks. It reads REDhelm's published version number from GitHub (`raw.githubusercontent.com`), shortly after a session starts and every six hours; one check serves all your open sessions for an hour. The request carries nothing about you or your work. GitHub receives it as it receives any web request. A copy from another marketplace, such as the plugin directory, or from a local folder, never checks. When you press **Update** or run `/redhelm update`, REDhelm runs Claude Code's own plugin update, which downloads the new version from the marketplace.
- **Model calls.** REDhelm asks Claude Code's models for a few things. Each request goes through Claude Code, with your session's own credentials, to the same provider as the rest of your session, and counts toward your usage. REDhelm sends them nowhere else.
  - **Headlines and question titles** (Claude Code's small model, Haiku, at low effort), only while REDhelm is on screen. Each request carries an agent's task (its first 300 characters), its latest steps and words, or a question an agent asked. One request at a time, and no more than 30 an hour.
  - **Telling a question from a report** (Claude Code's small model). Each message an agent sends to the main conversation is read once, to see whether it waits for your answer. The request carries the message, with your project and home folder paths shortened. It runs whatever the **Labels** setting.
  - **Workflow reading** (Sonnet, at low effort), only when you press **Save** or **Earlier**: one request each time. It carries your prompts and each agent's brief at their first 300 characters, each agent's description, the skills the lead loaded, the lead's steps (a command as its program and subcommand only), and the first 6,000 characters of any workflow script it ran.
  - **Workflow edits** (Sonnet, at low effort): one request for each change you send with **Edit**. It carries the draft, with its briefs and shared brief parts whole (up to 6,000 characters each), and what you asked for.

  `/redhelm models` shows how many requests the headlines and the workflow calls made this session.
- **Nothing else.** Desktop notifications after long turns are shown by your own system.

## What it never does

- No analytics, no telemetry, no tracking.
- No server of REDhelm's own: only what this policy lists leaves your machine.
- Nothing is sold or shared.
- A workflow is never saved into your project or published.

## Saved workflows in later sessions

A saved workflow does nothing on its own. It affects a later session only when you open it from **Load** and press **Run**. Your prompt then carries the whole plan, written out under your run line, so the conversation shows everything Claude got. Run may also add the workflow's copied agent types to Claude Code for that session, named `redhelm:<name>`; it writes no agent file.

## Turning each part off

- **Headlines and question titles:** set **Labels** to plain in `/config`.
- **Workflow reading and edits:** set **Workflow reading** to off in `/config`. Save then keeps only what REDhelm saw, and Edit is not offered.
- **A saved workflow:** open it from **Load** and press **Delete** twice, or remove its file from `~/.claude/redhelm/workflows/`.
- **All of it:** disable or uninstall REDhelm (`claude plugin disable` or `claude plugin uninstall`). This also stops the update check and the question check, which have no setting of their own. REDhelm has no step that removes what it kept: delete `~/.claude/redhelm/`, and its status lines in `~/.claude/settings.json`, if you want them gone.

## Headless runs

REDhelm leaves headless runs alone (`claude -p`, the SDK and other non-interactive sessions). There it starts no checks, keeps no records and makes no model calls.

## Contact

Questions about this policy or about REDhelm and your data: open an issue at [github.com/watLr/redhelm/issues](https://github.com/watLr/redhelm/issues). Issues are public, so leave out anything private.

A change to this policy comes with a new Effective date above.
