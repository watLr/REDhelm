# Contributing to REDhelm

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

- **Found a bug?** [Open a bug report](https://github.com/watLr/redhelm/issues/new?template=bug_report.yml).
- **Have an idea?** [Suggest a feature](https://github.com/watLr/redhelm/issues/new?template=feature_request.yml).
- **Want to change code?** For anything bigger than a small fix, open an issue first so we can agree on the shape before you build it.

Issues are public. Leave out anything private: your name, file paths from your home folder, project names, prompts, usage limits.

## Run a working copy

You need Claude Code 2.1.289 or newer.

```sh
git clone https://github.com/watLr/redhelm.git
cd redhelm
claude --plugin-dir ./plugins/redhelm
```

If you also have REDhelm installed, turn that copy off while you work (`claude plugin disable redhelm@redhelm`), so only one copy loads. Claude Code reloads the working copy when you save a file.

## Where things are

| Path | What it holds |
|---|---|
| [`plugins/redhelm/hooks/register.tsx`](plugins/redhelm/hooks/register.tsx) | Wiring: the events REDhelm hooks, its commands, what it remembers |
| [`plugins/redhelm/hooks/view.tsx`](plugins/redhelm/hooks/view.tsx) | Drawing: the sidebar, the bar above the prompt, the agent sheet |
| [`plugins/redhelm/hooks/model.ts`](plugins/redhelm/hooks/model.ts) | Pure logic: settings, model versions, agent states and names, questions, board parsing |
| [`plugins/redhelm/hooks/trace.ts`](plugins/redhelm/hooks/trace.ts), [`backdrop.ts`](plugins/redhelm/hooks/backdrop.ts) | Activity traces and backgrounds, pure: times in, cells out |
| [`plugins/redhelm/hooks/labels.ts`](plugins/redhelm/hooks/labels.ts) | The headlines asked of Claude Code's small model, cached and capped |
| [`plugins/redhelm/hooks/sources.ts`](plugins/redhelm/hooks/sources.ts) | Workflow boards read from the project |
| [`plugins/redhelm/statusline/`](plugins/redhelm/statusline) | The optional Python status lines the setup card offers |
| [`plugins/redhelm/types/index.d.ts`](plugins/redhelm/types/index.d.ts) | The shape of everything REDhelm keeps in plugin state |
| [`plugins/redhelm/tests/`](plugins/redhelm/tests) | Tests, run by Claude Code's plugin test runner |

## Before you open a pull request

```sh
claude plugin validate --strict plugins/redhelm
claude plugin test plugins/redhelm
```

Both must pass. For a change to what REDhelm draws, add a screenshot or a short recording to the pull request.

A few rules that keep REDhelm safe to run in every session:

- **Fail open.** A REDhelm error must never block a prompt, a tool call or an agent. Gating hooks end in `.catch(($, e, next) => next(e))`, and bookkeeping runs inside `quietly`.
- **Stay quiet.** No redraw unless something shown changed; timers run only while something on screen needs them.
- **Spend the user's tokens rarely.** Calls to the small model are capped, cached and shown in `/redhelm models`. A new kind of call needs the same care, and a setting to turn it off.
- **Ask before changing settings.** REDhelm changes Claude Code settings only when the person presses **Apply**.
- **Use plain words.** Labels and messages say what is happening in short, ordinary sentences.
- **Keep private data out.** Test fixtures, screenshots and examples use made-up projects and text: no real names, paths, emails or session ids.

Match the code around your change: its naming, its comment style and how much it comments.

## Releases

The maintainer bumps the version in [`plugin.json`](plugins/redhelm/.claude-plugin/plugin.json) and writes the release notes; please leave the version as it is in your pull request.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
