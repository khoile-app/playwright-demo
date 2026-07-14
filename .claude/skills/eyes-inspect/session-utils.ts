export interface ImageInfo {
  id: string | null;
  domId: string | null;
  size: { width: number; height: number } | null;
}

export interface SimplifiedSession {
  sessionName: string;
  appName: string;
  status: string;
  startedAt: string;
  steps: Array<{
    tag: string | undefined;
    baseline: ImageInfo;
    checkpoint: ImageInfo;
    isMatching: boolean;
    resolution: 'accepted' | 'rejected' | 'none';
  }>;
}

export interface ParsedSessionUrl {
  baseUrl: string;
  batchId: string;
  sessionId: string;
  accountId: string;
}

function parseApplitoolsUrl(url: string): { baseUrl: string; batchId: string; sessionId: string | null; accountId: string } {
  const urlMatch = url.match(/^(https?:\/\/[^/]+)/);
  if (!urlMatch) throw new Error(`Invalid URL format: "${url}"`);

  const sessionMatch = url.match(/\/app\/test-results\/([^/]+)\/([^/?]+)/);
  if (sessionMatch) {
    const accountIdMatch = url.match(/accountId=([^&]+)/);
    if (!accountIdMatch) throw new Error(`Missing accountId in URL: "${url}"`);
    return { baseUrl: urlMatch[1], batchId: sessionMatch[1], sessionId: sessionMatch[2], accountId: accountIdMatch[1] };
  }

  const batchMatch = url.match(/\/app\/test-results\/([^/?]+)/);
  if (batchMatch) {
    const accountIdMatch = url.match(/accountId=([^&]+)/);
    if (!accountIdMatch) throw new Error(`Missing accountId in URL: "${url}"`);
    return { baseUrl: urlMatch[1], batchId: batchMatch[1], sessionId: null, accountId: accountIdMatch[1] };
  }

  throw new Error(`Invalid URL format: "${url}"`);
}

export function parseSessionUrl(url: string): ParsedSessionUrl {
  const parsed = parseApplitoolsUrl(url);
  if (parsed.sessionId === null) {
    throw new Error(
      'The input URL is a batch URL while a session URL is expected. ' +
      'Use the eyes_fetch_visual_results MCP tool to obtain URLs of sessions in this batch.'
    );
  }
  return parsed as ParsedSessionUrl;
}

export type ParsedBatchUrl = Omit<ParsedSessionUrl, 'sessionId'> & { sessionId: null };

export function parseBatchUrl(url: string): ParsedBatchUrl {
  const { baseUrl, batchId, accountId } = parseApplitoolsUrl(url);
  return { baseUrl, batchId, sessionId: null, accountId };
}

export function simplifySession(rawData: any): SimplifiedSession {
  const steps = [];

  const expectedOutputs = rawData.expectedAppOutput || [];
  const actualOutputs = rawData.actualAppOutput || [];
  const appOutputResolution = rawData.appOutputResolution || [];

  for (let i = 0; i < Math.max(expectedOutputs.length, actualOutputs.length); i++) {
    const expected = expectedOutputs[i];
    const actual = actualOutputs[i];

    if (!expected && !actual) continue;

    const tag = actual?.tag;
    const isMatching = actual?.isMatching ?? false;

    let resolution: 'accepted' | 'rejected' | 'none' = 'none';
    const resolutionEntry = appOutputResolution[i];
    if (resolutionEntry !== null && resolutionEntry !== undefined) {
      // replaceExpected: true means accepted (replaced the expected), false means rejected
      resolution = resolutionEntry.replaceExpected === true ? 'accepted' : 'rejected';
    }

    steps.push({
      tag,
      baseline: { id: expected?.image?.id ?? null, domId: expected?.image?.domId ?? null, size: expected?.image?.size ?? null },
      checkpoint: { id: actual?.image?.id ?? null, domId: actual?.image?.domId ?? null, size: actual?.image?.size ?? null },
      isMatching,
      resolution,
    });
  }

  return {
    sessionName: rawData.scenarioName,
    appName: rawData.appName,
    status: rawData.status,
    startedAt: rawData.startedAt,
    steps,
  };
}
