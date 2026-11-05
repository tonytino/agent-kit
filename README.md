# agent-kit

Tools for building with coding agents: skills, plugins, hooks, CI actions.

| Tool | Type | Purpose |
| --- | --- | --- |
| [pr-visuals](#pr-visuals) | Skill, CLI, GitHub Action | Put before/after screenshots and videos of a web app into PR descriptions. Gate PRs with labels. |
| [block-self-bind-schedule](#block-self-bind-schedule) | Claude Code hook plugin | Deny tool calls that schedule wakeups of the current session. |

## Install

### Claude Code

```
/plugin marketplace add tonytino/agent-kit
/plugin install pr-visuals@agent-kit
/plugin install block-self-bind-schedule@agent-kit
```

### Other agents

[`pr-visuals/skills/pr-visuals`](pr-visuals/skills/pr-visuals) is an [Agent Skills](https://agentskills.io/specification) skill. Agents that read `SKILL.md` skills can use it. Copy or link the directory into the agent's skills directory.

The Claude plugin wrapper is for Claude Code. `block-self-bind-schedule` is a Claude Code hook. It works only in Claude Code.

## pr-visuals

**Problem.** Reviewers cannot see a UI change from a diff. Agents open PRs without screenshots, or with screenshots of the whole app.

**What it does.** An agent writes a scenarios block into the PR body. The block lists only the pages and flows that the PR changes. pr-visuals opens each one on the before URL and the after URL with Playwright. It writes a before/after table of screenshots, and links to optional videos, into the PR body.

**Labels control it.** Nothing runs automatically.

| Label | Description |
| --- | --- |
| `visuals:none` | No UI impact. The pr-visuals check passes. |
| `visuals:generate` | Capture before/after visuals into the PR body. The job removes this label. |
| `visuals:still-valid` | The visuals still match this commit. Use after changes that do not affect the UI. The job removes this label. |

The `pr-visuals-check` status passes when one of these is true:

- The PR has `visuals:none`.
- A capture for the head commit has no failed cells.
- `visuals:still-valid` confirmed the head commit, and the last capture has no failed cells.

**Parts.**

- Skill: [`SKILL.md`](pr-visuals/skills/pr-visuals/SKILL.md). Tells the agent when and how to add visuals.
- CLI: commands `check`, `generate`, `still-valid`, `capture`, `render`, and `publish`. The CLI is not on your PATH. Run it as `node <clone>/pr-visuals/cli/pr-visuals.mjs`.
- GitHub Action: [`pr-visuals/action.yml`](pr-visuals/action.yml). Pin it to a commit of a `pr-visuals-vX.Y.Z` tag.

**Set up CI.** Follow [`references/ci.md`](pr-visuals/skills/pr-visuals/references/ci.md). It also covers the trust model, security, and the `pr-visuals` branch. Examples: [`examples/`](pr-visuals/examples).

**Use without CI.** The skill describes a local path. The agent runs `capture` and `publish`, then pastes the block into the PR body. This needs Node.js 22 or later, Playwright Chromium, and push access to the repository.

## block-self-bind-schedule

Requires `jq` on the machine that runs the session.

**Problem.** An agent can schedule its own session to wake later, for example an hourly "check-in" while it watches a pull request. Each wake resends the full conversation. On a long session this drains usage with no benefit over a reactive subscription.

**What it does.** A `PreToolUse` hook denies these calls:

| Tool | Denied when |
| --- | --- |
| `send_later` | Always. |
| `create_trigger` | No `persistent_session_id` and no `create_new_session_on_fire: true`, or `persistent_session_id` is the current session. |
| `update_trigger` | It sets `enabled: true`, `cron_expression`, or `run_once_at`. |
| `CronCreate` | Always. |
| `ScheduleWakeup` | Always, except `stop: true`. |

The MCP tools match on any server name. Triggers that spawn a fresh session or target a different session pass. So do rename, prompt, and disable updates.

A `SessionStart` hook reminds you what is blocked and tells the model not to try.

The hook fails closed. If `jq` is missing or the policy errors, the call is denied and the reason names the fix.

### Change the mode

Set `BLOCK_SELF_BIND_SCHEDULE` in the environment that launches Claude Code, then restart it. The model cannot change this from inside a session.

| Value | Effect |
| --- | --- |
| unset or `deny` | Deny the calls above. Default. |
| `ask` | Prompt you to approve each call. Sessions that cannot prompt deny. |
| `off` | Allow everything. |

## Develop

```
test/run.sh
cd pr-visuals && npm ci && npm test
```

`test/run.sh` runs the `block-self-bind-schedule` cases in `test/cases.json`. `npm test` runs the pr-visuals unit tests and one browser test. CI runs both, `shellcheck`, and JSON validation.

Contributor and agent rules: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
