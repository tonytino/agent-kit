# CI setup

Set up pr-visuals in a repository once. After that, agents and people control it with labels.

## 1. Add the workflow

Copy [`examples/pr-visuals.yml`](https://github.com/tonytino/agent-kit/blob/main/pr-visuals/examples/pr-visuals.yml) to `.github/workflows/pr-visuals.yml`.

The workflow runs on these `pull_request` events: `opened`, `reopened`, `synchronize`, `labeled`, `unlabeled`, and `edited`.

| Job | Runs when | Does |
| --- | --- | --- |
| `generate` | `visuals:generate` is applied | Removes the label, captures, publishes, updates the PR body, and posts the result comment. |
| `still-valid` | `visuals:still-valid` is applied | Removes the label and confirms the latest capture for the head commit. Refuses when that capture has failed cells. |
| `check` (status name `pr-visuals-check`) | Every event above, after the other jobs | Passes or fails the PR. `edited` runs only this job. |

Nothing captures automatically. Only the `visuals:generate` label starts a capture.

`generate` and `still-valid` share one concurrency queue per PR (`queue: max`). They run one at a time, and GitHub does not drop a pending label request. A newer `check` cancels an older one.

### Pin the action

The jobs use the action `tonytino/agent-kit/pr-visuals`. Pin it to the full commit SHA of a release tag. Tags have the form `pr-visuals-vX.Y.Z`.

```yaml
- uses: tonytino/agent-kit/pr-visuals@<full-commit-sha> # pr-visuals-v0.1.0
```

In the example, replace `REPLACE_WITH_FULL_COMMIT_SHA` with that SHA. The workflow fails until you do.

| Input | Required | Value |
| --- | --- | --- |
| `mode` | Yes | `check`, `generate`, or `still-valid`. |
| `config` | No | Config path, relative to the repository root. Default: `.github/pr-visuals.json`. |
| `github-token` | No | Token for the API and the push. Default: `github.token`. |
| `bot-login` | No | Account whose result comments the check trusts. Default: `github-actions[bot]`. Set it when `github-token` belongs to a GitHub App or a user. |

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

| Field | Required | Value |
| --- | --- | --- |
| `before.url` | Yes | URL of the current app, usually production. |
| `after` | Yes | `{ "url": "..." }`, or `{ "source": "github-deployment", ... }`. |
| `after.environment` | No | Deployment environment name to match. Default: any environment. Required when `PR_VISUALS_HEADERS` is set. |
| `after.timeoutMinutes` | No | Minutes to wait for a successful deployment, 1 to 120. Default: 15. |
| `viewports` | No | 1 to 10 named viewports. Scenarios pick from these names. Default: `desktop` (1280x800) and `mobile` (390x844). |
| `fullPage` | No | `false` captures only the viewport. Default: `true`. |

Viewport rules:

- Name: lowercase letters, numbers, and hyphens. Starts with a letter or number. 1 to 32 characters.
- `width` and `height`: integers from 200 to 4000.
- `deviceScaleFactor`: a number from 1 to 4.
- `isMobile` and `hasTouch`: booleans.

URLs accept `{number}` (PR number) and `{sha}` (full head commit SHA). Example: `"https://pr-{number}.example.com"`.

`github-deployment` finds the newest deployment for the head commit with a `success` status. It uses the status `environment_url`, or `target_url` if that is empty. It polls every 15 seconds until the timeout. Hosts that post GitHub deployments work, for example Vercel and Netlify. For other hosts, use an `after.url` template.

pr-visuals validates the config strictly. An unknown or invalid field fails the job and the error names the field.

In CI, pr-visuals reads the config from the PR base branch only. A config change in a PR takes effect after you merge it.

### Monorepos

Set `after.environment` to the environment name of the project, for example `web-preview`. Use the name that your host posts. There is no `{branch}` placeholder.

## 3. Create the labels

| Label | Description |
| --- | --- |
| `visuals:none` | No UI impact. The pr-visuals check passes. |
| `visuals:generate` | Capture before/after visuals into the PR body. The job removes this label. |
| `visuals:still-valid` | The visuals still match this commit. Use after changes that do not affect the UI. The job removes this label. |

```sh
gh label create visuals:none --description "No UI impact. The pr-visuals check passes."
gh label create visuals:generate --description "Capture before/after visuals into the PR body. The job removes this label."
gh label create visuals:still-valid --description "The visuals still match this commit. Use after changes that do not affect the UI. The job removes this label."
```

## 4. Add headers (optional)

If your preview URLs need a header, add a repository secret `PR_VISUALS_HEADERS`. The value is a JSON object. The example workflow passes it to the `generate` job.

For Vercel Deployment Protection:

```json
{ "x-vercel-protection-bypass": "<secret>", "x-vercel-set-bypass-cookie": "true" }
```

pr-visuals sends these headers only to the before and after origins. It does not carry them through a redirect. For this reason, use a bypass that sets a cookie, as above. pr-visuals never logs header values.

With `github-deployment`, set `after.environment`. pr-visuals refuses to send headers to a deployment URL from an unnamed environment.

## 5. Require the check

In the branch protection rule or ruleset, make `pr-visuals-check` a required status check.

## How the check decides

1. `visuals:none` is on the PR: pass.
2. A result comment covers the head commit:
   - The PR body has no visuals block: fail. Apply `visuals:generate`.
   - The capture has failed cells: fail. Fix the scenario steps and apply `visuals:generate`.
   - Otherwise: pass. This includes a `visuals:still-valid` confirmation for the head commit.
3. An older capture exists: fail as stale. Apply `visuals:generate` to recapture, or `visuals:still-valid` if the new commits do not change the UI.
4. No capture exists: fail. Apply `visuals:generate` (with a scenarios block) or `visuals:none`.

## Trust model

The check trusts only result comments from the bot account (`bot-login`, default `github-actions[bot]`). Each comment has a hidden `<!-- pr-visuals:result ... -->` marker with the commit SHA and the number of failed cells. Comments from other accounts are ignored. A visuals block that a person or an agent writes into the body does not pass the check.

The check is a process gate. It makes sure someone looked at the UI change. It does not prove that the UI is correct.

## Security

- On a public repository, the captures are public. Do not capture pages that show secrets or personal data.
- Do not capture pages that reflect request headers into the page. The screenshot can show the header values.
- Do not check out or run PR code in the `generate` job. The job has write permissions.

## The `pr-visuals` branch

`generate` pushes images and videos to the orphan branch `pr-visuals`, under `pr-<number>/<sha7>-<run id>/`. It never force-pushes. The PR body links to these files. Do not delete the branch.

- The branch grows with each capture. pr-visuals does not prune it. To prune, delete the `pr-<number>/` directories of closed PRs.
- To clone without it, use `git clone --single-branch`, or exclude `refs/heads/pr-visuals` from your fetch refspec.
- pr-visuals writes a `vercel.json` at the branch root that turns off Vercel deployments for the branch. Other hosts that build every branch need their own ignore rule.

## CLI commands

The action runs `check`, `generate`, and `still-valid`. You can run `capture`, `render`, and `publish` locally.

| Command | Does |
| --- | --- |
| `capture --before-url URL --after-url URL --scenarios FILE --out DIR [--config FILE]` | Captures files into `DIR` and writes `DIR/manifest.json`. `--scenarios -` reads standard input. |
| `publish --manifest FILE --pr N --sha SHA [--repo OWNER/REPO] [--remote NAME]` | Pushes the files to the `pr-visuals` branch. Prints the visuals block. |
| `render --manifest FILE --repo OWNER/REPO --pr N --sha SHA --base-path PATH` | Prints the visuals block for files that are already on the branch. |

`--base-path` is the directory on the `pr-visuals` branch that holds the files, for example `pr-12/abc1234-1730768523000`. `publish` prints the block with the correct path, so most users do not need `render`.

## Limits

- **Label removal does not start runs.** The job removes `visuals:generate` and `visuals:still-valid` with `GITHUB_TOKEN`. Events from `GITHUB_TOKEN` do not start new workflow runs. For this reason, `pr-visuals-check` runs in the same run, after `generate` and `still-valid`.
- **Fork PRs cannot generate.** Workflows for fork PRs get a read-only token. `generate` cannot push files or edit the PR body, even when a maintainer applies the label. A maintainer can push the branch to the base repository and open a new PR from it.
- **Videos are links.** GitHub does not play `.webm` files from a branch inline. The visuals block links to each video.
- **Images in private repositories** use `blob/pr-visuals/...?raw=true` links. Signed-in viewers with read access see them.
