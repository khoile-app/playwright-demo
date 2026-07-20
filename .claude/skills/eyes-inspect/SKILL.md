---
name: eyes-inspect
description: Inspect an Applitools Eyes session or a specific checkpoint/step. Trigger on session or step-level URLs ("/test-results"/, "/steps/") and short requests like "inspect session", "inspect step", "describe / explain the differences", "show step diff", "show/list match/ignore/baseline regions/annotations", or "locate/find an element" (e.g. to anchor or remove a baseline region or to obtain its exact position, style or structure). Accept a session URL, step URL, `sessionUrl`+`stepIndex`.
---

# Eyes Inspect

## Agent instructions

When any of the above triggers match, **invoke this skill immediately** via `run_in_terminal`. Do not ask for `APPLITOOLS_READ_KEY` or gate execution on credential presence. The skill reads from `.env` automatically. If credentials are missing, the skill will fail and return an error — let the user handle it.

**Enforced workflow:** always follow the mandatory workflow described in the Workflow section.

**Never write an ad-hoc script (Python, Node, `jq`, `grep`, manual `JSON.parse`, etc.) to search, filter, or summarize a `dom` capture file.** Always use `dom-search <filePath> <predicate>` — it already understands the capture's structure and expresses tag/attribute/style/geometry/relationship/text/count checks directly, composable with `and`/`or`/`not`. Read [`dom-search.md`](./dom-search.md) for the predicate language before writing a predicate. If something you need genuinely can't be expressed as a predicate, that's a signal the language is missing a feature — propose extending it (see `sessions/dom-search.ts`) rather than reaching for another tool.

## Commands

`/eyes-inspect <command> [args]`

**Shared args**
- `sessionUrl` — Eyes session URL: `https://eyes.applitools.com/app/test-results/{batchId}/{sessionId}[/steps/{N}]?accountId=...` (the `/steps/N` suffix is ignored if present; note N is 1-based, unlike `stepIndex`)
- `stepIndex` — zero-based index of the step, as returned by `steps`
- `rect` — `left,top,width,height` in pixels. Use image sizes from `steps` to construct rects (e.g. top quarter of a 1020×600 image = `0,0,1020,150`).

**Commands and arguments**
- `batch <batchUrl> [filter] [format]` — list sessions in a batch plus batch-wide stats. `filter`/`format` are recognized by value, not position, so either can be given alone. `filter` (`unresolved`/`unsaved`) narrows to matching sessions before `format` shapes the output: `full` (default) — `{ stats, sessions }`, `stats` summarizing step and session state counters, `sessions` shaped the same as `steps`'s own output minus `steps`; `stats` — `{ stats }` only; `scenarios` — `{ scenarios }`, the deduplicated, sorted `sessionName`s. To inspect a session, construct its URL as `{baseUrl}/app/test-results/{batchId}/{sessionId}?accountId={accountId}` and pass it to `steps`. Note: with no `filter`, `stats` format reads the batch's own eventually-consistent aggregate rather than computing it — don't use it to verify a change you just made.
- `steps <sessionUrl>` — session summary (`sessionId`, `sessionName`, `appName`, `status`, `isUnsaved`, `isAborted`, `environment`, `startedAt`) plus test steps with baseline/checkpoint image IDs, domIds, sizes, match status (`isMatching`), resolution, and per-step `isUnsaved`
- `changed-areas <sessionUrl> <stepIndex> [rect] [--debug]` — coarse diff regions for a step. Each region includes `diffCount`.
- `diff-image <sessionUrl> <stepIndex> [rect]` — checkpoint screenshot with visual differences highlighted in pink, cropped to `rect` if provided. Outputs the file path — pass it directly to the `Read` tool to display the image.
- `screenshot <sessionUrl> <imageId> [rect]` — baseline or checkpoint screenshot saved as a PNG to the system temp folder. The output filename encodes the imageId and crop rect, so it is self-identifying — correlate it back to baseline or checkpoint using the imageId from `steps`. Outputs the file path — pass it directly to the `Read` tool to display the image.
- `dom <sessionUrl> <domId> [rect]` — DOM capture saved as JSON to the system temp folder. The output filename encodes the domId and crop rect. Outputs the file path — pass it directly to the `Read` tool to display the contents. Don't pad the rect.
- `dom-search <filePath> <predicate>` — search a DOM capture file (from `dom`) for elements matching a boolean predicate, printing one compact line per match, indented by tree depth. `filePath` is a file previously written by the `dom` command. See "dom-search predicate language" below for the full grammar.
- `dom-diff <sessionUrl> <stepIndex> [rect]` — DOM diff between baseline and checkpoint. `rect`, if given, only filters the output, not the comparison. Use to understand structural DOM changes behind a visual difference. See "Analyzing DOM differences" below.
- `diffs <sessionUrl> <stepIndex> [rect]` — raw pixel-level diff rectangles. Use only when exact diff coordinates are needed. When `rect` is provided, coordinates are relative to the rect's origin.
- `regions <sessionUrl> <stepIndex> [rect]` — the match regions currently in effect for a step (ignore/strict/layout/dynamic/etc.), optionally filtered to only those intersecting `rect` on either side. Output is `{ regions, codedRegions }`: `regions` are the regions defined on the baseline, or changed by a reviewer through resolution, each `{ category, baseline, checkpoint }` giving the region's rect on both sides — a `domSelector` present on one side but empty on the other means that side's anchor is stale, or its target genuinely doesn't exist there; `codedRegions` are regions defined programmatically in test code (e.g. `Target.window().ignore(page.locator('h1'))`), in the same `{ category, baseline, checkpoint }` shape but keyed by a `regionId` instead of a DOM anchor — a `regionId` empty on the baseline means that region isn't defined there (e.g. added in code after the baseline was last saved).
- `history <sessionUrl> <stepIndex> <nodeId>[,<nodeId>...] [count]` — for each node id, a changelog of `count` (default 3) non-empty diffs against prior runs of the same scenario and environment, keyed by node id. Each entry is `{ checkpointStep, checkpointCapturedAt, baselineStep, baselineCapturedAt, diff }`: `checkpoint`/`baseline` indicate the newer and older DOM version compared, respectively; each `*Step` is `<batchId>/<sessionId>/<stepIndex>` (0-based — build a session URL from it, or pass it to another command like `dom-diff`); `diff` is in the same compact per-node format `dom-diff` itself produces. An empty array means no change was found across however much history was searched. This surfaces evidence only — it does not itself judge whether an element is dynamic; decide that from the pattern of diffs (e.g. a value that keeps changing to different numbers/dates suggests dynamic content, no diffs at all suggests a real, one-time change). The node id list must be a single argument with no spaces (`14,27,54`, not `14, 27, 54`).

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
7. For a `"changed"` or `"new"` entry whose content looks like it could vary run-to-run (a counter, date, ad, etc.), run `history <sessionUrl> <stepIndex> <id>` before concluding whether it's dynamic or a real change, rather than guessing from this one run alone.

