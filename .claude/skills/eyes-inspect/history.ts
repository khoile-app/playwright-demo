import { parseSessionUrl, fetchRawSession, fetchDomSnapshot, fetchSessionHistory, type SessionHistoryEnv } from 'api';
import { validateDomId } from 'sessions/dom';
import { simplifySession, extractScenarioId } from 'sessions/session';
import { validateStepIndex } from 'sessions';
import {
  createHistoricDomNodeTrackers, applyHistoricDom, finalizeHistoricDomNodeEvidence,
  type HistoricDomNodeTracker,
} from 'sessions/dom-history';

const DEFAULT_COUNT = 3;
const SEARCH_MULTIPLIER = 2;
const SEARCH_CAP = 10;

export interface ParsedHistoryArgs {
  stepIndex: number;
  nodeIds: string[];
  count: number;
}

/**
 * Parses `<stepIndex> <nodeId>[,<nodeId>...] [count]`. Pure — throws a descriptive Error,
 * doesn't exit the process itself (mirrors `batch-view.ts`'s `parseBatchArgs`).
 */
export function parseHistoryArgs(rawArgs: string[]): ParsedHistoryArgs {
  // The node id list must arrive as a single shell token (no unquoted spaces) — otherwise the
  // shell itself splits it into extra positional args, which parseInt/split would silently
  // misinterpret rather than error on (a stray id could parse as `count`, and the rest would
  // just vanish). Rejecting >3 args outright surfaces that misuse immediately instead.
  if (rawArgs.length > 3) {
    throw new Error(
      `Too many arguments: ${rawArgs.join(' ')}. Node ids must be one comma-separated argument ` +
      'with no spaces (e.g. "14,27,54"), not separate arguments.',
    );
  }

  const [stepArg, nodeIdsArg, countArg] = rawArgs;
  if (stepArg === undefined || nodeIdsArg === undefined) {
    throw new Error('Usage: history <sessionUrl> <stepIndex> <nodeId>[,<nodeId>...] [count]');
  }

  const stepIndex = parseInt(stepArg, 10);
  if (isNaN(stepIndex) || stepIndex < 0) {
    throw new Error(`Invalid step index: "${stepArg}"`);
  }

  const nodeIds = nodeIdsArg.split(',').map(s => s.trim()).filter(Boolean);
  if (nodeIds.length === 0) {
    throw new Error(`No node ids given: "${nodeIdsArg}"`);
  }

  let count = DEFAULT_COUNT;
  if (countArg !== undefined) {
    count = parseInt(countArg, 10);
    if (isNaN(count) || count < 1) {
      throw new Error(`Invalid count: "${countArg}"`);
    }
  }

  return { stepIndex, nodeIds, count };
}

export interface WalkHistoricSourcesOptions {
  baseUrl: string;
  scenarioId: string;
  accountId: string;
  apiKey: string;
  env: SessionHistoryEnv;
  ranAtOrBefore: string;
  count: number;
}

export interface WalkHistoricSourcesDeps {
  fetchSessionHistory: typeof fetchSessionHistory;
  fetchDomSnapshot: typeof fetchDomSnapshot;
}

export interface SkippedHistoricRun {
  step: string;
  capturedAt: string;
  reason: string;
}

export interface WalkHistoricSourcesResult {
  examined: number;
  skipped: SkippedHistoricRun[];
}

/**
 * The lazy loop: a single `fetchSessionHistory` call requesting `min(SEARCH_CAP, count *
 * SEARCH_MULTIPLIER)` candidate historic sessions — a hard ceiling on how many historic runs
 * are ever searched, regardless of `count` — then walks them in order, newest to oldest. For
 * each candidate: checks its step at `currentIndex` and that step's checkpoint domId (cheap,
 * no fetch) — skipping and recording a reason if unusable (Phase 1: index-based step
 * correspondence, no realignment — see the plan's Phase 1/Phase 2 split) — and only then
 * fetches that step's DOM snapshot and immediately applies it to every tracker, before looking
 * at the next candidate. `count` is the target number of non-empty diffs per node — stops as
 * soon as every tracker has reached it, or the candidate list is exhausted, so it never fetches
 * a DOM snapshot no tracker still needs.
 */
