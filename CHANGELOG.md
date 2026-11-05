# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/).

## [Unreleased]

## pr-visuals 0.1.0 - 2026-11-05

### Added
- `pr-visuals` 0.1.0. Puts before/after Playwright screenshots and videos of a web app into PR descriptions. Includes an Agent Skills skill, a CLI, and a GitHub Action.
- Labels `visuals:none`, `visuals:generate`, and `visuals:still-valid`, and the `pr-visuals / check` status.
- `AGENTS.md` with repository rules.

### Changed
- The marketplace name is `agent-kit`. Install commands use `@agent-kit`, for example `/plugin install block-self-bind-schedule@agent-kit`. Old repository URLs redirect.

## [0.2.0] - 2026-09-11

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

## [0.1.0] - 2026-09-09

### Added
- `block-self-bind-schedule` plugin. Denies `send_later` and self-bind `create_trigger`.

[Unreleased]: https://github.com/tonytino/agent-kit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tonytino/agent-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tonytino/agent-kit/releases/tag/v0.1.0
