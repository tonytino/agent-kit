---
name: pr-visuals
description: Adds before/after screenshots and videos of a web app to a pull request description, using Playwright. Use when you open or update a PR that can change what users see in a web app, when a PR has a failing pr-visuals check, or when the user asks for screenshots, visuals, or a before/after comparison on a PR.
license: MIT
compatibility: Requires git, Node.js 22 or later, and a GitHub pull request. The local path also needs Playwright Chromium and push access to the repository.
---

# pr-visuals

Show reviewers what the PR changes in the UI. Capture only what changed.

To apply a label with the GitHub CLI: `gh pr edit <number> --add-label <label>`.

## 1. Decide the UI impact

Read the diff. Ask: can a user see a difference in the web app?

- No: apply the label `visuals:none`. Stop.
- Yes: continue.

Examples of no UI impact: tests, CI, docs, backend code with no change to rendered output, refactors with identical output.

## 2. Write the scenarios block

Add a scenarios block to the PR body. List only the pages and flows that the PR changes. Never capture the whole app.

```
<!-- pr-visuals:scenarios
{ "scenarios": [
  { "name": "Directory filters", "path": "/?sort=near",
    "steps": [ { "click": "role=button[name=\"Filters\"]" } ] }
] }
-->
```

Format, step list, and limits: [references/scenarios.md](references/scenarios.md).

## 3. Capture

Check whether the repository has `.github/pr-visuals.json`.

### CI path (the file exists)

1. Apply the label `visuals:generate`.
2. Wait for the `pr-visuals` workflow run to finish. The job removes the label when it starts.
3. Read the job comment on the PR.
4. On failure, fix the scenarios block from the reason in the comment. Apply `visuals:generate` again.

On success, the job writes the visuals block into the PR body.

Setup for a new repository: [references/ci.md](references/ci.md).

### Local path (no CI integration)

1. Get two URLs for the app:
   - Before: run the app at the base commit, or use the deployed production URL.
   - After: run the app at the head commit, or use the deployed preview URL.
2. Save the scenarios JSON (the content of the block) to `scenarios.json`.
3. Capture:
   ```sh
   pr-visuals capture --before-url <before> --after-url <after> --scenarios scenarios.json --out visuals > manifest.json
   ```
4. Publish. This pushes the files to the `pr-visuals` branch and prints the visuals block:
   ```sh
   pr-visuals publish --manifest manifest.json --pr <number> --sha <head sha>
   ```
5. Paste the printed block into the PR body exactly as printed.

If `pr-visuals` is not on your PATH, clone `https://github.com/tonytino/agent-kit`. Then run `npm ci` and `npx playwright install chromium` in `pr-visuals/`. Run the CLI as `node <clone>/pr-visuals/bin/pr-visuals.mjs`.

## 4. After later pushes

The visuals belong to one commit. After each push to the PR:

- The push changes the UI: update the scenarios if needed. Capture again (`visuals:generate`, or the local path).
- The push does not change the UI: apply `visuals:still-valid`. On the local path, do nothing.

## Rules

- Never add contrived visuals. If nothing visible changed, use `visuals:none`.
- Never edit the visuals block by hand. Only the tool writes it.
- Keep the scenarios block in the body. The CI path reads it on every capture.
