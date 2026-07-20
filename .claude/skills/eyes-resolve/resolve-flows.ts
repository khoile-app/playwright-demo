import { resolveNodeIdsToNodes, findNodeByRect, findNodeBySelector } from 'sessions/dom';
import {
  type Region, type AnnotationCategory,
  emptyAnnotations,
  getEffectiveRegions, removeSimilarRegion, findSimilarExistingRegion, bucketRegions, resolveDomIdSide, imageForSide, validateStepIndex,
  checkRegions, clearStaleSelectors, healNonAnchoredRegionsBySourceRect, mapAnchoredRegionsBySelector,
} from 'sessions';
import {
  type RegionOp, type RegionType, type PropagateSpec,
  isIdTarget, isClearOp, parseRectTarget, REGION_TYPE_TO_CATEGORY, CATEGORY_TO_REGION_TYPE, formatRegionOp,
  resolvePropagateScope,
} from './region-op.js';
import { formatRect } from 'geometry';
import { simplifySession, hasUnsavedChanges, type SessionEnvironment } from 'sessions/session';
import { type FoundRegion } from 'api';

export type ResolveAction = 'accept' | 'reject' | 'baseline-regions' | 'checkpoint-regions';

// dom's resolveNodeIdsToNodes/findNodeByRect return a nested {domSelector, rect} shape; the
// outbound API payload needs the flat Region shape (domSelector alongside
// left/top/width/height).
function toRegion(resolved: { domSelector: string; rect: { left: number; top: number; width: number; height: number } }): Region {
  return { domSelector: resolved.domSelector, ...resolved.rect };
}

// Upgrades a raw rect target into a domSelector-backed region when a matching element
// exists in the DOM — the region then tracks that element rather than a fixed set of
// pixels. Falls back to the literal rect (no domSelector) if no DOM was fetched (`domRoot`
// null — no DOM capture for this step) or no element matches closely enough.
function rectTargetToRegion(targetRaw: string, domRoot: any): Region {
  const parsed = parseRectTarget(targetRaw);
  if (!domRoot) return parsed;
  const found = findNodeByRect(domRoot, parsed);
  return found ? toRegion(found) : parsed;
}

export interface ParsedSessionUrl {
  baseUrl: string;
  batchId: string;
  sessionId: string;
  accountId: string;
}

export interface ParsedUrl {
  baseUrl: string;
  batchId: string;
  sessionId: string | null;
  accountId: string;
}

export interface RawSessionOptions {
  baseUrl: string;
  batchId: string;
  sessionId: string;
  accountId: string;
  apiKey: string;
}

export interface RawBatchSessionsOptions {
  baseUrl: string;
  batchId: string;
  accountId: string;
  apiKey: string;
}

export interface ResolveStepDeps {
  parseSessionUrl: (url: string) => ParsedSessionUrl;
  fetchRawSession: (options: RawSessionOptions) => Promise<any>;
  fetchRawBatchSessions: (options: RawBatchSessionsOptions) => Promise<any[]>;
  fetchDomForSide: (rawSession: any, stepIndex: number, side: 'baseline' | 'checkpoint', baseUrl: string) => Promise<any>;
  getCompatibleSelectors: (
    options: { baseUrl: string; accountId: string; apiKey: string },
    image1: any, image2: any, selectors: string[],
  ) => Promise<(string | null)[]>;
  findRegionsInImages: (
    sourceImage: any, regions: Region[], targets: any[],
    options: { baseUrl: string; accountId: string; apiKey: string },
  ) => Promise<Record<string, FoundRegion[]>>;
  postJson: (url: string, body: unknown) => Promise<Response>;
  getJsonResult: (response: Response, apiKey: string) => Promise<any>;
  apiKey: string;
}

/**
 * One input regionOp and every region actually affected by it on a given (session, step) —
 * added, for an add op; removed, for a remove or clear op (a clear reports every region it
 * actually cleared, not just one). Usually one region for add/remove — but `propagate`'s
 * `images/find` search (`firstOnly=false`) can surface more than one match for the same
 * source region on a single target (e.g. a repeated component appearing twice on that page),
 * and each one is added/removed there in turn, not just the first. Empty when there was
 * nothing to remove/clear there at all.
 */
