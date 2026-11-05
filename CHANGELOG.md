# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each tool has its own versions. They follow [SemVer](https://semver.org/). Tool tags have the form `<tool>-vX.Y.Z`. Repository changes that are not part of a tool go under a "Repository" heading.

## [Unreleased]

## Repository - 2026-11-05

### Changed
- The repository and marketplace name is `agent-sdk`. Run `/plugin marketplace add tonytino/agent-sdk`, then reinstall each plugin with `@agent-sdk`, for example `/plugin install block-self-bind-schedule@agent-sdk`. Old repository URLs redirect.
- CI pins GitHub Actions to full commit SHAs.

### Added
- `AGENTS.md` with repository rules, and `CLAUDE.md` that imports it.
- CI job that runs the pr-visuals tests.

## [pr-visuals 0.1.0] - 2026-11-05

### Added
- `pr-visuals` skill, CLI, and GitHub Action. Put before/after Playwright screenshots and videos of a web app into PR descriptions.
- Labels `visuals:none`, `visuals:generate`, and `visuals:still-valid`, and the `pr-visuals-check` status.

## [block-self-bind-schedule 0.2.0] - 2026-09-11

### Added
- Deny `create_trigger` when `persistent_session_id` is the current session.
- Deny `update_trigger` calls that re-arm a schedule.
- Deny `CronCreate` and `ScheduleWakeup`.
- `BLOCK_SELF_BIND_SCHEDULE` environment variable with modes `deny`, `ask`, and `off`.
- `SessionStart` reminder for the user and the model.
- Tests, CI, LICENSE, CHANGELOG.

### Changed
- Match `send_later`, `create_trigger`, and `update_trigger` on any MCP server name.
- Fail closed when `jq` is missing or the policy errors.
- Shorter deny reasons and descriptions.

## [block-self-bind-schedule 0.1.0] - 2026-09-09

### Added
- `block-self-bind-schedule` plugin. Denies `send_later` and self-bind `create_trigger`.

[Unreleased]: https://github.com/tonytino/agent-sdk/commits/main
[pr-visuals 0.1.0]: https://github.com/tonytino/agent-sdk/releases/tag/pr-visuals-v0.1.0
[block-self-bind-schedule 0.2.0]: https://github.com/tonytino/agent-sdk/compare/v0.1.0...v0.2.0
[block-self-bind-schedule 0.1.0]: https://github.com/tonytino/agent-sdk/releases/tag/v0.1.0
