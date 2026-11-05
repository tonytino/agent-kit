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
| `name` | Yes | Heading in the visuals block. Must be unique in the block. |
| `path` | Yes | Page to open. A relative path that starts with `/`. |
| `viewports` | No | Viewport names from the config. Default: all config viewports. |
| `video` | No | `true` records a `.webm` video of each side. Default: `false`. |
| `steps` | No | Actions to run after the page loads. Maximum 30. |

Limits: 1 to 10 scenarios per block.

## Paths

- Start `path` and `goto` with `/`.
- Do not start them with `//`.
- Do not include a scheme or a host.

pr-visuals opens the same path on the before URL and on the after URL. A path that resolves to a different origin is a validation error.

## Steps

Each step is an object with exactly one key. An unknown key is a validation error. Steps cannot run code.

| Step | Value | Example |
| --- | --- | --- |
| `goto` | Relative path | `{ "goto": "/settings" }` |
| `click` | Selector | `{ "click": "role=button[name=\"Save\"]" }` |
| `fill` | `[selector, value]` | `{ "fill": ["#email", "a@example.com"] }` |
| `press` | Key | `{ "press": "Enter" }` |
| `hover` | Selector | `{ "hover": "text=Help" }` |
| `waitFor` | Selector | `{ "waitFor": "text=Saved" }` |
| `wait` | Milliseconds, 0 to 10000 | `{ "wait": 500 }` |
| `scroll` | Pixels (number) | `{ "scroll": 800 }` |

Selectors use [Playwright selector syntax](https://playwright.dev/docs/locators). Prefer role and text selectors. They survive markup changes better than CSS classes.

Each step has a 15 second timeout. A failed step marks that cell as `capture failed` in the table. Other cells still run.

## How each cell is captured

For each scenario, viewport, and side (before and after), pr-visuals:

1. Opens a fresh browser context with reduced motion.
2. Opens `path` and waits for the network to go idle.
3. Runs the steps in order.
4. Takes a full-page screenshot. It also saves a video when `video` is `true`.

## Choose scenarios

- Cover only the pages and flows that the PR changes.
- Use one scenario per distinct change.
- Use steps to reach the changed state, for example an open menu or a filled form.
- Add `video` only when motion or a multi-step flow is the change.
- Use `wait` only when no selector marks the ready state. Prefer `waitFor`.

## Errors

If the block is missing, empty, or invalid, `visuals:generate` fails. The job comments on the PR with the reason. Fix the block and apply `visuals:generate` again.
