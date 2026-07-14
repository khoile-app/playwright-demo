---
name: eyes-resolve
description: Accept or reject visual differences in Applitools Eyes test steps and save the changes to baselines. Use when the user wants to accept or reject a checkpoint, approve visual changes, or save baselines after reviewing test results.
---

# Eyes Resolve

Accept or reject visual differences in Applitools Eyes test steps, then save the updated baselines.

## Commands

`/eyes-resolve <command> [args]`

**Shared args**
- `sessionUrl` — Eyes session URL: `https://eyes.applitools.com/app/test-results/{batchId}/{sessionId}?accountId=...`
- `batchUrl` — Eyes batch URL: `https://eyes.applitools.com/app/test-results/{batchId}/?accountId=...`
- `stepIndex` — zero-based step index (as returned by `/eyes-inspect steps`)

**Commands and arguments**
- `accept <sessionUrl> <stepIndex>` — marks the checkpoint image of the step as accepted without updating the test baseline. If `save` is subsequently called on the test, the baseline image of the step will be replaced by the step's checkpoint image.
- `reject <sessionUrl> <stepIndex>` — marks the checkpoint image of the step as rejected. If `save` is subsequently called on the test, the baseline image of the step will be retained.
- `save <sessionUrl>` — save all resolved steps to the baseline
- `restore <batchUrl>` — for every saved session in the batch, restores the baseline to the revision the test originally ran against.

## Execution

```
!npx tsx .claude/skills/eyes-resolve/main.ts <command> [args]
```

## Workflow

> **Changing baselines is destructive** — a future regression in the same area will go undetected. Never accept or save without explicit user approval.

1. Use `/eyes-inspect steps <sessionUrl>` to list steps and identify which are unresolved or failed.
2. For each non-matching step, use `/eyes-inspect` to view the visual diff and describe every change to the user.
3. **Ask for approval before touching anything.** You may ask once for all steps ("accept all?"), but the ask must happen before any `accept` or `reject` call.
4. Run `accept` or `reject` for each step — these can run in parallel across steps. Wait for all calls to complete.
5. Only after all steps are resolved, run `save <sessionUrl>` to commit the baselines.
6. Re-run the same test suite that produced the batch. Use the same command that was run before (e.g. `npx playwright test` from the same directory). Fetch and check the visual results — all previously unresolved steps must now show as **passed**. If any step is still unresolved or failed, report it to the user and do not declare success.
7. Report the outcome to the user.

## API key

Requires `APPLITOOLS_WRITE_KEY` — a write-capable key that also works for read operations.
Set it in `.env` or as an environment variable; the environment takes precedence over `.env`.