### Rendering noise

Never call a diff rendering noise based on visual inspection alone. It may only be called rendering noise when **both** are true: all pink rectangles are very small (≤ 10×10 px) **and** `dom-diff` returns no changes for the diff area. A non-empty DOM diff means there is a structural explanation and it must be reported as a real change.

## Analyzing DOM differences

**`dom` output** — a JSON snapshot of the page structure at capture time. Every element carries fully resolved computed styles (e.g. `color: "rgb(2, 8, 23)"`, `font-size: "16px"`); text content appears as `#text` child nodes with a `text` field. Every element also carries a stable `id` field (e.g. `"id": "14"`) — a short, unambiguous reference to that specific node, usable to refer to it in other tools.

**`dom-diff` output** — shows only nodes that changed between baseline and checkpoint. Each entry has a `status` field: `"changed"`, `"new"`, `"missing"`, or `"displaced"`, and (except `"displaced"`) an `id` field identifying the node.

### `"changed"` entries

A node that exists in both baseline and checkpoint with differing properties. Includes a `baseline` object with the prior values of any diffed properties (style, attributes, rect, or text). A pair that is invisible (zero-size, `display:none`, `visibility:hidden`, `opacity:0`, or has a `hidden` attribute) on **both** sides is omitted entirely, since neither state could ever paint a pixel — if only one side is invisible, it's a real appearance/disappearance and is kept.

### `"new"` entries

A node present in the checkpoint only (added). Shows full style, attributes, and rect.

### `"missing"` entries

A `"missing"` entry with a `count` field means an entire baseline subtree was removed — collapsed into one line with the root's `tagName` and `attributes`, the total node count, and a union `rect`. To inspect the individual removed elements, use `dom <sessionUrl> <baselineDomId> <rect>`. A `"missing"` entry without `count` is a single removed node showing full style and attribute properties.

### `"displaced"` entries

A `"displaced"` entry means `count` checkpoint nodes shifted by the same position vector with no other changes. The displacement vector is `{left: rect.left − baseline.rect.left, top: rect.top − baseline.rect.top}`.

Displaced nodes are layout knock-on effects — they moved because something earlier in the document changed. The root cause is not in these nodes; look for `"changed"`, `"new"`, or `"missing"` entries earlier in the output to find what actually changed.

### DOM limitations

The DOM cannot detect an image whose `src` is unchanged but whose pixel content changed, or icon and font rendering differences. Use `screenshot` and `diff-image` for these.

## When to use `dom`

Use `dom <sessionUrl> <domId> [rect]` to capture the full page structure at a point in time:

- **Checkpoint `dom`** — inspect the exact computed styles or structure of the current render when you don't have access to the application's source code.
- **Baseline `dom`** — inspect the computed styles and structure of the baseline on its own.
- **Locating an element of interest** — find an element by its role or position to get its exact position (`rect`), style, structure, or its `id` for use as input to other tools (e.g. `eyes-resolve`'s `regionOp`) — rather than guessing from a screenshot crop or assuming a `domSelector` path's index (e.g. `li[8]`) is the last of its siblings without checking.

Once you have a `dom` capture, search it with `dom-search <filePath> <predicate>`. Before constructing a predicate, read [`dom-search.md`](./dom-search.md) (next to this file) — it has the full grammar, operator tables, and examples. For example, `tagName = 'HEADER'` finds the page's `<header>` element by tag, and `child-of (tagName = 'UL') and tagName = 'LI'` lists a `<ul>`'s `<li>` children so you can count them to confirm a "last"/"Nth" claim against the actual sibling count.

## API key

Requires `APPLITOOLS_READ_KEY` — a read-only key, separate from `APPLITOOLS_API_KEY` used for test execution.

Set it in `.env` or as an environment variable before running the command. In PowerShell you can set it like:

```
$env:APPLITOOLS_READ_KEY = "your_read_only_key_here"
```

The environment variable takes precedence over `.env`.
