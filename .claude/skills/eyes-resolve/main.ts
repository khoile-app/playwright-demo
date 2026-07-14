#!/usr/bin/env npx tsx

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

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

const SUPPORTED_COMMANDS = ['accept', 'reject', 'save', 'restore'];

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

interface ParsedSessionUrl {
  baseUrl: string;
  batchId: string;
  sessionId: string;
  accountId: string;
}

interface ParsedUrl {
  baseUrl: string;
  batchId: string;
  sessionId: string | null;
  accountId: string;
}

function normalizeEyesUrl(url: string): string {
  return url.replace(/\/app\/batches\/([^/?]+)(?:\/([^/?]+))?/, (_match, batchId: string, sessionId?: string) => {
    return `/app/test-results/${batchId}${sessionId ? `/${sessionId}` : ''}`;
  });
}

function parseSessionUrl(url: string): ParsedSessionUrl {
  const normalizedUrl = normalizeEyesUrl(url);
  const { sessionId, ...rest } = parseSessionOrBatchUrl(normalizedUrl);
  if (!sessionId) throw new Error(`Invalid session URL format: "${url}"`);
  return { ...rest, sessionId };
}

function parseSessionOrBatchUrl(url: string): ParsedUrl {
  const normalizedUrl = normalizeEyesUrl(url);
  const urlMatch = normalizedUrl.match(/^(https?:\/\/[^/]+)/);
  if (!urlMatch) throw new Error(`Invalid URL format: "${url}"`);

  const batchMatch = normalizedUrl.match(/\/app\/test-results\/([^/?]+)/);
  if (!batchMatch) throw new Error(`Invalid URL format: "${url}"`);

  const accountIdMatch = normalizedUrl.match(/accountId=([^&]+)/);
  if (!accountIdMatch) throw new Error(`Missing accountId in URL: "${url}"`);

  const sessionMatch = normalizedUrl.match(/\/app\/test-results\/[^/?]+\/([^/?]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;

  return { baseUrl: urlMatch[1], batchId: batchMatch[1], sessionId, accountId: accountIdMatch[1] };
}

async function getResponseResult(response: Response, apiKey: string): Promise<void> {
  if (response.status === 202) {
    const location = response.headers.get('Location');
    if (location) {
      await pollUntilDone(location, apiKey);
    }
  } else if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
  }
}

async function pollUntilDone(statusUrl: string, apiKey: string): Promise<void> {
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    const sep = statusUrl.includes('?') ? '&' : '?';
    const response = await fetch(`${statusUrl}${sep}apiKey=${encodeURIComponent(apiKey)}`);

    if (response.status === 200) {
      // Still running — wait and retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    if (response.status === 201) {
      // Done — result is at the Location header (204 No Content, nothing to parse)
      return;
    }

    throw new Error(`Unexpected poll status: ${response.status} ${response.statusText}`);
  }

  throw new Error('Polling timed out after 60 attempts');
}

async function resolveStep(url: string, stepIndex: number, accept: boolean, apiKey: string): Promise<void> {
  const { baseUrl, batchId, sessionId, accountId } = parseSessionUrl(url);

  const apiUrl = `${baseUrl}/api/sessions/batches/${batchId}/updates?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;
  const body = {
    updates: [{
      id: sessionId,
      batchId,
      stepUpdates: [{ index: stepIndex, variantId: null, replaceExpected: accept }],
    }],
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    await getResponseResult(response, apiKey);

    console.log(JSON.stringify({ status: accept ? 'accepted' : 'rejected', stepIndex, sessionId, batchId }));
  } catch (error) {
    console.error(`Error resolving step: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function saveBaselines(url: string, apiKey: string): Promise<void> {
  const { baseUrl, batchId, accountId } = parseSessionUrl(url);

  const apiUrl = `${baseUrl}/api/sessions/batches/${batchId}/baselines?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(apiUrl, { method: 'POST' });

    await getResponseResult(response, apiKey);

    console.log(JSON.stringify({ status: 'saved', batchId }));
  } catch (error) {
    console.error(`Error saving baselines: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function restoreBaselines(url: string, apiKey: string): Promise<void> {
  try {
    const { baseUrl, batchId, sessionId, accountId } = parseSessionOrBatchUrl(url);
    let sessions: any[];

    if (sessionId) {
      const r = await fetch(`${baseUrl}/api/sessions/batches/${batchId}/${sessionId}?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to fetch session: ${r.status} ${r.statusText}${text ? ` — ${text}` : ''}`);
      }
      sessions = [await r.json()];
    } else {
      const r = await fetch(`${baseUrl}/api/sessions/batches/${batchId}?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to list sessions: ${r.status} ${r.statusText}${text ? ` — ${text}` : ''}`);
      }
      sessions = await r.json();
    }

    const savedSessions = sessions.filter(s => s.savedTo != null);

    await Promise.all(savedSessions.map(async (s) => {
      const restoreUrl = `${baseUrl}/api/baselines/${s.baselineId}/${s.baselineRev}/restore?accountId=${accountId}&apiKey=${encodeURIComponent(apiKey)}`;
      const response = await fetch(restoreUrl, { method: 'POST' });
      await getResponseResult(response, apiKey);
    }));

    console.log(JSON.stringify({
      status: 'restored',
      batchId,
      count: savedSessions.length,
      sessions: savedSessions.map(s => ({ id: s.id, scenarioName: s.startInfo?.scenarioName, baselineId: s.baselineId, baselineRev: s.baselineRev })),
    }));
  } catch (error) {
    console.error(`Error restoring baselines: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
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
  resolveStep(sessionUrl, stepIndex, command === 'accept', apiKey);
} else if (command === 'save') {
  saveBaselines(sessionUrl, apiKey);
} else if (command === 'restore') {
  restoreBaselines(sessionUrl, apiKey);
}
