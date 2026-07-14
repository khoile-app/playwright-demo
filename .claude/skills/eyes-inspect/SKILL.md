---
name: eyes-inspect
description: Inspect an Applitools Eyes session or a specific checkpoint/step. Trigger on session or step-level URLs ("/test-results"/, "/steps/") and short requests like "inspect session", "inspect step", "describe / explain the differences",or "show step diff". Accept a session URL, step URL, `sessionUrl`+`stepIndex`.
---

# Eyes Inspect

## Agent instructions

When any of the above triggers match, **invoke this skill immediately** via `run_in_terminal`. Do not ask for `APPLITOOLS_READ_KEY` or gate execution on credential presence. The skill reads from `.env` automatically. If credentials are missing, the skill will fail and return an error — let the user handle it.

**Enforced workflow:** always follow the mandatory workflow described in the Workflow section.

## Commands

`/eyes-inspect <command> [args]`

**Shared args**
- `sessionUrl` — Eyes session URL: `https://eyes.applitools.com/app/test-results/{batchId}/{sessionId}[/steps/{N}]?accountId=...` (the `/steps/N` suffix is ignored if present; note N is 1-based, unlike `stepIndex`)
- `stepIndex` — zero-based index of the step, as returned by `steps`
- `rect` — `left,top,width,height` in pixels. Use image sizes from `steps` to construct rects (e.g. top quarter of a 1020×600 image = `0,0,1020,150`).

**Commands and arguments**
- `batch <batchUrl>` — list all sessions in a batch. Output is `[{ sessionId, name, status }]`. To inspect a session, construct its URL as `{baseUrl}/app/test-results/{batchId}/{sessionId}?accountId={accountId}` (all components are in the batch URL) and pass it to `steps`.
- `steps <sessionUrl>` — list test steps with baseline/checkpoint image IDs, domIds, sizes, and match status
- `changed-areas <sessionUrl> <stepIndex> [rect] [--debug]` — coarse diff regions for a step. Each region includes `diffCount`.
- `diff-image <sessionUrl> <stepIndex> [rect]` — checkpoint screenshot with visual differences highlighted in pink, cropped to `rect` if provided. Outputs the file path — pass it directly to the `Read` tool to display the image.
- `screenshot <sessionUrl> <imageId> [rect]` — baseline or checkpoint screenshot saved as a PNG to the system temp folder. The output filename encodes the imageId and crop rect, so it is self-identifying — correlate it back to baseline or checkpoint using the imageId from `steps`. Outputs the file path — pass it directly to the `Read` tool to display the image.
- `dom <sessionUrl> <domId> [rect]` — DOM capture saved as JSON to the system temp folder. The output filename encodes the domId and crop rect. Outputs the file path — pass it directly to the `Read` tool to display the contents. Don't pad the rect.
- `dom-diff <sessionUrl> <stepIndex> [rect]` — DOM diff between baseline and checkpoint. Use to understand structural DOM changes behind a visual difference. See "Analyzing DOM differences" below.
- `diffs <sessionUrl> <stepIndex> [rect]` — raw pixel-level diff rectangles. Use only when exact diff coordinates are needed. When `rect` is provided, coordinates are relative to the rect's origin.

## Execution

Run from the repository root:

```
npx tsx .claude/skills/eyes-inspect/main.ts <command> [args]
```

Or change into the skill directory first:

PowerShell:
```
Set-Location .\.claude\skills\eyes-inspect
npx tsx main.ts <command> [args]
```

Unix-like shell:
```
cd .claude/skills/eyes-inspect
npx tsx main.ts <command> [args]
```

If dependencies are not installed yet, run:

```
npm install
```

## Workflow

THIS WORKFLOW IS MANDATORY. Always run the following sequence before fetching diff images or DOM data.

