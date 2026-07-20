---
name: eyes-compare
description: Visually compare two URLs, or run a single URL as a checkpoint against its existing baseline. TRIGGER on: "visually compare X and Y", "compare <url1> and <url2>", "does X look like Y", "visual diff between URLs", "check <url> against baseline", "visually check <url>", "visually test <url>", "compare with Figma", "check against Figma design", "does it match the design".
---

# Eyes Compare

Visually compare two URLs across browsers and viewport sizes using Applitools Eyes. When only one URL is provided, it is run as a checkpoint against the existing baseline for that URL.

`url1` may be a Figma design URL (`https://www.figma.com/design/...`). When a Figma URL is provided as the baseline, the skill fetches the design node as a PNG and uses it as the Eyes baseline image, then captures the checkpoint URL and compares against it.

## Command

`/eyes-compare [matchLevel] [url1] <url2> [{browser}@{width}x{height} ...]`

- **Two URLs**: captures url1 as the baseline and url2 as the checkpoint, then reports visual differences.
- **Figma URL + live URL**: uses the Figma design node as the baseline image and the live URL as the checkpoint.
- **One URL**: runs url2 as a checkpoint against its existing baseline (or saves it as a new baseline if none exists).

- `matchLevel` — optional first argument: `strict`, `layout`, `dynamic`, `exact`, `none`, `ignorecolors`
- `{browser}@{width}x{height}` — optional browser/viewport specs (e.g. `chrome@1920x1080 firefox@1280x720`); when omitted, uses the browsers from `playwright.config.ts`

## Execution

```
!npx tsx .claude/skills/eyes-compare/main.ts [matchLevel] [url1] <url2> [browser@widthxheight ...]
```

## Workflow

1. Run the compare command — it outputs a result URL and a pass/fail summary per browser.
2. Show the result URL as a link. Wrap it with `<URL>` brackets so it is not truncated.
3. If differences are found and the user wants to understand them, invoke the `eyes-inspect` skill with the result URL to analyze the diffs step by step.

## API keys

- **`APPLITOOLS_API_KEY`** — write key required. Set in `.env` or as an environment variable.

## Baseline matching rules

Applitools identifies a baseline by the combination of: **appName**, **testName**, **branchName**, **hostOS**, **hostingApp** (browser), and **viewport** (width × height). All six must match for a test run to compare against an existing baseline. Changing any one of them creates a new baseline bucket.

`baselineEnvName` overrides the environment portion of the lookup (hostOS, hostingApp, viewport) with the values stored under that named environment. 
