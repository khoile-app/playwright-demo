#!/usr/bin/env npx tsx

import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { type Rect, type DiffArea, parseRect, formatRect, rectsIntersect, unifyRects, diffAreas, condenseDiffAreasDetailed } from 'geometry';
import { cacheFilePath, defaultFsCacheDeps, fetchDomArea, fetchDomSnapshot, getCompatibleSelectors, getJson, parseSessionUrl, parseBatchUrl, fetchSession, fetchRawBatchSessions, fetchRawSession, fetchBatchInfo } from 'api';
import { validateDomId, computeDomDiff } from 'sessions/dom';
import { searchDom } from 'sessions/dom-search';
import { getEffectiveRegions, checkRegions, mapAnchoredRegionsBySelector, fillMissingSideWithPlainRect, fillMissingBaselineForCodedRegions, resolveDomIdSide, validateStepIndex } from 'sessions';
import { simplifySession } from 'sessions/session';
import { toBatchStats, filterSessions, type BatchFilter } from 'sessions/batch';
import { parseBatchArgs, formatBatchOutput, type BatchFormat } from './batch-view.js';
import { parseHistoryArgs, runHistory } from './history.js';

let dir = process.cwd();
while (true) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) { dotenv.config({ path: envPath }); break; }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const command = process.argv[2];

const SUPPORTED_COMMANDS = ['batch', 'steps', 'diffs', 'changed-areas', 'diff-image', 'screenshot', 'dom', 'dom-diff', 'dom-search', 'regions', 'session', 'history'];