1. `steps <sessionUrl>` — see which steps have differences and get their image IDs, domIds, and sizes. If no specific step was requested and the URL has no `/steps/N`, repeat steps 2–6 for every step where `isMatching` is false.
2. `changed-areas <sessionUrl> <stepIndex>` — get coarse diff regions.
3. **If the changed areas together span a large portion of the page**, run `dom-diff <sessionUrl> <stepIndex>` before fetching images — large diffs are often caused by displacement and `dom-diff` reveals the root cause directly. Then continue with step 4 regardless.
4. For each region: **pad the rect by 10px on every side** (the region may exceed the image bounds — that's fine), then fetch `diff-image`, `screenshot` (baseline imageId from `steps`), and `screenshot` (checkpoint imageId from `steps`) in parallel. Read all three with the `Read` tool.
5. Compare each trio: the baseline shows what was expected, the checkpoint shows what it looks like now, and the diff image shows where changes are (pink highlights are bounding rectangles around changed pixel clusters — the actual change may be smaller, differently shaped, a shift, or a removal). **Before describing any change, count the distinct pink rectangles in the diff image and state the count explicitly (e.g. "I see 3 pink rectangles"). Then describe each one in turn — do not move on until all N are accounted for. Do not group, skip, or omit any.** For each one, describe what it looked like in the baseline and what it looks like in the checkpoint.
6. `dom-diff <sessionUrl> <stepIndex> [rect]` — get precise DOM-level changes. Use it to distinguish real content/style changes from elements that merely shifted position (which appear as `"displaced"` entries). Also required before concluding a diff is rendering noise. See "Analyzing DOM differences" below.

### Rendering noise

Never call a diff rendering noise based on visual inspection alone. It may only be called rendering noise when **both** are true: all pink rectangles are very small (≤ 10×10 px) **and** `dom-diff` returns no changes for the diff area. A non-empty DOM diff means there is a structural explanation and it must be reported as a real change.

## Analyzing DOM differences

**`dom` output** — a JSON snapshot of the page structure at capture time. Every element carries fully resolved computed styles (e.g. `color: "rgb(2, 8, 23)"`, `font-size: "16px"`); text content appears as `#text` child nodes with a `text` field.

**`dom-diff` output** — shows only nodes that changed between baseline and checkpoint. Each entry has a `status` field: `"changed"`, `"new"`, `"missing"`, or `"displaced"`.

### `"changed"` entries

A node that exists in both baseline and checkpoint with differing properties. Includes a `baseline` object with the prior values of any diffed properties (style, attributes, rect, or text).

### `"new"` entries

A node present in the checkpoint only (added). Shows full style, attributes, and rect.

### `"missing"` entries

A `"missing"` entry with a `count` field means an entire baseline subtree was removed — collapsed into one line with the root's `tagName` and `attributes`, the total node count, and a union `rect`. To inspect the individual removed elements, use `dom <sessionUrl> <baselineDomId> <rect>`. A `"missing"` entry without `count` is a single removed node showing full style and attribute properties.

### `"displaced"` entries

A `"displaced"` entry means `count` checkpoint nodes shifted by the same position vector with no other changes. The displacement vector is `{left: rect.left − baseline.rect.left, top: rect.top − baseline.rect.top}`.

Displaced nodes are layout knock-on effects — they moved because something earlier in the document changed. The root cause is not in these nodes; look for `"changed"`, `"new"`, or `"missing"` entries earlier in the output to find what actually changed.

### When to use `dom` instead of `dom-diff`

Never fetch both individual `dom` captures to compare them manually — always use `dom-diff` for comparisons. Use `dom` in isolation only when you need one side independently:

- **Checkpoint `dom`** — useful when you don't have access to the application's source code and need to inspect the exact computed styles or structure of the current render.
- **Baseline `dom`** — useful to inspect the computed styles and structure of the baseline on its own.

### DOM limitations

The DOM cannot detect an image whose `src` is unchanged but whose pixel content changed, or icon and font rendering differences. Use `screenshot` and `diff-image` for these.

## API key

Requires `APPLITOOLS_READ_KEY` — a read-only key, separate from `APPLITOOLS_API_KEY` used for test execution.

Set it in `.env` or as an environment variable before running the command. In PowerShell you can set it like:

```
$env:APPLITOOLS_READ_KEY = "your_read_only_key_here"
```

The environment variable takes precedence over `.env`.
