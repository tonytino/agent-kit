# Scenarios block

The scenarios block tells pr-visuals what to capture. Write it in the PR body. It is an HTML comment, so it does not show in the rendered PR.

## Format

The block starts with `<!-- pr-visuals:scenarios` and ends with `-->`. The content is one JSON object with one key, `scenarios`. Keep exactly one block in the PR body.

For `pr-visuals capture --scenarios`, give a file with the JSON object, or a file that contains the block.

```
<!-- pr-visuals:scenarios
{
  "scenarios": [
    {
      "name": "Directory filters",
      "path": "/?sort=near",
      "viewports": ["desktop", "mobile"],
      "video": true,
      "steps": [
        { "click": "role=button[name=\"Filters\"]" },
        { "fill": ["#q", "pizza"] },
        { "press": "Enter" },
        { "waitFor": "text=Results" },
        { "wait": 500 }
      ]
    }
  ]
}
-->
```

## Scenario fields

| Field | Required | Value |
| --- | --- | --- |
| `name` | Yes | Heading in the visuals block. Unique in the block. 1 to 100 characters. No control characters. |
| `path` | Yes | Page to open. A relative path that starts with `/`. Maximum 2000 characters. |
| `viewports` | No | Viewport names from the config. Default: all config viewports. |
| `video` | No | `true` records a `.webm` video of each side. Default: `false`. |
| `steps` | No | Actions to run after the page loads. 0 to 30 steps. |

Limits: 1 to 10 scenarios per block.

## Paths

- Start `path` and `goto` with `/`.
- Do not start them with `//`.
- Do not include a scheme or a host.
- Do not include whitespace or control characters.

pr-visuals opens the same path on the before URL and on the after URL. A path that resolves to a different origin is a validation error.

## Steps

Each step is an object with exactly one key. An unknown key is a validation error. Steps cannot run code.

| Step | Value | Example |
| --- | --- | --- |
| `goto` | Relative path, same rules as `path` | `{ "goto": "/settings" }` |
| `click` | Selector | `{ "click": "role=button[name=\"Save\"]" }` |
| `fill` | `[selector, value]`. Value: string, maximum 2000 characters | `{ "fill": ["#email", "a@example.com"] }` |
| `press` | Key name, maximum 50 characters | `{ "press": "Enter" }` |
| `hover` | Selector | `{ "hover": "text=Help" }` |
| `waitFor` | Selector | `{ "waitFor": "text=Saved" }` |
| `wait` | Integer milliseconds, 0 to 10000 | `{ "wait": 500 }` |
| `scroll` | Integer pixels, -100000 to 100000. Negative scrolls up | `{ "scroll": 800 }` |

A selector is a non-empty string of at most 500 characters.

Selectors use [Playwright selector syntax](https://playwright.dev/docs/locators). Prefer role and text selectors. They survive markup changes better than CSS classes.

Each step has a 15 second timeout.

## Failed cells

A cell fails when:

- A step fails or times out.
- The page responds with HTTP status 400 or higher.
- The page navigates to a different origin.

Other cells still run. The table shows a failed cell by side:

- After side: `capture failed: <reason>`. An after-side failure fails the pr-visuals check. `visuals:still-valid` does not override it. Fix the scenario and apply `visuals:generate` again.
- Before side: `Not present before this PR`, with the reason in small text. This is expected when the PR adds the page or UI. A before-side failure does not fail the check.

## How each cell is captured

For each scenario, viewport, and side (before and after), pr-visuals:

1. Opens a fresh browser context with reduced motion.
2. Opens `path` and waits for the network to go idle.
3. Runs the steps in order.
4. Takes a screenshot. It is full page unless the config sets `fullPage` to `false`. It also saves a video when `video` is `true`.

## Choose scenarios

- Cover only the pages and flows that the PR changes.
- Use one scenario per distinct change.
- Use steps to reach the changed state, for example an open menu or a filled form.
- Add `video` only when motion or a multi-step flow is the change.
- Use `wait` only when no selector marks the ready state. Prefer `waitFor`.

## Errors

If the block is missing, empty, or invalid, `visuals:generate` fails. The job comments on the PR with the reason. Fix the block and apply `visuals:generate` again.
