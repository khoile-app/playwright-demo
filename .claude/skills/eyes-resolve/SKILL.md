---
name: eyes-resolve
description: Accept or reject visual differences in Applitools Eyes test steps, sessions or batches and save the changes to baselines. Use when the user wants to accept or reject a checkpoint, approve visual changes, save baselines after reviewing test results, or add/remove/update a match region — e.g. to ignore, exclude, or supress changes due to dynamic content (dates, counters, ads, animations) so it stops failing test runs. Trigger when th user wants to review test results or resolve visual differences.
---

# Eyes Resolve

Accept or reject visual differences in Applitools Eyes test results, update match regions to supress dynamic content changes, and then save the updated baselines.

## Commands

`/eyes-resolve <command> [args]`

**Shared args**
- `sessionUrl` — Eyes session URL: `https://eyes.applitools.com/app/test-results/{batchId}/{sessionId}?accountId=...`
- `batchUrl` — Eyes batch URL: `https://eyes.applitools.com/app/test-results/{batchId}/?accountId=...`
- `stepIndex` — zero-based step index (as returned by `/eyes-inspect steps`)
- `regionOp` — a compact match-region change: `(+|-)<matchLevel>-(<rect>|<id>)`
  - Leading `+` adds a region, `-` removes one.
  - `<matchLevel>` is one of `ignore`, `strict`, `ignorecolors`, `dynamic`, `layout`.
  - Target is either a raw rect `left,top,width,height` or a bare `id` from `/eyes-inspect`'s `dom`/`dom-diff` output, e.g. `14`. To remove an existing region, get its rect from `/eyes-inspect regions`.
  - A rect target works even with no DOM capture; when one exists, it's automatically matched to the corresponding element so the region tracks it rather than a fixed set of pixels.
  - Examples: `+ignore-14` (ignore node 14), `-layout-100,200,50,80` (remove a previously-added layout region at that rect).
  - A removal can also be a glob: `-*` removes every region regardless of category; `-<matchLevel>-*` removes every region of just that category, e.g. `-ignore-*`.
- `propagate[=<regex>]` — extends the scope of a command to other sessions in the batch, in addition to the target session step itself:
  - Omitted: only the current step is updated.
  - Bare `propagate`: also update every other session of the same test scenario (other browsers/OS/viewports).
  - `propagate=<regex>`: also every session whose scenario name matches the regex, e.g. `propagate="Login|Checkout"`.

**Commands and arguments**
- `accept <sessionUrl> <stepIndex>` — marks the checkpoint image of the step as accepted without updating the test baseline. If `save` is subsequently called on the test, the baseline image of the step will be replaced by the step's checkpoint image.
- `reject <sessionUrl> <stepIndex>` — marks the checkpoint image of the step as rejected. If `save` is subsequently called on the test, the baseline image of the step will be retained.
- `baseline-regions <sessionUrl> <stepIndex> <regionOp...> [propagate[=<regex>]]` — adds/removes/updates a step's match regions, with every `regionOp`'s ids/rects read against the **baseline** DOM. Doesn't itself change accept/reject resolution. Requires at least one `regionOp`. Returns one entry per target step, each including a list of mappings between an input `regionOp` and all the regions that were updated in that step because of it. A clear op never appears as itself — it's replaced by zero or more `regionOp`s representing the regions it actually removed from the step specified in the commands input.
- `checkpoint-regions <sessionUrl> <stepIndex> <regionOp...> [propagate[=<regex>]]` — same, but reads ids/rects against the **checkpoint** DOM.
- `save <sessionUrl>` — save all resolved steps and region updates to the baseline. This is a potentially destructive operation so it should only be used with explicit user approval.
- `reset <batchUrl>` — restores every session's baseline to the revision the test originally ran against, and clears any pending resolution (accept/reject/region changes) back to unresolved. This is a potentially destructive operation that cannot be undone, so it should only be used with explicit user approval.

## Execution

```
!npx tsx .claude/skills/eyes-resolve/main.ts <command> [args]
```

## Batch review workflow

**Goal:** resolve as many `unresolved` sessions in the batch as possible, each into `accepted` or `rejected`.

1. Use `/eyes-inspect batch <batchUrl> unresolved` to get the list of unresolved sessions, then `/eyes-inspect steps <sessionUrl>` for each to find its own unresolved/failed steps.
2. Investigate each such step using `/eyes-inspect`'s own describing/investigating workflow — don't skip any of its phases — before deciding accept or reject. For each distinct change found, check it against **When a step must be rejected** before weighing any accept justification for it — an explained cause never overrides a reject criterion.
3. Apply `accept`/`reject` and any `baseline-regions`/`checkpoint-regions` calls; these can run in parallel across steps.
4. Report a concise summary — the differences encountered, which steps were accepted, which region changes were made, and performed / suggested changes to the test code. If anything was accepted/rejected or any region was changed, ask the user for approval before running `save`, since that's what actually commits the changes for future test runs.
5. After `save`, re-run the same test suite that produced the batch and confirm previously-unresolved steps now pass. Report if any step is still unresolved or failed rather than declaring success.