export async function walkHistoricSources(
  options: WalkHistoricSourcesOptions,
  currentIndex: number,
  trackers: HistoricDomNodeTracker[],
  deps: WalkHistoricSourcesDeps,
): Promise<WalkHistoricSourcesResult> {
  const { baseUrl, scenarioId, accountId, apiKey, env, ranAtOrBefore, count } = options;
  const searchLimit = Math.min(SEARCH_CAP, count * SEARCH_MULTIPLIER);

  const candidates = await deps.fetchSessionHistory({ baseUrl, scenarioId, accountId, apiKey, env, ranAtOrBefore, count: searchLimit });

  let examined = 0;
  const skipped: SkippedHistoricRun[] = [];

  for (const rawCandidate of candidates) {
    if (trackers.length > 0 && trackers.every(t => t.diffs.length >= count)) break;
    examined++;

    const capturedAt = rawCandidate?.startedAt ?? 'unknown';
    // <batchId>/<sessionId>/<stepIndex> — an opaque reference a caller can use to navigate
    // back to this exact historic step (e.g. build a session URL, or re-run another
    // eyes-inspect command against it). stepIndex is 0-based, matching this skill's own
    // convention (e.g. `dom-diff`'s own <stepIndex> argument) — not the dashboard's 1-based
    // `/steps/N` URL segment.
    const stepPath = `${rawCandidate?.batchId ?? 'unknown'}/${rawCandidate?.id ?? 'unknown'}/${currentIndex}`;

    const candidateSteps = simplifySession(rawCandidate).steps;
    const matchedStep = candidateSteps[currentIndex];

    if (!matchedStep) {
      skipped.push({ step: stepPath, capturedAt, reason: `session has fewer than ${currentIndex + 1} steps` });
      continue;
    }
    if (!matchedStep.checkpoint.domId) {
      skipped.push({ step: stepPath, capturedAt, reason: 'step at this index has no checkpoint DOM capture' });
      continue;
    }

    const root = await deps.fetchDomSnapshot({ baseUrl, domId: matchedStep.checkpoint.domId, apiKey });
    applyHistoricDom(trackers, { step: stepPath, capturedAt, root }, count);
  }

  return { examined, skipped };
}

export interface RunHistoryDeps extends WalkHistoricSourcesDeps {
  fetchRawSession: typeof fetchRawSession;
}

export const defaultRunHistoryDeps: RunHistoryDeps = {
  fetchRawSession,
  fetchSessionHistory,
  fetchDomSnapshot,
};

/** The current session's own `startedAt` minus one second — not `startedAt` itself, since the
 * session-history filter is inclusive and passing the exact timestamp risks the query
 * returning the current session as its own "historic" match. */
function oneSecondBefore(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  date.setSeconds(date.getSeconds() - 1);
  return date.toISOString();
}

/**
 * The `history` command: surfaces, per suspect node id, every historic variant of that
 * element's dom that differs from its current value — evidence for the calling LLM to reason
 * about, not a dynamic/stable verdict computed here.
 */
export async function runHistory(
  url: string,
  stepIndex: number,
  nodeIds: string[],
  count: number,
  apiKey: string,
  deps: RunHistoryDeps = defaultRunHistoryDeps,
): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  try {
    const rawSession = await deps.fetchRawSession({ baseUrl, batchId, sessionId, accountId, apiKey });
    validateStepIndex(rawSession, stepIndex);

    const session = simplifySession(rawSession);
    const currentStep = session.steps[stepIndex];

    const domError = validateDomId(currentStep.checkpoint.domId);
    if (domError) throw new Error(domError);

    const scenarioId = extractScenarioId(rawSession);
    const { browser, os, width, height } = session.environment;
    const env: SessionHistoryEnv = {
      hostingApp: browser,
      os,
      displaySize: width != null && height != null ? { width, height } : null,
    };

    const currentRoot = await deps.fetchDomSnapshot({ baseUrl, domId: currentStep.checkpoint.domId!, apiKey });
    // <batchId>/<sessionId>/<stepIndex> — same shape as walkHistoricSources's own stepPath, so
    // the current step is identifiable/navigable the same way a historic one is.
    const currentStepPath = `${batchId}/${sessionId}/${stepIndex}`;
    const trackers = createHistoricDomNodeTrackers(currentRoot, nodeIds, currentStepPath, session.startedAt);

    await walkHistoricSources(
      { baseUrl, scenarioId, accountId, apiKey, env, ranAtOrBefore: oneSecondBefore(session.startedAt), count },
      stepIndex,
      trackers,
      deps,
    );

    const evidence = finalizeHistoricDomNodeEvidence(trackers);
    const output: Record<string, ReturnType<typeof finalizeHistoricDomNodeEvidence>[number]['diffs']> = {};
    for (const e of evidence) output[e.nodeId] = e.diffs;

    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error('Error computing history:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
