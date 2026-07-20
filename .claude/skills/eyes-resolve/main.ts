#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { parseApplitoolsUrl, parseSessionUrl, fetchRawSession, fetchRawBatchSessions, fetchDomSnapshot, getCompatibleSelectors, findRegionsInImages, postJson, getJsonResult } from 'api';
import { validateDomId } from 'sessions/dom';
import { parseRegionOp, parsePropagateArg, type RegionOp, type PropagateSpec } from './region-op.js';
import { resolveStepFlow, saveBaselinesFlow, resetBaselinesFlow, type ResolveAction } from './resolve-flows.js';

let dir = process.cwd();
while (true) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) { dotenv.config({ path: envPath }); break; }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const command = process.argv[2];
const sessionUrl = process.argv[3];

const SUPPORTED_COMMANDS = ['accept', 'reject', 'baseline-regions', 'checkpoint-regions', 'save', 'reset'];

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

const apiKey = process.env.APPLITOOLS_WRITE_KEY;
if (!apiKey) {
  const accountIdMatch = sessionUrl?.match(/accountId=([^&]+)/);
  const apiKeysUrl = `https://eyes.applitools.com/app/admin/api-keys${accountIdMatch ? `?accountId=${accountIdMatch[1]}` : ''}`;
  console.error(
    'Error: APPLITOOLS_WRITE_KEY is not set.\n\n' +
    'How to get your API key:\n' +
    `1. Go to the Applitools API Keys page: ${apiKeysUrl}\n` +
    '2. Create or copy an API key\n' +
    '3. Set it via .env or environment variable:\n' +
    '   APPLITOOLS_WRITE_KEY=your_api_key_here'
  );
  process.exit(1);
}

/**
 * Resolves a step's domId for the requested side straight off an already-fetched raw
 * session, then fetches the full, unpruned DOM snapshot for it. The one genuinely new
 * piece of real-effect logic this feature needs — small enough that it lives here rather
 * than in its own file (`dom`'s `resolveNodeIdsToNodes`, which walks the tree this
 * returns, is pure and has no fetching of its own).
 */
async function fetchDomForSide(rawSession: any, stepIndex: number, side: 'baseline' | 'checkpoint', baseUrl: string): Promise<any> {
  const domId = side === 'baseline'
    ? rawSession?.expectedAppOutput?.[stepIndex]?.image?.domId
    : rawSession?.actualAppOutput?.[stepIndex]?.image?.domId;
  const error = validateDomId(domId);
  if (error) throw new Error(error);
  return fetchDomSnapshot({ baseUrl, domId: domId!, apiKey: apiKey! });
}

if (command === 'accept' || command === 'reject') {
  const stepArg = process.argv[4];
  if (stepArg === undefined) {
    console.error(`Usage: main.ts ${command} <sessionUrl> <stepIndex>`);
    console.error('stepIndex is the zero-based index of the step from the "steps" command');
    process.exit(1);
  }
  const stepIndex = parseInt(stepArg, 10);
  if (isNaN(stepIndex) || stepIndex < 0) {
    console.error(`Invalid step index: ${stepArg}`);
    process.exit(1);
  }

  if (process.argv.length > 5) {
    console.error(`Usage: main.ts ${command} <sessionUrl> <stepIndex>`);
    console.error(`Unexpected argument(s): ${process.argv.slice(5).join(' ')}`);
    process.exit(1);
  }

  resolveStepFlow(sessionUrl, stepIndex, command as ResolveAction, [], {
    parseSessionUrl,
    fetchRawSession,
    fetchRawBatchSessions,
    fetchDomForSide,
    getCompatibleSelectors,
    findRegionsInImages,
    postJson,
    getJsonResult,
    apiKey,
  }).then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error(`Error resolving step: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
} else if (command === 'baseline-regions' || command === 'checkpoint-regions') {
  const stepArg = process.argv[4];
  if (stepArg === undefined) {
    console.error(`Usage: main.ts ${command} <sessionUrl> <stepIndex> <regionOp...> [propagate[=<regex>]]`);
    console.error('stepIndex is the zero-based index of the step from the "steps" command');
    process.exit(1);
  }
  const stepIndex = parseInt(stepArg, 10);
  if (isNaN(stepIndex) || stepIndex < 0) {
    console.error(`Invalid step index: ${stepArg}`);
    process.exit(1);
  }

  // A trailing `propagate`/`propagate=<regex>` argument isn't a regionOp — peel it off
  // before parsing the rest, rather than requiring it to precede every regionOp.
  const rawArgs = process.argv.slice(5);
  let propagate: PropagateSpec | null = null;
  const lastArg = rawArgs[rawArgs.length - 1];
  if (lastArg !== undefined && (lastArg === 'propagate' || lastArg.startsWith('propagate='))) {
    try {
      propagate = parsePropagateArg(lastArg);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    rawArgs.pop();
  }

  let regionOps: RegionOp[];
  try {
    regionOps = rawArgs.map(parseRegionOp);
  } catch (error) {
    console.error(`Error parsing regionOp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (regionOps.length === 0) {
    console.error(`Usage: main.ts ${command} <sessionUrl> <stepIndex> <regionOp...> [propagate[=<regex>]]`);
    console.error(`'${command}' requires at least one regionOp — nothing to do otherwise`);
    process.exit(1);
  }

  resolveStepFlow(sessionUrl, stepIndex, command as ResolveAction, regionOps, {
    parseSessionUrl,
    fetchRawSession,
    fetchRawBatchSessions,
    fetchDomForSide,
    getCompatibleSelectors,
    findRegionsInImages,
    postJson,
    getJsonResult,
    apiKey,
  }, propagate).then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error(`Error resolving step: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
} else if (command === 'save') {
  saveBaselinesFlow(sessionUrl, { parseSessionUrl, postJson, getJsonResult, apiKey })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(`Error saving baselines: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
} else if (command === 'reset') {
  resetBaselinesFlow(sessionUrl, { parseApplitoolsUrl, fetchRawSession, fetchRawBatchSessions, postJson, getJsonResult, apiKey })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(`Error resetting baselines: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
