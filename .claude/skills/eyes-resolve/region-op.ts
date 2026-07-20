import { parseRect } from 'geometry';
import type { Region, AnnotationCategory } from 'sessions';

export type RegionType = 'ignore' | 'strict' | 'ignorecolors' | 'dynamic' | 'layout';
export const SUPPORTED_REGION_TYPES: RegionType[] = ['ignore', 'strict', 'ignorecolors', 'dynamic', 'layout'];

export interface RegionOp {
  action: 'add' | 'remove';
  /** `'all'` only appears on a clear op (`targetRaw === '*'`) with no category restriction. */
  regionType: RegionType | 'all';
  targetRaw: string;
}

/** A clear op — `-*` (every category) or `-<category>-*`/`-<category>*` (one category) — drops every matching existing region instead of resolving a single id/rect target. */
export function isClearOp(op: RegionOp): boolean {
  return op.targetRaw === '*';
}

/**
 * Parses a compact regionOp string. Either a targeted op — `(+|-)<matchLevel>-(<rect>|<id>)`,
 * where `<matchLevel>` has no internal dashes so the first `-` in the remainder after the sign
 * cleanly separates it from the target — or a clear op, a removal-only glob with no target to
 * resolve: `-*` (every region, any category) or `-<matchLevel>-*`/`-<matchLevel>*` (every region
 * of one category).
 */
export function parseRegionOp(arg: string): RegionOp {
  const sign = arg[0];
  if (sign !== '+' && sign !== '-') {
    throw new Error(`regionOp must start with '+' or '-': "${arg}"`);
  }
  const rest = arg.slice(1);

  if (rest === '*' || /^[a-z]+-?\*$/i.test(rest)) {
    if (sign !== '-') {
      throw new Error(`"*" and "<matchLevel>*" clear existing regions — they're removal-only, so use '-', not '+': "${arg}"`);
    }
    if (rest === '*') {
      return { action: 'remove', regionType: 'all', targetRaw: '*' };
    }
    const regionType = rest.replace(/-?\*$/, '');
    if (!(SUPPORTED_REGION_TYPES as string[]).includes(regionType)) {
      throw new Error(`Unknown match level "${regionType}" in regionOp "${arg}". Supported: ${SUPPORTED_REGION_TYPES.join(', ')}`);
    }
    return { action: 'remove', regionType: regionType as RegionType, targetRaw: '*' };
  }

  const dashIndex = rest.indexOf('-');
  if (dashIndex === -1) {
    throw new Error(`regionOp must be in the form (+|-)<matchLevel>-<target>: "${arg}"`);
  }

  const regionType = rest.slice(0, dashIndex);
  const targetRaw = rest.slice(dashIndex + 1);
  if (!targetRaw) {
    throw new Error(`regionOp is missing a target: "${arg}"`);
  }
  if (!(SUPPORTED_REGION_TYPES as string[]).includes(regionType)) {
    throw new Error(`Unknown match level "${regionType}" in regionOp "${arg}". Supported: ${SUPPORTED_REGION_TYPES.join(', ')}`);
  }

  return { action: sign === '+' ? 'add' : 'remove', regionType: regionType as RegionType, targetRaw };
}

/** A target with no comma is a bare node `id` value; a target with commas is a raw rect. */
export function isIdTarget(targetRaw: string): boolean {
  return !targetRaw.includes(',');
}

/** Reconstructs a regionOp's canonical string form — the inverse of `parseRegionOp`. */
export function formatRegionOp(op: RegionOp): string {
  if (isClearOp(op)) {
    return op.regionType === 'all' ? '-*' : `-${op.regionType}-*`;
  }
  return `${op.action === 'add' ? '+' : '-'}${op.regionType}-${op.targetRaw}`;
}

// Matches eyes-compare/sdk-utils.ts's MATCH_LEVEL_MAP, which already maps both
// 'ignorecolors' and 'content' to the server-side 'IgnoreColors' level.
export const REGION_TYPE_TO_CATEGORY: Record<RegionType, AnnotationCategory> = {
  ignore: 'ignore',
  strict: 'strict',
  layout: 'layout',
  dynamic: 'dynamic',
  ignorecolors: 'content',
};

/**
 * Inverse of `REGION_TYPE_TO_CATEGORY` — a clean one-to-one mapping back for the 5 categories
 * a `regionOp` can actually express (`floating`/`remarks`/`mismatching`/`accessibility` have no
 * corresponding `matchLevel` and are absent here entirely, not mapped to `undefined`).
 */
export const CATEGORY_TO_REGION_TYPE: Partial<Record<AnnotationCategory, RegionType>> = {
  ignore: 'ignore',
  strict: 'strict',
  layout: 'layout',
  dynamic: 'dynamic',
  content: 'ignorecolors',
};

// ---------------------------------------------------------------------------
// propagate scope resolution
// ---------------------------------------------------------------------------

export interface PropagateSpec {
  /** `null` for a bare `propagate` — scope is exact-sessionName matches only. */
  regex: RegExp | null;
}

/** Parses a trailing `propagate` / `propagate=<regex>` argument. */
export function parsePropagateArg(arg: string): PropagateSpec {
  if (arg === 'propagate') return { regex: null };
  const match = arg.match(/^propagate=(.+)$/);
  if (!match) {
    throw new Error(`Invalid propagate argument: "${arg}" — expected "propagate" or "propagate=<regex>"`);
  }
  return { regex: new RegExp(match[1]) };
}

/**
 * Resolves `propagate`'s scope: every candidate whose `sessionName` exactly equals
 * `currentSessionName` (the current session's own scenario, across every environment it
 * ran in), plus — only when `spec.regex` is set — every candidate whose `sessionName`
 * additionally matches that regex. The current session itself is always excluded: the
 * caller handles its own step directly, this only resolves which *other* sessions are
 * in scope.
 */
export function resolvePropagateScope<T extends { sessionId: string; sessionName: string | undefined }>(
  candidates: T[], currentSessionId: string, currentSessionName: string | undefined, spec: PropagateSpec,
): T[] {
  return candidates.filter(c => {
    if (c.sessionId === currentSessionId) return false;
    if (c.sessionName === currentSessionName) return true;
    return spec.regex !== null && c.sessionName !== undefined && spec.regex.test(c.sessionName);
  });
}

/** Parses a rect-form target ("left,top,width,height") into a Region with no domSelector. */
export function parseRectTarget(targetRaw: string): Region {
  return { domSelector: '', ...parseRect(targetRaw) };
}