export interface AppliedRegionOp {
  op: string;
  result: Region[];
}

/** One (session, step) actually touched by a `baseline-regions`/`checkpoint-regions` call — the current step always appears here; `propagate` may add more. */
export interface RegionOpResult {
  sessionId: string;
  sessionName: string | undefined;
  environment: SessionEnvironment;
  stepIndex: number;
  appliedRegionOps: AppliedRegionOp[];
}

export type ResolveStepResult =
  | { status: 'accepted' | 'rejected'; stepIndex: number; sessionId: string; batchId: string }
  | RegionOpResult[];

/**
 * Resolves a step (accept/reject) or adjusts its match regions (baseline-regions/
 * checkpoint-regions) — never both in the same call. `baseline-regions`/`checkpoint-regions`
 * don't themselves change the step's resolution; the command name is an explicit, unskippable
 * declaration of which DOM a regionOp's ids/rects are described against (`refSide`) — every
 * target is resolved there first, then converted onto whichever side the step's resolution
 * actually needs (`newSide`) if that differs, via the same get-compatible-selectors mapping
 * used below for re-anchoring existing regions on a resolution flip. See eyes-resolve/SKILL.md
 * for the regionOp syntax and workflow.
 */
export async function resolveStepFlow(
  url: string, stepIndex: number, action: ResolveAction, regionOps: RegionOp[], deps: ResolveStepDeps,
  propagate?: PropagateSpec | null,
): Promise<ResolveStepResult> {
  const isRegionsAction = action === 'baseline-regions' || action === 'checkpoint-regions';

  if (isRegionsAction && regionOps.length === 0) {
    throw new Error(`'${action}' requires at least one regionOp — nothing to do otherwise`);
  }
  if (!isRegionsAction && regionOps.length > 0) {
    throw new Error(
      `'${action}' takes no regionOps — use 'baseline-regions' or 'checkpoint-regions' to add/remove/update ` +
      `match regions, then '${action}' separately to resolve the step`,
    );
  }
  if (propagate && !isRegionsAction) {
    throw new Error(`'propagate' is not yet supported for '${action}' — only 'baseline-regions'/'checkpoint-regions' support it today`);
  }

  const { baseUrl, batchId, sessionId, accountId } = deps.parseSessionUrl(url);
  const stepUpdate: any = { index: stepIndex, variantId: null };
  if (!isRegionsAction) {
    stepUpdate.replaceExpected = action === 'accept'; // baseline-regions/checkpoint-regions never send replaceExpected at all
  }

  // accept/reject can change which side is "the baseline going forward" just as much as a
  // prior call already might have (the case baseline-regions/checkpoint-regions already have
  // to account for) — so every action, not just the regions ones, needs the current raw
  // session to check.
  const rawSession = await deps.fetchRawSession({ baseUrl, batchId, sessionId, accountId, apiKey: deps.apiKey });
  validateStepIndex(rawSession, stepIndex);

  // previousSide is whichever side existing regions' domSelectors are already anchored to;
  // newSide is what this call is about to make "the baseline going forward" instead.
  // Reusing resolveDomIdSide for both ('unchanged' always yields the pre-existing side,
  // regardless of this call's actual action) keeps this in lockstep with the one place that
  // logic already lives, rather than re-deriving it here. baseline-regions/checkpoint-regions
  // never change resolution, so their newSide is always 'unchanged' too — same as previousSide.
  const domIdSideAction: 'accept' | 'reject' | 'unchanged' =
    action === 'accept' || action === 'reject' ? action : 'unchanged';
  const previousSide = resolveDomIdSide('unchanged', rawSession, stepIndex);
  const newSide = resolveDomIdSide(domIdSideAction, rawSession, stepIndex);

  const regionPairs = getEffectiveRegions(rawSession, stepIndex).regions;

  // Reversing the resolution (e.g. accept after a prior reject, or vice versa) moves "the
  // baseline going forward" to the other image. Every existing region is now describing the
  // wrong element unless it's re-anchored to the new side: `checkRegions` classifies each pair
  // (verifying a domSelector against the previous side's own DOM), `clearStaleSelectors` gives
  // up on any bad one so it can be retried, `healNonAnchoredRegionsBySourceRect` anchors as
  // many of those survivors as it can by rect, and `mapAnchoredRegionsBySelector` maps the
  // combined anchored set to the new side via get-compatible-selectors — so a region recovered
  // by rect still gets its new-side position confirmed via the API rather than trusting the
  // rect match's coordinates directly. A pair that still can't be anchored is left incomplete.
  // Only accept/reject can ever trigger this (baseline-regions/checkpoint-regions always
  // compute newSide === previousSide, since neither changes resolution).
  const sideFlipped = newSide !== previousSide;
  let remapped = false;
  if (sideFlipped && regionPairs.some(p => !p.baseline || !p.checkpoint)) {
    const domPrevious = await deps.fetchDomForSide(rawSession, stepIndex, previousSide, baseUrl).catch(() => null);
    const { anchored, nonAnchored } = checkRegions(regionPairs, domPrevious);
    const staleCleared = clearStaleSelectors(nonAnchored);
    const healedByRect = healNonAnchoredRegionsBySourceRect(nonAnchored, domPrevious);
    const nowAnchored = nonAnchored.filter(p => (p.baseline ?? p.checkpoint)!.domSelector);
    const mapped = await mapAnchoredRegionsBySelector(rawSession, stepIndex, [...anchored, ...nowAnchored], {
      baseUrl, accountId, apiKey: deps.apiKey,
      fetchDomForSide: deps.fetchDomForSide,
      getCompatibleSelectors: deps.getCompatibleSelectors,
    });
    remapped = staleCleared || healedByRect || mapped;
  }

  // Flatten back down to the plain {category, region} shape regionOp handling below works
  // with, preferring the freshly-healed newSide (when a flip happened) over the original side.
  const entries = regionPairs.map(({ category, baseline, checkpoint }) => ({
    category, region: (newSide === 'baseline' ? baseline ?? checkpoint : checkpoint ?? baseline)!,
  }));

  let regionResults: RegionOpResult[] | undefined;
  const extraUpdates: any[] = [];

  if (isRegionsAction) {
    const refSide: 'baseline' | 'checkpoint' = action === 'baseline-regions' ? 'baseline' : 'checkpoint';

    // Clear ops (-*, -<matchLevel>-*) drop existing regions by category rather than resolving
    // a single id/rect target, so they're excluded from the id/rect DOM-fetch calculus below.
    const targetedOps = regionOps.filter(op => !isClearOp(op));
    const idTargets = targetedOps.map(op => op.targetRaw).filter(isIdTarget);
    const hasRectTargets = targetedOps.some(op => !isIdTarget(op.targetRaw));

    // Every target is resolved against refSide — the DOM the caller explicitly declared these
    // ids/rects describe (id-form regionOps require it; rect-form ones only benefit from it).
    let domRef: any = null;
    if (idTargets.length > 0) {
      domRef = await deps.fetchDomForSide(rawSession, stepIndex, refSide, baseUrl);
    } else if (hasRectTargets) {
      domRef = await deps.fetchDomForSide(rawSession, stepIndex, refSide, baseUrl).catch(() => null);
    }

    // An id absent from refSide's DOM throws here (resolveNodeIdsToNodes's existing "not
    // found" error, naming every bad one) — before anything is sent to the API, the only
    // mutation being the final postJson call below, so a bad id fails cleanly with no
    // partial change to the session. This is the only case that fails at all: a rect target
    // that matches no element on refSide just comes back as a plain, unanchored rect (see
    // rectTargetToRegion) instead of throwing.
    const idRegionsOnRef = idTargets.length > 0
      ? resolveNodeIdsToNodes(domRef, idTargets)
      : new Map<string, { domSelector: string; rect: { left: number; top: number; width: number; height: number } }>();

    const resolvedOnRef = new Map<string, Region>();
    for (const op of targetedOps) {
      if (resolvedOnRef.has(op.targetRaw)) continue;
      resolvedOnRef.set(op.targetRaw, isIdTarget(op.targetRaw)
        ? toRegion(idRegionsOnRef.get(op.targetRaw)!)
        : rectTargetToRegion(op.targetRaw, domRef));
    }

    // A snapshot of each op's region as resolved on refSide, before the refSide→newSide
    // conversion below may rewrite resolvedOnRef in place — propagation always searches
    // against refSide (sourceImage is refSide's own image), regardless of what side this
    // step's own regions ultimately get stored on.
    const resolvedOnRefBeforeConversion = new Map(resolvedOnRef);

    // Convert every anchored (domSelector-bearing) region from refSide to newSide, if they
    // differ — the same get-compatible-selectors mapping used above for re-anchoring existing
    // regions on a resolution flip. A region with no domSelector (a rect that matched no
    // element on refSide) has nothing to map: it's fully allowed to carry over as-is, same
    // rect, still no domSelector — exactly like the established "unanchored region"
    // convention elsewhere in this file and in sessions/regions.ts.
    if (refSide !== newSide) {
      const toConvert = [...resolvedOnRef.entries()].filter(([, region]) => region.domSelector);
      if (toConvert.length > 0) {
        const imageRef = imageForSide(rawSession, stepIndex, refSide);
        const imageNew = imageForSide(rawSession, stepIndex, newSide);
        const domNew = await deps.fetchDomForSide(rawSession, stepIndex, newSide, baseUrl).catch(() => null);
        const selectors = toConvert.map(([, region]) => region.domSelector);
        let mapped: (string | null)[];
        try {
          mapped = await deps.getCompatibleSelectors(
            { baseUrl, accountId, apiKey: deps.apiKey }, imageRef, imageNew, selectors,
          );
        } catch {
          mapped = selectors.map(() => null); // the batch itself failed — treat every one as unmapped rather than throwing
        }
        toConvert.forEach(([targetRaw, region], i) => {
          const newSelector = mapped[i];
          const resolvedNew = newSelector && domNew ? findNodeBySelector(domNew, newSelector) : null;
          resolvedOnRef.set(targetRaw, resolvedNew ? toRegion(resolvedNew) : { ...region, domSelector: newSelector ?? '' });
        });
      }
    }

    // Tracks what each op actually did — an add's own region, or whatever removeSimilarRegion
    // actually found and removed (which can differ slightly from the search candidate itself);
    // a remove with nothing to remove has no entry, reported as `[]` below.
    const sourceAppliedRegions = new Map<RegionOp, Region[]>();

    // A clear op (-*, -<matchLevel>-*) is expanded into one synthetic 'remove' op per entry it
    // actually clears, as if the caller had explicitly targeted each one by its own rect — the
    // glob itself is never a real target for anything (search or output), only these concrete
    // per-region ops are. This is also what lets a clear op propagate below (see
    // propagatableOps): there's now a specific region per cleared entry to search for
    // elsewhere, exactly like any other remove op. Only categories a regionOp can actually
    // express get one (CATEGORY_TO_REGION_TYPE has no entry for
    // floating/remarks/mismatching/accessibility) — those are still cleared on the source
    // itself, just not represented here at all (no output entry, no propagation), since
    // there'd be no way to describe them as a regionOp.
    const clearSynthesizedOps: RegionOp[] = []; // flat list across every clear op, for propagatableOps below
    const clearSynthesizedByOp = new Map<RegionOp, RegionOp[]>(); // per clear op, for the source's own output ordering

    for (const op of regionOps) {
      if (isClearOp(op)) {
        const clearedEntries = op.regionType === 'all'
          ? entries.slice()
          : entries.filter(e => e.category === REGION_TYPE_TO_CATEGORY[op.regionType as RegionType]);

        if (op.regionType === 'all') {
          entries.length = 0;
        } else {
          const category = REGION_TYPE_TO_CATEGORY[op.regionType];
          for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].category === category) entries.splice(i, 1);
          }
        }

        const synthesizedForThisOp: RegionOp[] = [];
        for (const cleared of clearedEntries) {
          const regionType = op.regionType !== 'all' ? op.regionType : CATEGORY_TO_REGION_TYPE[cleared.category];
          if (!regionType) continue;
          const targetRaw = formatRect(cleared.region);
          const syntheticOp: RegionOp = { action: 'remove', regionType, targetRaw };
          synthesizedForThisOp.push(syntheticOp);
          clearSynthesizedOps.push(syntheticOp);
          resolvedOnRefBeforeConversion.set(targetRaw, cleared.region);
          sourceAppliedRegions.set(syntheticOp, [cleared.region]);
        }
        clearSynthesizedByOp.set(op, synthesizedForThisOp);
        continue;
      }
      const region = resolvedOnRef.get(op.targetRaw)!;
      const removed = removeSimilarRegion(entries, region); // an add replaces a similar existing region; a remove just drops it
      if (op.action === 'add') {
        entries.push({ category: REGION_TYPE_TO_CATEGORY[op.regionType as RegionType], region });
        sourceAppliedRegions.set(op, [region]);
      } else if (removed) {
        sourceAppliedRegions.set(op, [removed.region]);
      }
    }

    // A clear op is never itself reported — it's replaced, in place, by the concrete
    // synthesized remove op(s) that actually resulted from it (zero, if it had nothing to
    // clear). This matches how a propagated target reports it, and how the search treats it:
    // the glob string carries no useful information here since it isn't a specific region.
    const sourceAppliedRegionOps: AppliedRegionOp[] = [];
    for (const op of regionOps) {
      if (isClearOp(op)) {
        for (const syntheticOp of clearSynthesizedByOp.get(op) ?? []) {
          sourceAppliedRegionOps.push({ op: formatRegionOp(syntheticOp), result: sourceAppliedRegions.get(syntheticOp)! });
        }
        continue;
      }
      sourceAppliedRegionOps.push({ op: formatRegionOp(op), result: sourceAppliedRegions.get(op) ?? [] });
    }

    const sourceInfo = simplifySession(rawSession, { includeSteps: false });
    regionResults = [{
      sessionId, sessionName: sourceInfo.sessionName, environment: sourceInfo.environment,
      stepIndex, appliedRegionOps: sourceAppliedRegionOps,
    }];

    if (propagate) {
      // Every add/remove op is propagate-eligible, plus every synthetic remove op a clear op
      // expanded into above (one per entry it actually cleared) — a clear op itself has no
      // single region of its own to search for, but each entry it cleared does, and by this
      // point those have already been turned into ordinary remove ops. A resolved region
      // always has a rect, with or without a domSelector, and images/find can match on
      // rect/pixel content via computer vision when no domSelector is available (no source
      // DOM at all, or nothing anchored) — domSelector is a bonus signal on either side,
      // never a requirement.
      const propagatableOps = [...regionOps.filter(op => !isClearOp(op)), ...clearSynthesizedOps];

      if (propagatableOps.length > 0) {
        const sourceImage = imageForSide(rawSession, stepIndex, refSide);

        const rawBatchSessions = await deps.fetchRawBatchSessions({ baseUrl, batchId, accountId, apiKey: deps.apiKey });
        const candidates = resolvePropagateScope(
          rawBatchSessions.map(raw => ({ raw, sessionId: raw.id as string, sessionName: raw.scenarioName as string | undefined })),
          sessionId, rawSession.scenarioName, propagate,
        );

        // Each candidate's *own* current side (not necessarily refSide) is what a newly
        // found region should be searched against and stored on — images/find matches
        // regardless of which side each image is, so searching directly on the candidate's
        // own authoritative side skips a separate refSide→newSide conversion step entirely
        // (unlike the source session's regionOps, which start from ids/rects that must be
        // resolved against the side the caller explicitly declared). A target with no DOM at
        // all is still included — computer vision only needs its screenshot, not its DOM.
        const targetsByImageId = new Map<string, { raw: any; newSide: 'baseline' | 'checkpoint'; isSource?: boolean }>();
        const targets: any[] = [];

        // The source step's own current side is always included as a search target too — a
        // repeated component (e.g. the same toggle appearing in several rows) should have
        // every occurrence on this step found and applied, not just the literal id/rect the
        // caller named, exactly like a propagated candidate gets searched for every
        // occurrence on its own page rather than only the first.
        const sourceTargetImage = imageForSide(rawSession, stepIndex, newSide);
        if (sourceTargetImage?.id) {
          targetsByImageId.set(sourceTargetImage.id, { raw: rawSession, newSide, isSource: true });
          targets.push(sourceTargetImage);
        }

        for (const candidate of candidates) {
          const raw = candidate.raw;
          try {
            validateStepIndex(raw, stepIndex);
          } catch {
            continue; // candidate doesn't have this step at all — not in scope
          }
          const candidateNewSide = resolveDomIdSide('unchanged', raw, stepIndex);
          const image = imageForSide(raw, stepIndex, candidateNewSide);
          if (!image?.id) continue; // no image at all for this step — genuinely nothing to search
          targetsByImageId.set(image.id, { raw, newSide: candidateNewSide });
          targets.push(image);
        }

        if (targets.length > 0) {
          interface TargetAccumulator {
            raw: any;
            newSide: 'baseline' | 'checkpoint';
            entries: { category: AnnotationCategory; region: Region }[];
            appliedByOp: Map<string, AppliedRegionOp>;
          }
          const accumulators = new Map<string, TargetAccumulator>(); // keyed by target sessionId

          // One images/find call per op, each searching every in-scope target at once — not
          // one combined call across every op's region. A target's result array has no
          // positional correspondence to the input regions[], and a computer-vision-only
          // match carries no domSelector to disambiguate which op it came from when several
          // are searched together; scoping each call to a single op removes the ambiguity
          // entirely, at the cost of one extra round trip per op rather than per target.
          for (const op of propagatableOps) {
            const region = resolvedOnRefBeforeConversion.get(op.targetRaw)!;
            const found = await deps.findRegionsInImages(sourceImage, [region], targets, { baseUrl, accountId, apiKey: deps.apiKey });

            for (const [imageId, foundRegions] of Object.entries(found)) {
              if (foundRegions.length === 0) continue;
              const targetMeta = targetsByImageId.get(imageId);
              if (!targetMeta) continue;

              let acc = accumulators.get(targetMeta.raw.id);
              if (!acc) {
                // The source's own step already has its literal regionOps applied directly
                // onto `entries` above — reuse that same array (not a fresh snapshot) so any
                // further occurrences this search turns up land in the same working set
                // instead of duplicating or losing the literal changes already made.
                const entriesForAcc = targetMeta.isSource ? entries : getEffectiveRegions(targetMeta.raw, stepIndex).regions.map(({ category, baseline, checkpoint }) => ({
                  category, region: (targetMeta.newSide === 'baseline' ? baseline ?? checkpoint : checkpoint ?? baseline)!,
                }));
                acc = { raw: targetMeta.raw, newSide: targetMeta.newSide, entries: entriesForAcc, appliedByOp: new Map() };
                accumulators.set(targetMeta.raw.id, acc);
              }

              // For an add op, every new region from *this* op's results is deduped against
              // acc.entries (whatever's pre-existing, plus anything an earlier op in this same
              // loop already added) and collected into toAdd first, only pushed afterward —
              // not deduped-and-pushed one at a time. Two matches for the very same op
              // typically share the same domSelector (images/find's own result, confirmed
              // live) or, for a computer-vision-only match, both have an empty one — either
              // way, removeSimilarRegion's dedup would treat the second as "similar to" the
              // first and silently drop it if pushed immediately, collapsing a genuine
              // multi-match down to just the last one found. A remove op has no equivalent
              // risk — it only ever deletes an existing entry, never adds one a later match
              // could be mistaken for, so each found region is removed as soon as it's seen;
              // if two matches identify the very same existing entry, the second's lookup
              // correctly finds nothing left to remove.
              const toAdd: typeof acc.entries = [];
              const affected: Region[] = [];
              for (const foundRegion of foundRegions) {
                // domSelector may be '' here — a computer-vision-only match with no anchor —
                // same convention as any other unanchored region elsewhere in this file.
                const foundAsRegion: Region = {
                  domSelector: foundRegion.domSelector,
                  left: foundRegion.left, top: foundRegion.top, width: foundRegion.width, height: foundRegion.height,
                };
                // On the source's own step, this search inevitably re-finds the literal
                // region the op already applied above (it's searching, at least in part,
                // against itself) — skip anything that's just that same region again, so it
                // isn't double-reported on top of the already-recorded literal application.
                if (targetMeta.isSource && (sourceAppliedRegions.get(op) ?? []).some(
                  r => findSimilarExistingRegion([{ category: 'ignore', region: r }], foundAsRegion) !== null,
                )) continue;
                if (op.action === 'add') {
                  removeSimilarRegion(acc.entries, foundAsRegion); // an add still replaces a similar existing region first
                  toAdd.push({ category: REGION_TYPE_TO_CATEGORY[op.regionType as RegionType], region: foundAsRegion });
                  affected.push(foundAsRegion);
                } else {
                  // Only report something if there was actually a similar existing region
                  // there to remove — a found candidate with nothing to match against on this
                  // target didn't actually change anything.
                  const removed = removeSimilarRegion(acc.entries, foundAsRegion);
                  if (removed) affected.push(removed.region);
                }
              }
              acc.entries.push(...toAdd);

              if (affected.length > 0) {
                const opKey = formatRegionOp(op);
                if (!acc.appliedByOp.has(opKey)) acc.appliedByOp.set(opKey, { op: opKey, result: [] });
                acc.appliedByOp.get(opKey)!.result.push(...affected);
              }
            }
          }

          for (const acc of accumulators.values()) {
            if (acc.appliedByOp.size === 0) continue;

            // The source's own step is already represented by `regionResults[0]` (via
            // `entries`, `stepUpdate`, and `sourceAppliedRegionOps`, all handled below/above) —
            // rather than reporting it a second time as if it were a separate propagated
            // target, merge any further-occurrence results straight into that existing entry's
            // per-op result lists.
            if (acc.raw.id === sessionId) {
              for (const applied of acc.appliedByOp.values()) {
                const existing = sourceAppliedRegionOps.find(a => a.op === applied.op);
                if (existing) existing.result.push(...applied.result);
                else sourceAppliedRegionOps.push(applied);
              }
              continue;
            }

            extraUpdates.push({
              id: acc.raw.id, batchId,
              stepUpdates: [{ index: stepIndex, variantId: null, annotations: bucketRegions(acc.entries), removedAnnotations: emptyAnnotations() }],
            });
            const targetInfo = simplifySession(acc.raw, { includeSteps: false });
            regionResults.push({
              sessionId: acc.raw.id, sessionName: targetInfo.sessionName, environment: targetInfo.environment,
              stepIndex, appliedRegionOps: [...acc.appliedByOp.values()],
            });
          }
        }
      }
    }
  }

  // Live-confirmed against the real API: `annotations` is a full replacement of the
  // resolution's active regions, not a delta merged against whatever's already stored —
  // and `removedAnnotations` isn't used for removal at all (the real Test Manager UI sends
  // it as an empty skeleton even when deleting a region). So any call that touches regions —
  // via regionOps or a side-flip remap — must send back the complete desired region set,
  // not just what changed.
  if (regionOps.length > 0 || remapped) {
    stepUpdate.annotations = bucketRegions(entries);
    stepUpdate.removedAnnotations = emptyAnnotations();
  }

  // updates[] is confirmed live to accept multiple sessions in a single call — every
  // propagated session's stepUpdate rides along in the same POST as the source session's own.
  const apiUrl = `${baseUrl}/api/sessions/batches/${batchId}/updates?accountId=${accountId}&apiKey=${encodeURIComponent(deps.apiKey)}`;
  const response = await deps.postJson(apiUrl, { updates: [{ id: sessionId, batchId, stepUpdates: [stepUpdate] }, ...extraUpdates] });
  await deps.getJsonResult(response, deps.apiKey);

  if (isRegionsAction) {
    return regionResults!;
  }
  return { status: action === 'accept' ? 'accepted' : 'rejected', stepIndex, sessionId, batchId };
}

