# AGENTS.md

Rules for agents and people who change this repository.

## Layout

```
.claude-plugin/marketplace.json   Claude Code marketplace "agent-kit". Lists every plugin.
block-self-bind-schedule/         Claude Code hook plugin.
  .claude-plugin/plugin.json
  hooks/                          hooks.json, guard.sh, guard.jq, remind.sh
pr-visuals/                       Skill, CLI, and GitHub Action.
  .claude-plugin/plugin.json
  skills/pr-visuals/              Agent Skills skill: SKILL.md, references/
  cli/pr-visuals.mjs              CLI entry point
  src/                            CLI modules
  test/                           node:test tests
  action.yml                      Composite GitHub Action
  examples/                       Consumer workflow and config
test/                             Tests for block-self-bind-schedule
.github/workflows/test.yml        CI
```

## Test

Run these before you commit:

```
test/run.sh
cd pr-visuals && npm ci && npm test
```

CI also runs `shellcheck` on shell scripts and validates every JSON file.

## Add a tool

1. Create a directory at the root, named for the tool. Use lowercase letters, numbers, and hyphens.
2. For a skill, add `<tool>/skills/<skill-name>/SKILL.md`. Follow the [Agent Skills specification](https://agentskills.io/specification):
   - `name` equals the skill directory name.
   - `description` says what the skill does and when to use it. Maximum 1024 characters.
   - Keep `SKILL.md` under 500 lines. Put detail in `references/`, one level deep.
3. Add `<tool>/.claude-plugin/plugin.json` for every Claude Code plugin. This is a repository convention.
4. Add an entry to `.claude-plugin/marketplace.json`. Keep the version equal to `plugin.json`.
5. Add tests. Add them to `.github/workflows/test.yml`.
6. Add a row to the tools table and a section in `README.md`.
7. Add an entry to `CHANGELOG.md` under a `## [<tool> X.Y.Z] - YYYY-MM-DD` heading.

## Release a tool

1. Set the version in `plugin.json`, `marketplace.json`, and `package.json` if the tool has one.
2. Move the `CHANGELOG.md` entry under the version heading. Add the link reference to the tag.
3. After the merge, tag the commit `<tool>-vX.Y.Z`, for example `pr-visuals-v0.1.0`. Push the tag.

## Conventions

- Hooks fail closed.
- Pin third-party GitHub Actions to a full commit SHA with a version comment.
- Do not put untrusted event fields (labels, PR bodies, titles) into `run:` scripts. Pass them through `env`.
- pr-visuals: plain ESM JavaScript with JSDoc. No runtime dependency other than `playwright`.
- Commit messages follow Conventional Commits.

## Writing

Apply these rules to docs, skills, comments, and messages.

- Follow ASD-STE100 style: short sentences, active voice, one idea per sentence.
- Lead with the action.
- Be terse. Cut words that add no meaning.
- Describe the current state only. Do not write "previously", "now", or "no longer".
- Do not use em dashes. Use few semicolons.
- Use the same term for the same thing everywhere.