**When a step must be rejected — check this first, per distinct change, before considering acceptance.** If even *one* change within a step falls under any of the following, reject the whole step — no matter how well any other change in it is understood or justified:
1. It contains an unexpected change.
2. It contains an obvious visual bug — misalignment, overlapping elements, elements falling outside the page bounds, typos, partial page rendering, an element meant to be fixed/centered/symmetric shifting position. This applies even when the change is a knock-on effect of another change whose root cause is fully understood — an understood cause is never a justification for a visual bug.
3. It's a trailing step with a missing checkpoint in an aborted test.

**When a step may be accepted.** Only for changes that cleared the reject list above: only accept a change that's consistent with its surroundings — similar size, alignment, color scheme, content, etc. Beyond that, a step may be accepted only if *every* change within it can be attributed to at least one of the following; otherwise, reject it:
1. There's an explicit understanding of the expected change — from the user's prompt, a spec/requirements doc, a Jira ticket, commit summaries, or code changes just made.
2. The change is due to dynamic content on the page (a recurring date/time, ad, or rotating text/image/graphic). Justify this only from evidence gathered during this investigation, or an explicit direction in the user's prompt — application code actually read, DOM structure actually inspected, signals surfaced by `/eyes-inspect history` run on the changed node showing it varies across multiple (never a single) prior executions — never from general/background knowledge about how a similar-looking real-world site or app is assumed to behave. State the specific evidence in the summary.

**Masking dynamic content.** When a step is accepted because of dynamic data, also add a match region over the changed area so the dynamic content doesn't fail future runs — the match level depends on the kind of change:
- A common pattern (date, time, phone number, numeric id, etc.) → `dynamic`.
- Text-to-text, image-to-image, or a combination of both → `layout`.
- Anything more complex than that → `ignore`.

This table applies only when the element's own content changed. If an element's content is unchanged and only its position drifted, use **Handling unstable component positioning** below instead of this table.

**Handling unstable component positioning.** Pure positional drift — same content, different rect — is never covered by the table above. It may only be masked as `dynamic` (never `layout`, unless the element's content is itself fully dynamic), and only up to ~3px of recurring drift, evidenced via `/eyes-inspect history` across multiple executions — never assumed from a single one. An unevidenced shift, or one beyond that bound, is not a masking candidate: treat it as a rejection under the visual-bug criteria above (e.g. a centered/fixed/symmetric element that no longer is), even when you can fully explain what caused it.

**Layout and ignore region granularity.** Add one region per distinct, individually-positioned element — never one region spanning multiple sibling elements just because they sit near each other or share the same cause. Avoid large regions that span an area containing other distinct elements that aren't themselves dynamic; a blanket region loses coverage across the whole span for no reason, so each element keeps its own precise region instead. The exception is a list or table whose item *count* is itself dynamic (rows can appear/disappear) — there, individual items don't have a stable identity/position to anchor a per-element region to, so group them under one region covering the whole list/table instead.

**Region hygiene.** Don't nest regions — one region may slightly overlap another, but one region falling entirely inside another is a sign the granularity is wrong. Don't create huge `ignore` regions that nullify the purpose of the check. A region that must move with its component (e.g. to tolerate drift, per above) only does so when the step has a DOM capture — without one it's anchored to a fixed rect.

**Propagating resolutions.** Always `propagate` resolutions to sibling sessions of the same scenario (other browsers/environments), as they are most likely to show the same changes. UI changes tend to span large parts of the application under test (e.g. changing the header of a website), so propagate to other related scenarios of the batch too, to avoid re-investigating the same change repeatedly.

**Extremely dynamic or frequently changing pages** (e.g. active development, or several teams independently touching different parts of it): the test's overall match level should be `none`, with specific match regions added over just the static parts of interest — however small. This is a test-code change, not something `eyes-resolve` can apply directly (it can only add per-region overrides, not change a step's overall match level): make the change directly if you have access to the test code; otherwise leave the step unresolved and recommend the change to the user in the review summary.

**New or missing steps in a completed (non-aborted) session** (a step with no baseline image, or no checkpoint image, respectively) may be accepted only if a corresponding checkpoint was added or removed from the test code, respectively. If uncertain, leave the step unresolved.

## API key

Requires `APPLITOOLS_WRITE_KEY` — a write-capable key that also works for read operations.
Set it in `.env` or as an environment variable; the environment takes precedence over `.env`.