import { parseBrowserSpec, parseMatchLevel, DesktopBrowserInfo } from './sdk-utils';

const MATCH_LEVELS = new Set(['strict', 'layout', 'dynamic', 'exact', 'none', 'ignorecolors', 'content']);

export type ParsedArgs = {
  matchLevel: string | undefined;
  url1: string | undefined;
  url2: string;
  browsers: DesktopBrowserInfo[];
};

export type ParseArgsResult =
  | (ParsedArgs & { error?: never })
  | { error: string };

function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

export function parseArgs(args: string[]): ParseArgsResult {
  let offset = 0;
  let matchLevel: string | undefined;

  if (args[0] !== undefined && MATCH_LEVELS.has(args[0].toLowerCase())) {
    try {
      matchLevel = parseMatchLevel(args[0]);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    offset = 1;
  }

  const firstArg = args[offset];
  const secondArg = args[offset + 1];

  if (firstArg === undefined) {
    return { error: 'Usage: [matchLevel] [url1] <url2> [browser@widthxheight ...]\nAt least one URL is required.' };
  }

  let url1: string | undefined;
  let url2: string;
  let browserArgStart: number;

  if (secondArg !== undefined && isValidUrl(secondArg)) {
    if (!isValidUrl(firstArg)) {
      return { error: `Invalid url1: "${firstArg}" is not a valid URL` };
    }
    url1 = firstArg;
    url2 = secondArg;
    browserArgStart = offset + 2;
  } else {
    if (!isValidUrl(firstArg)) {
      return { error: `Invalid url2: "${firstArg}" is not a valid URL` };
    }
    url1 = undefined;
    url2 = firstArg;
    browserArgStart = offset + 1;
  }

  const browsers: DesktopBrowserInfo[] = [];
  for (const spec of args.slice(browserArgStart)) {
    try {
      browsers.push(parseBrowserSpec(spec));
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { matchLevel, url1, url2, browsers };
}