// ---------------------------------------------------------------------------
// saveBaselinesFlow
// ---------------------------------------------------------------------------

export interface SaveBaselinesDeps {
  parseSessionUrl: (url: string) => ParsedSessionUrl;
  postJson: (url: string, body: unknown) => Promise<Response>;
  getJsonResult: (response: Response, apiKey: string) => Promise<any>;
  apiKey: string;
}

export interface SaveBaselinesResult {
  status: 'saved';
  batchId: string;
}

export async function saveBaselinesFlow(url: string, deps: SaveBaselinesDeps): Promise<SaveBaselinesResult> {
  const { baseUrl, batchId, accountId } = deps.parseSessionUrl(url);
  const apiUrl = `${baseUrl}/api/sessions/batches/${batchId}/baselines?accountId=${accountId}&apiKey=${encodeURIComponent(deps.apiKey)}`;

  const response = await deps.postJson(apiUrl, undefined);
  await deps.getJsonResult(response, deps.apiKey);

  return { status: 'saved', batchId };
}

// ---------------------------------------------------------------------------
// resetBaselinesFlow
// ---------------------------------------------------------------------------

export interface ResetBaselinesDeps {
  parseApplitoolsUrl: (url: string) => ParsedUrl;
  fetchRawSession: (options: RawSessionOptions) => Promise<any>;
  fetchRawBatchSessions: (options: RawBatchSessionsOptions) => Promise<any[]>;
  postJson: (url: string, body: unknown) => Promise<Response>;
  getJsonResult: (response: Response, apiKey: string) => Promise<any>;
  apiKey: string;
}

