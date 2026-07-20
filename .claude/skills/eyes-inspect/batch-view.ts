import { computeBatchStats, BATCH_FILTERS, type BatchFilter, type BatchStats } from 'sessions/batch';
import type { SimplifiedSession } from 'sessions/session';

export const BATCH_FORMATS = ['full', 'stats', 'scenarios'] as const;
export type BatchFormat = typeof BATCH_FORMATS[number];

export interface ParsedBatchArgs {
  filter?: BatchFilter;
  format: BatchFormat;
}

/**
 * Parses the `batch` command's optional `filter`/`format` args. Both are recognized by value
 * membership in their own set, not position — either can be given alone, in either order.
 * Throws a descriptive `Error` on an unrecognized value or a duplicate filter/format, rather
 * than exiting the process itself, so this stays a pure, testable function — the caller
 * decides how to report the failure.
 */
export function parseBatchArgs(rawArgs: string[]): ParsedBatchArgs {
  let filter: BatchFilter | undefined;
  let format: BatchFormat | undefined;

  for (const arg of rawArgs) {
    if ((BATCH_FILTERS as readonly string[]).includes(arg)) {
      if (filter !== undefined) {
        throw new Error(`Duplicate filter argument: "${arg}" (already have "${filter}")`);
      }
      filter = arg as BatchFilter;
    } else if ((BATCH_FORMATS as readonly string[]).includes(arg)) {
      if (format !== undefined) {
        throw new Error(`Duplicate format argument: "${arg}" (already have "${format}")`);
      }
      format = arg as BatchFormat;
    } else {
      throw new Error(
        `Unknown batch argument: "${arg}". Supported filters: ${BATCH_FILTERS.join(', ')}. Supported formats: ${BATCH_FORMATS.join(', ')}`,
      );
    }
  }

  return { filter, format: format ?? 'full' };
}

export type BatchOutput =
  | { stats: BatchStats; sessions: Array<Omit<SimplifiedSession, 'steps'> & { steps: null }> }
  | { stats: BatchStats }
  | { scenarios: string[] };

/**
 * Shapes an already-filtered session list per `format` — `full` (stats plus the session
 * list, `steps` stripped since step-level detail is already aggregated into `stats`), `stats`
 * (stats only), or `scenarios` (the deduplicated, sorted list of matching `sessionName`s, no
 * stats at all). Always computes `stats` from `sessions` itself (never the batch's own
 * server-maintained aggregate) — the no-filter/`stats` fast path that reads that aggregate
 * directly, skipping session-fetching entirely, is a network-call decision that lives with
 * the caller, above this function.
 */
export function formatBatchOutput(sessions: SimplifiedSession[], format: BatchFormat): BatchOutput {
  if (format === 'scenarios') {
    return { scenarios: [...new Set(sessions.map(s => s.sessionName))].sort() };
  }
  const stats = computeBatchStats(sessions);
  if (format === 'stats') return { stats };
  return { stats, sessions: sessions.map(s => ({ ...s, steps: null })) };
}
