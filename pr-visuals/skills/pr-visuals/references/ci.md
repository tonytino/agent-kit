# CI setup

Set up pr-visuals in a repository once. After that, agents and people control it with labels.

## 1. Add the workflow

Copy [`examples/pr-visuals.yml`](https://github.com/tonytino/agent-kit/blob/main/pr-visuals/examples/pr-visuals.yml) to `.github/workflows/pr-visuals.yml`.

The workflow has three jobs:

| Job | Runs when | Does |
| --- | --- | --- |
| `generate` | `visuals:generate` is applied | Captures, publishes, and updates the PR body. |
| `still-valid` | `visuals:still-valid` is applied | Marks the head commit as confirmed. |
| `check` | Every PR event, after the jobs above | Passes or fails the PR. |

Nothing captures automatically. Only the `visuals:generate` label starts a capture.

## 2. Add the config

Copy [`examples/pr-visuals.json`](https://github.com/tonytino/agent-kit/blob/main/pr-visuals/examples/pr-visuals.json) to `.github/pr-visuals.json`. Edit it for your app.

```json
{
  "before": { "url": "https://www.example.com" },
  "after": { "source": "github-deployment", "environment": "Preview", "timeoutMinutes": 15 },
  "viewports": {
    "desktop": { "width": 1280, "height": 800 },
    "mobile": { "width": 390, "height": 844, "isMobile": true, "hasTouch": true, "deviceScaleFactor": 3 }
  },
  "fullPage": true
}
```

| Field | Value |
| --- | --- |
| `before.url` | URL of the current app, usually production. |
| `after` | `{ "url": "..." }`, or `{ "source": "github-deployment", ... }`. |
| `after.environment` | Optional. Deployment environment name to match. |
| `after.timeoutMinutes` | How long to wait for a successful deployment. |
| `viewports` | Named viewports. Scenarios pick from these names. |
| `fullPage` | `true` takes full-page screenshots. |

URLs accept `{number}` (PR number) and `{sha}` (head commit). Example: `"https://pr-{number}.example.com"`.

`github-deployment` finds the newest deployment for the head commit with a `success` status. It uses the status `environment_url`, or `target_url` if that is empty. It polls every 15 seconds until the timeout. Hosts that post GitHub deployments work, for example Vercel and Netlify.

pr-visuals validates the config strictly. An unknown or invalid field fails the job with a clear error.

## 3. Create the labels

| Label | Description |
| --- | --- |
| `visuals:none` | No UI impact. The pr-visuals check passes. |
| `visuals:generate` | Capture before/after visuals into the PR body. Removed after the run starts. |
| `visuals:still-valid` | The visuals still match this commit. Use after changes that do not affect the UI. |

With the GitHub CLI:

```sh
gh label create visuals:none --description "No UI impact. The pr-visuals check passes."
gh label create visuals:generate --description "Capture before/after visuals into the PR body. Removed after the run starts."
gh label create visuals:still-valid --description "The visuals still match this commit. Use after changes that do not affect the UI."
```

## 4. Add headers (optional)

If your preview URLs need a header, add a repository secret `PR_VISUALS_HEADERS`. The value is a JSON object.

```json
{ "x-vercel-protection-bypass": "<secret>" }
```

This example passes Vercel Deployment Protection. pr-visuals sends these headers only to requests for the before and after origins. It never sends them to other hosts. It never logs their values.

## 5. Require the check

In the branch protection rule or ruleset, make `pr-visuals / check` a required status check.

## How the check decides

1. `visuals:none` is on the PR: pass.
2. The PR body has no visuals block: fail. Apply `visuals:generate` (with a scenarios block) or `visuals:none`.
3. The visuals were captured on the head commit, or the head commit is confirmed with `visuals:still-valid`: pass.
4. Otherwise: fail as stale. Apply `visuals:generate` to recapture, or `visuals:still-valid` if the new commits do not change the UI.

## Where files go

`generate` pushes images and videos to the orphan branch `pr-visuals`, under `pr-<number>/<sha7>-<run>/`. It never force-pushes. Do not delete this branch. The PR body links to its files.

## Limits

- **Label removal does not trigger runs.** The job removes `visuals:generate` and `visuals:still-valid` with `GITHUB_TOKEN`. Events from `GITHUB_TOKEN` do not start new workflow runs. For this reason, `check` runs in the same run, after `generate` and `still-valid`.
- **Fork PRs cannot generate.** Workflows for fork PRs get a read-only token. `generate` cannot push files or edit the PR body. A maintainer can capture with the local path and paste the block.
- **Videos are links.** GitHub does not play `.webm` files from a branch inline. The visuals block links to each video.
- **Images in private repos** use `blob/pr-visuals/...?raw=true` links. Signed-in viewers with read access see them.