/** A session whose baseline was reverted to the revision it originally ran against. */
export interface RestoredSessionInfo {
  id: string;
  scenarioName: string | undefined;
  baselineId: string;
  baselineRev: string;
}

export interface ResetBaselinesResult {
  status: 'reset';
  batchId: string;
  count: number;
  sessions: RestoredSessionInfo[];
  /** Ids of every session whose pending resolution (accept/reject/region changes, isChanged flags) was actually cleared. */
  resolutionsCleared: string[];
}

/**
 * Reverting the shared baseline object and clearing a session's own pending resolution are
 * two independent server-side operations — restoring the baseline leaves `appOutputResolution`
 * and the per-step `resolution`/`isUnsaved` completely untouched. The batch-wide reset
 * endpoint (`POST /api/sessions/batches/{batchId}/reset`, body `{ ids }`) is the only thing
 * that actually clears that state, and it's harmless — a no-op, not an error — when a session
 * has nothing pending, so it's called for every session in scope rather than needing its own
 * "is this one actually modified" gate.
 */
export async function resetBaselinesFlow(url: string, deps: ResetBaselinesDeps): Promise<ResetBaselinesResult> {
  const { baseUrl, batchId, sessionId, accountId } = deps.parseApplitoolsUrl(url);

  const sessions: any[] = sessionId
    ? [await deps.fetchRawSession({ baseUrl, batchId, sessionId, accountId, apiKey: deps.apiKey })]
    : await deps.fetchRawBatchSessions({ baseUrl, batchId, accountId, apiKey: deps.apiKey });

  // A session that was never saved never moved the shared baseline away from its original
  // revision, so there's nothing to restore there — only ever call the baseline-restore
  // endpoint for one that actually was.
  const savedSessions = sessions.filter(s => s.savedTo != null);
  const sessionsWithPendingChanges = sessions.filter(hasUnsavedChanges);

  await Promise.all(savedSessions.map(async (s) => {
    const baselineRestoreUrl = `${baseUrl}/api/baselines/${s.baselineId}/${s.baselineRev}/restore?accountId=${accountId}&apiKey=${encodeURIComponent(deps.apiKey)}`;
    const response = await deps.postJson(baselineRestoreUrl, undefined);
    await deps.getJsonResult(response, deps.apiKey);
  }));

  if (sessions.length > 0) {
    const resetUrl = `${baseUrl}/api/sessions/batches/${batchId}/reset?accountId=${accountId}&apiKey=${encodeURIComponent(deps.apiKey)}`;
    const response = await deps.postJson(resetUrl, { ids: sessions.map(s => s.id) });
    await deps.getJsonResult(response, deps.apiKey);
  }

  return {
    status: 'reset',
    batchId,
    count: savedSessions.length,
    sessions: savedSessions.map(s => ({ id: s.id, scenarioName: s.startInfo?.scenarioName, baselineId: s.baselineId, baselineRev: s.baselineRev })),
    resolutionsCleared: sessionsWithPendingChanges.map(s => s.id),
  };
}
