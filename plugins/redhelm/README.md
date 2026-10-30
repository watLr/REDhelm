# REDhelm

A live control panel for your Claude Code agents. REDhelm docks a sidebar beside the conversation with one row per agent: what it is doing, a trace of its tool calls, and how long it has run. An agent that asks you something waits at the top with **Reply**, so you can answer it without leaving the terminal. A model guard holds your prompt if Claude Code switches models without you.

<img src="https://raw.githubusercontent.com/watLr/redhelm/main/docs/images/redhelm-right.png" alt="REDhelm docked beside a Claude Code conversation: one agent asks a question, three are working" width="920">

## Install

```sh
claude plugin marketplace add watLr/redhelm
claude plugin install redhelm@redhelm
```

Restart running sessions (`/restart`), then run `/redhelm` once to open it. After that it opens by itself when agents start.

## Requirements

- Claude Code CLI 2.1.289 or newer
- For the sidebar: Claude Code's fullscreen layout (`/tui fullscreen`) and a terminal at least 110 columns wide. Otherwise REDhelm sits above the prompt.
- Optional: `python3`, for the status line REDhelm's setup card offers

## Features

- **Live agent list:** each agent's state, name, activity trace, run time and token rate, in its own colour
- **Questions first:** an agent that asks you something gets an amber card with **Reply**
- **Agent sheet:** click an agent for its task, steps, files, model and last words, with **Message** and **Stop**
- **Headlines:** a few words under each agent, from Claude Code's small model, or plain words if you prefer
- **Model guard:** holds your prompt if Claude Code switches models on its own
- **Workflows:** save how a session's agents were led and staffed, and run it again later from **Load**
- **Two layouts:** a sidebar on the right, or a bar above the prompt (`/redhelm bottom`)
- **Light and dark:** follows Claude Code's theme

## Privacy and cost

REDhelm reads your project folder and Claude Code's session data on your machine, and keeps what it remembers there too. Installed from its own marketplace, it checks GitHub a few times a day for a newer version, sending nothing about you; from the plugin directory, the directory's updates apply instead. Headlines are short requests to Claude Code's small model that count toward your usage; set **Labels** to plain in `/config` to turn them off. A workflow's **Save** and **Edit** ask Claude Code's Sonnet, only when you press them; set **Workflow reading** to off to turn that off. The details are in the [main README](https://github.com/watLr/redhelm#privacy-and-cost).

## More

Screenshots, a demo, every setting and troubleshooting: [github.com/watLr/redhelm](https://github.com/watLr/redhelm). MIT licensed.