if (command === 'dom-search') {
  const filePath = process.argv[3];
  const predicateSource = process.argv[4];
  if (!filePath || !predicateSource) {
    console.error('Usage: main.ts dom-search <filePath> <predicate>');
    process.exit(1);
  }
  try {
    console.log(searchDom(fs.readFileSync(filePath, 'utf8'), predicateSource));
  } catch (error) {
    console.error('Error running dom-search:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

const sessionUrl = process.argv[3];

if (!command || !sessionUrl) {
  console.error('Usage: main.ts <command> <sessionUrl> [args]');
  console.error(`Supported commands: ${SUPPORTED_COMMANDS.join(', ')}`);
  process.exit(1);
}

if (!SUPPORTED_COMMANDS.includes(command)) {
  console.error(`Unknown command: ${command}`);
  console.error(`Supported commands: ${SUPPORTED_COMMANDS.join(', ')}`);
  process.exit(1);
}

const apiKey = process.env.APPLITOOLS_READ_KEY;
if (!apiKey) {
  const accountIdMatch = sessionUrl?.match(/accountId=([^&]+)/);
  const apiKeysUrl = `https://eyes.applitools.com/app/admin/api-keys${accountIdMatch ? `?accountId=${accountIdMatch[1]}` : ''}`;
  console.error(
    'Error: APPLITOOLS_READ_KEY is not set.\n\n' +
    'How to get your read-only API key:\n' +
    `1. Go to the Applitools API Keys page: ${apiKeysUrl}\n` +
    '2. Create or copy a read-only API key\n' +
    '3. Set it via .env or environment variable:\n' +
    '   APPLITOOLS_READ_KEY=your_read_only_key_here\n\n' +
    'Note: APPLITOOLS_API_KEY (for test execution) is different from APPLITOOLS_READ_KEY.\n' +
    'This skill requires read-only permissions to query session data.'
  );
  process.exit(1);
}

async function fetchBatch(url: string, apiKey: string, rawArgs: string[]): Promise<void> {
  let filter: BatchFilter | undefined;
  let format: BatchFormat = 'full';
  try {
    ({ filter, format } = parseBatchArgs(rawArgs));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const { baseUrl, batchId, accountId } = parseBatchUrl(url);

  try {
    // No filter + stats format is the one case that never needs the session list at all —
    // read the batch's own server-maintained aggregate directly, rather than computing it
    // from sessions. This decision (whether to fetch sessions at all) lives here rather than
    // in `formatBatchOutput`, since it's about the network call, not the output shape.
    if (!filter && format === 'stats') {
      const stats = toBatchStats(await fetchBatchInfo({ baseUrl, batchId, accountId, apiKey }));
      console.log(JSON.stringify({ stats }, null, 2));
      return;
    }

    const rawSessions = await fetchRawBatchSessions({ baseUrl, batchId, accountId, apiKey });
    const simplified = rawSessions.map(raw => simplifySession(raw));
    const included = filterSessions(simplified, filter);
    console.log(JSON.stringify(formatBatchOutput(included, format), null, 2));
  } catch (error) {
    console.error('Error fetching batch:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Internal/undocumented — returns the raw, unshaped session API response. Used for
// investigating server-side encodings (e.g. match-region representation) rather than
// as a stable, documented user-facing command.
async function printRawSession(url: string, apiKey: string): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  try {
    const rawSession = await fetchRawSession({ baseUrl, batchId, sessionId, accountId, apiKey });
    console.log(JSON.stringify(rawSession, null, 2));
  } catch (error) {
    console.error('Error fetching session:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Resolves a step's domId for the requested side straight off an already-fetched raw
 * session, then fetches the full, unpruned DOM snapshot for it.
 */
async function fetchDomForSide(rawSession: any, stepIndex: number, side: 'baseline' | 'checkpoint', baseUrl: string): Promise<any> {
  const domId = side === 'baseline'
    ? rawSession?.expectedAppOutput?.[stepIndex]?.image?.domId
    : rawSession?.actualAppOutput?.[stepIndex]?.image?.domId;
  const error = validateDomId(domId);
  if (error) throw new Error(error);
  return fetchDomSnapshot({ baseUrl, domId: domId!, apiKey: apiKey! });
}

/**
 * Prints a step's regions and codedRegions (see `getEffectiveRegions`), mapping every
 * `regions` pair so both sides are always present in the output. An already
 * domSelector-anchored region is mapped to its missing side via get-compatible-selectors
 * (`checkRegions` + `mapAnchoredRegionsBySelector`, from `sessions`) — but deliberately
 * without either healing step (no rect-based recovery for a non-anchored region, no clearing
 * of a stale domSelector), so a region that's actually broken stays visibly broken rather
 * than being fixed out from under this diagnostic. Anything that comes out of that mapping
 * step still missing a side — never anchored, stale, or mapped to nothing — gets a plain,
 * unanchored copy of its known side instead (`fillMissingSideWithPlainRect`): same rect, no
 * domSelector. So a `domSelector` present on one side but not the other in the final output
 * always means something real — a stale selector, or a target genuinely missing on that
 * side — never merely "we didn't look." `codedRegions` gets the analogous treatment for its
 * always-optional `baseline` side (`fillMissingBaselineForCodedRegions`) — `checkpoint` is
 * never missing there to begin with. Read-only: get-compatible-selectors only needs a
 * read-capable API key.
 *
 * If `area` is given, the final result is filtered to pairs where either side's rect
 * intersects it — applied last, after every side is filled in, so the filter sees the same
 * complete pairs the caller would.
 */
async function printRegions(url: string, stepIndex: number, apiKey: string, area?: Rect): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  try {
    const rawSession = await fetchRawSession({ baseUrl, batchId, sessionId, accountId, apiKey });
    validateStepIndex(rawSession, stepIndex);
    const { regions, codedRegions } = getEffectiveRegions(rawSession, stepIndex);

    const sourceSide = resolveDomIdSide('unchanged', rawSession, stepIndex);
    const domSource = await fetchDomForSide(rawSession, stepIndex, sourceSide, baseUrl).catch(() => null);
    const { anchored } = checkRegions(regions, domSource);
    await mapAnchoredRegionsBySelector(rawSession, stepIndex, anchored, {
      baseUrl, accountId, apiKey,
      fetchDomForSide,
      getCompatibleSelectors,
    });
    fillMissingSideWithPlainRect(regions);
    fillMissingBaselineForCodedRegions(codedRegions);

    const intersectsArea = (pair: { baseline?: Rect; checkpoint?: Rect }) =>
      !area || (pair.baseline && rectsIntersect(pair.baseline, area)) || (pair.checkpoint && rectsIntersect(pair.checkpoint, area));
    const filteredRegions = regions.filter(intersectsArea);
    const filteredCodedRegions = codedRegions.filter(intersectsArea);

    console.log(JSON.stringify({ regions: filteredRegions, codedRegions: filteredCodedRegions }, null, 2));
  } catch (error) {
    console.error('Error fetching regions:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function printSteps(url: string, apiKey: string): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  try {
    const simplified = await fetchSession({ baseUrl, batchId, sessionId, accountId, apiKey });

    // Fail if session is still running
    if (simplified.status === 'Running') {
      console.error('Session is still running. Please try again later.');
      process.exit(1);
    }

    console.log(JSON.stringify(simplified, null, 2));
  } catch (error) {
    console.error('Error fetching session:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}




async function fetchRawDiffs(url: string, stepIndex: number, apiKey: string, filter?: Rect): Promise<Rect[]> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);
  const fullUrl = `${baseUrl}/api/sessions/batches/${batchId}/${sessionId}/${stepIndex}/diff?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;
  const data = await getJson(fullUrl);
  const combined: Rect[] = [...(data.image1 ?? []), ...(data.image2 ?? [])];
  const filtered = filter ? combined.filter(r => rectsIntersect(r, filter)) : combined;
  return filter ? filtered.map(r => ({ ...r, left: r.left - filter.left, top: r.top - filter.top })) : filtered;
}

async function fetchStepDiff(url: string, stepIndex: number, apiKey: string, filter?: Rect): Promise<void> {
  try {
    const rects = await fetchRawDiffs(url, stepIndex, apiKey, filter);
    console.log(JSON.stringify(unifyRects(rects), null, 2));
  } catch (error) {
    console.error('Error fetching diff:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function fetchChangedAreas(url: string, stepIndex: number, apiKey: string, filter?: Rect, debug = false): Promise<void> {
  try {
    const rects = await fetchRawDiffs(url, stepIndex, apiKey, filter);
    const areas = diffAreas(rects, 100, 25);
    const { containers, individuals } = condenseDiffAreasDetailed(areas);
    console.log(JSON.stringify([...containers, ...individuals], null, 2));
    if (debug) {
      const imagePath = await generateChangedAreasDebugImage(url, stepIndex, apiKey, filter, containers, individuals);
      console.log(imagePath);
    }
  } catch (error) {
    console.error('Error fetching diff:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function generateChangedAreasDebugImage(
  url: string,
  stepIndex: number,
  apiKey: string,
  filter: Rect | undefined,
  containers: DiffArea[],
  individuals: DiffArea[],
): Promise<string> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);
  const apiStepIndex = stepIndex + 1;

  const areasHash = crypto.createHash('sha1').update(JSON.stringify({ containers, individuals })).digest('hex').slice(0, 16);
  const filePath = cacheFilePath(defaultFsCacheDeps, 'eyes-changed-areas-debug', areasHash, 'png');

  if (fs.existsSync(filePath)) return filePath;

  const checkpointPath = filter
    ? `/api/sessions/batches/${batchId}/${sessionId}/steps/${apiStepIndex}/images/checkpoint.clip(${filter.left};${filter.top};${filter.width};${filter.height})`
    : `/api/sessions/batches/${batchId}/${sessionId}/steps/${apiStepIndex}/images/checkpoint`;
  const checkpointUrl = `${baseUrl}${checkpointPath}?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;

  const response = await fetch(checkpointUrl);
  if (!response.ok) throw new Error(`Failed to fetch checkpoint: ${response.status} ${response.statusText}`);
  const checkpointBuffer = Buffer.from(await response.arrayBuffer());

  const { width, height } = await sharp(checkpointBuffer).metadata();
  if (!width || !height) throw new Error('Failed to read checkpoint dimensions');

  function svgRect(r: Rect, color: string, fillOpacity: number, strokeWidth: number): string {
    return `<rect x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-width="${strokeWidth}" stroke-opacity="0.9"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + containers.map(r => svgRect(r, 'blue', 0.08, 3)).join('')
    + individuals.map(r => svgRect(r, 'red', 0.15, 2)).join('')
    + `</svg>`;

  await sharp(checkpointBuffer)
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .toFile(filePath);

  return filePath;
}

async function fetchDiffImage(url: string, stepIndex: number, apiKey: string, area?: Rect): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  // images/checkpoint uses 1-based step index (matches UI URL /steps/N convention)
  const apiStepIndex = stepIndex + 1;

  const areaKey = area ? formatRect(area) : '';
  const hash = crypto.createHash('sha1')
    .update(`diff-image:${accountId}:${batchId}:${sessionId}:${apiStepIndex}:${areaKey}`)
    .digest('hex')
    .slice(0, 16);
  const filePath = cacheFilePath(defaultFsCacheDeps, 'eyes', hash, 'png');

  if (fs.existsSync(filePath)) {
    console.log(filePath);
    return;
  }

  try {
    // Fetch checkpoint image (optionally cropped)
    const checkpointPath = area
      ? `/api/sessions/batches/${batchId}/${sessionId}/steps/${apiStepIndex}/images/checkpoint.clip(${area.left};${area.top};${area.width};${area.height})`
      : `/api/sessions/batches/${batchId}/${sessionId}/steps/${apiStepIndex}/images/checkpoint`;
    const checkpointUrl = `${baseUrl}${checkpointPath}?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;
    const checkpointResponse = await fetch(checkpointUrl);
    if (!checkpointResponse.ok) {
      console.error(`Failed to fetch checkpoint image: ${checkpointResponse.status} ${checkpointResponse.statusText}`);
      process.exit(1);
    }
    const checkpointBuffer = Buffer.from(await checkpointResponse.arrayBuffer());

    // Fetch diff rectangles (same endpoint as 'diffs' command, 0-based index)
    const diffUrl = `${baseUrl}/api/sessions/batches/${batchId}/${sessionId}/${stepIndex}/diff?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;
    const diffData = await getJson(diffUrl);
    const rects: Rect[] = [...(diffData.image1 ?? []), ...(diffData.image2 ?? [])];

    // Get image dimensions and raw RGBA pixel data
    const image = sharp(checkpointBuffer);
    const { width, height } = await image.metadata();
    if (!width || !height) {
      console.error('Failed to read checkpoint image dimensions');
      process.exit(1);
    }
    const rawData = await image.ensureAlpha().raw().toBuffer();

    // Draw inflated diff rects in pink (magenta) at 25% opacity.
    // Diff rects are in full-image coordinates; translate by crop origin if area was applied.
    const originX = area ? area.left : 0;
    const originY = area ? area.top  : 0;
    for (const rect of rects) {
      const w = Math.max(rect.width, 10);
      const h = Math.max(rect.height, 10);
      const left  = Math.max(0, (rect.left - originX) - Math.floor((w - rect.width) / 2));
      const top   = Math.max(0, (rect.top  - originY) - Math.floor((h - rect.height) / 2));
      const right  = Math.min(width,  left + w);
      const bottom = Math.min(height, top  + h);

      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = (y * width + x) * 4;
          rawData[i]     = Math.round(rawData[i]     * 0.75 + 63.75); // R: blend toward 255
          rawData[i + 1] = Math.round(rawData[i + 1] * 0.75);        // G: blend toward 0
          rawData[i + 2] = Math.round(rawData[i + 2] * 0.75 + 63.75); // B: blend toward 255
          // A: unchanged
        }
      }
    }

    // Encode and save
    const resultBuffer = await sharp(rawData, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    fs.writeFileSync(filePath, resultBuffer);
    console.log(filePath);
  } catch (error) {
    console.error('Error generating diff image:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function fetchImage(baseUrl: string, imageId: string, apiKey: string, area?: Rect): Promise<void> {
  const areaStr = area ? `_${area.left}_${area.top}_${area.width}_${area.height}` : '';
  const filePath = cacheFilePath(defaultFsCacheDeps, 'eyes', `${imageId}${areaStr}`, 'png');

  if (fs.existsSync(filePath)) {
    console.log(filePath);
    return;
  }

  let imagePath = `/api/images/${imageId}`;
  if (area) {
    imagePath += `.clip(${area.left};${area.top};${area.width};${area.height})`;
  }
  const fullUrl = `${baseUrl}${imagePath}?apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(fullUrl);
    if (!response.ok) {
      console.error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    console.log(filePath);
  } catch (error) {
    console.error('Error fetching image:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runDomCommand(baseUrl: string, domId: string, apiKey: string, area?: Rect): Promise<void> {
  try {
    const output = await fetchDomArea({ baseUrl, domId, apiKey }, area);
    const areaStr = area ? `_${area.left}_${area.top}_${area.width}_${area.height}` : '';
    const filePath = cacheFilePath(defaultFsCacheDeps, 'eyes', `${domId}${areaStr}`, 'json');
    fs.writeFileSync(filePath, JSON.stringify(output));
    console.log(filePath);
  } catch (error) {
    console.error('Error fetching DOM:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function fetchDomDiff(url: string, stepIndex: number, apiKey: string, area?: Rect): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  let session: Awaited<ReturnType<typeof fetchSession>>;
  try {
    session = await fetchSession({ baseUrl, batchId, sessionId, accountId, apiKey });
  } catch (error) {
    console.error('Error fetching session:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const step = session.steps[stepIndex];
  if (!step) {
    console.error(`Step index ${stepIndex} is out of range (session has ${session.steps.length} steps)`);
    process.exit(1);
  }
  if (!step.baseline.domId) {
    console.error('This step has no baseline DOM capture');
    process.exit(1);
  }
  if (!step.checkpoint.domId) {
    console.error('This step has no checkpoint DOM capture');
    process.exit(1);
  }

  try {
    // Always diff the full, unrestricted trees — matching/diffing needs full-tree context
    // to align nodes correctly. `area`, if given, only filters the resulting diff entries
    // (see `filterDiffToArea` in dom.ts); it must never prune the trees before diffing.
    const [baselineRoot, checkpointRoot] = await Promise.all([
      fetchDomArea({ baseUrl, domId: step.baseline.domId, apiKey }),
      fetchDomArea({ baseUrl, domId: step.checkpoint.domId, apiKey }),
    ]);

    const result = computeDomDiff(baselineRoot, checkpointRoot, area);
    console.log(result);
  } catch (error) {
    console.error('Error computing DOM diff:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function parseStepArgs(command: string): { stepIndex: number; filter?: Rect; debug: boolean } {
  const stepArg = process.argv[4];
  if (stepArg === undefined) {
    console.error(`Usage: main.ts ${command} <sessionUrl> <stepIndex> [rect] [--debug]`);
    console.error('stepIndex is the zero-based index of the step from the "steps" command');
    process.exit(1);
  }
  const stepIndex = parseInt(stepArg, 10);
  if (isNaN(stepIndex) || stepIndex < 0) {
    console.error(`Invalid step index: ${stepArg}`);
    process.exit(1);
  }
  let filter: Rect | undefined;
  let debug = false;
  for (let i = 5; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--debug') {
      debug = true;
    } else if (!filter) {
      try {
        filter = parseRect(arg);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }
  }
  return { stepIndex, filter, debug };
}

if (command === 'batch') {
  fetchBatch(sessionUrl, apiKey, process.argv.slice(4));
} else if (command === 'steps') {
  printSteps(sessionUrl, apiKey);
} else if (command === 'diffs') {
  const { stepIndex, filter } = parseStepArgs(command);
  fetchStepDiff(sessionUrl, stepIndex, apiKey, filter);
} else if (command === 'changed-areas') {
  const { stepIndex, filter, debug } = parseStepArgs(command);
  fetchChangedAreas(sessionUrl, stepIndex, apiKey, filter, debug);
} else if (command === 'diff-image') {
  const { stepIndex, filter } = parseStepArgs(command);
  fetchDiffImage(sessionUrl, stepIndex, apiKey, filter);
} else if (command === 'screenshot') {
  const imageId = process.argv[4];
  if (!imageId) {
    console.error('Usage: main.ts screenshot <sessionUrl> <imageId> [rect]');
    process.exit(1);
  }
  const areaArg = process.argv[5];
  let area: Rect | undefined;
  if (areaArg) {
    try {
      area = parseRect(areaArg);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  const { baseUrl } = parseSessionUrl(sessionUrl);
  fetchImage(baseUrl, imageId, apiKey, area);
} else if (command === 'dom') {
  const domId = process.argv[4];
  if (!domId) {
    console.error('Usage: main.ts dom <sessionUrl> <domId> [rect]');
    process.exit(1);
  }
  const domIdError = validateDomId(domId);
  if (domIdError) {
    console.error(domIdError);
    process.exit(1);
  }
  const areaArg = process.argv[5];
  let area: Rect | undefined;
  if (areaArg) {
    try {
      area = parseRect(areaArg);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  const { baseUrl } = parseSessionUrl(sessionUrl);
  runDomCommand(baseUrl, domId, apiKey, area);
} else if (command === 'dom-diff') {
  const { stepIndex, filter } = parseStepArgs(command);
  fetchDomDiff(sessionUrl, stepIndex, apiKey, filter);
} else if (command === 'regions') {
  const { stepIndex, filter } = parseStepArgs(command);
  printRegions(sessionUrl, stepIndex, apiKey, filter);
} else if (command === 'session') {
  printRawSession(sessionUrl, apiKey);
} else if (command === 'history') {
  let stepIndex: number, nodeIds: string[], count: number;
  try {
    ({ stepIndex, nodeIds, count } = parseHistoryArgs(process.argv.slice(4)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  runHistory(sessionUrl, stepIndex, nodeIds, count, apiKey);
}
