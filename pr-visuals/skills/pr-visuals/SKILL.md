---
name: pr-visuals
description: Adds before/after screenshots and videos of a web app to a pull request description, using Playwright. Use when you open or update a PR that can change what users see in a web app, when a PR has a failing pr-visuals check, or when the user asks for screenshots, visuals, or a before/after comparison on a PR.
license: MIT
compatibility: Requires git, Node.js 22 or later, and a GitHub pull request. The local path also needs Playwright Chromium and push access to the repository.
---

# pr-visuals

Show reviewers what the PR changes in the UI. Capture only what changed.

Commands below use the GitHub CLI (`gh`). You can use your GitHub tool for the same actions.

## 0. Find out if the repository uses pr-visuals

The repository uses pr-visuals if one of these is true:

- `.github/pr-visuals.json` exists.
- A workflow in `.github/workflows/` uses `tonytino/agent-kit/pr-visuals`.

If the repository does not use pr-visuals:

- Do not apply labels. Never create labels.
- No UI impact: stop.
- UI impact: write the scenarios block (step 2), then use the [local path](#local-path).

## 1. Decide the UI impact

Read the diff. Ask: can a user see a difference in the web app?

- No: apply `visuals:none`. Stop.
- Yes: continue.

No UI impact: tests, CI, docs, backend code that does not change rendered output, refactors with identical output.

To apply a label: `gh pr edit <number> --add-label <label>`.

## 2. Write the scenarios block

Add a scenarios block to the PR body before you capture. List only the pages and flows that the PR changes. Never capture the whole app.

```
<!-- pr-visuals:scenarios
{ "scenarios": [
  { "name": "Directory filters", "path": "/?sort=near",
    "steps": [ { "click": "role=button[name=\"Filters\"]" } ] }
] }
-->
```

Format, steps, and limits: [references/scenarios.md](references/scenarios.md).

## 3. Capture with CI

Use this path when the repository uses pr-visuals.

1. Make sure the scenarios block is in the PR body.
2. Apply `visuals:generate`.
3. Find the run and watch it:
   ```sh
   gh run list --workflow pr-visuals.yml --branch <branch> --limit 1
   gh run watch <run id>
   ```
   Use the workflow file name that the repository uses. The run can take up to the deployment timeout (default 15 minutes) plus the capture time.
4. Read the job comment: `gh pr view <number> --comments`.
5. If the comment reports a failure, fix the scenarios block from the reason. Apply `visuals:generate` again.
6. If a table cell shows `capture failed`, or the comment reports an HTTP error, fix the steps or the path from the reason. Apply `visuals:generate` again. A failed cell fails the check.

On success, the job writes the visuals block into the PR body and the check passes.

If `visuals:generate` stays on the PR and no comment appears, remove the label. Then add it again.

Fork PRs cannot use `visuals:generate`. Tell the user. A maintainer must handle the visuals.

Setup for a new repository: [references/ci.md](references/ci.md).

## Local path

Use this path when the repository does not use pr-visuals. In a repository with the pr-visuals check, a pasted local block does not pass the check. A maintainer must apply `visuals:generate`.

You need push access to the repository.

1. Install the CLI once. Clone outside the working repository:
   ```sh
   git clone --depth 1 --branch pr-visuals-v0.1.0 https://github.com/tonytino/agent-kit "$HOME/.cache/agent-kit"
   (cd "$HOME/.cache/agent-kit/pr-visuals" && npm ci && npx playwright install chromium)
   ```
   The CLI is not on your PATH. Run it as `node "$HOME/.cache/agent-kit/pr-visuals/cli/pr-visuals.mjs"`. Below, `pr-visuals` means this command.
2. Push your commits. Get the head SHA:
   ```sh
   gh pr view <number> --json headRefOid -q .headRefOid
   ```
3. Get two URLs for the app:
   - Before: run the app at the base commit, or use the production URL.
   - After: run the app at the head commit, or use the preview URL.
4. Save the scenarios JSON (the content of the block) to a file. Capture into a temporary directory:
   ```sh
   out="$(mktemp -d)"
   pr-visuals capture --before-url <before> --after-url <after> --scenarios scenarios.json --out "$out"
   ```
   Viewports default to `desktop` and `mobile`.
5. Publish. This pushes the files to the `pr-visuals` branch of `origin` and prints the visuals block:
   ```sh
   pr-visuals publish --manifest "$out/manifest.json" --pr <number> --sha <head sha>
   ```
6. Put the block in the PR body:
   ```sh
   gh pr view <number> --json body -q .body > body.md
   ```
   In `body.md`, replace the text from `<!-- pr-visuals:start -->` to `<!-- pr-visuals:end -->` with the printed block. If there is no block, add it at the end. Then:
   ```sh
   gh pr edit <number> --body-file body.md
   ```

## 4. After later pushes

The visuals belong to one commit. After each push, decide again.

With the pr-visuals check:

- The push changes the UI: update the scenarios if needed. Apply `visuals:generate`.
- The push does not change the UI: apply `visuals:still-valid`. This does not pass a capture with failed cells.

Without the check:

- The push changes the UI: run the local path again.
- The push does not change the UI: do nothing.

## Rules

- Never add contrived visuals. If nothing visible changed, use `visuals:none`.
- Paste the visuals block only as printed. Never change its content.
- Do not remove the visuals block. The check fails without it.
- Keep the scenarios block in the body. Each capture reads it.
