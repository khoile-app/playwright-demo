import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isFigmaUrl, setFigmaBaseline } from 'figma';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesktopBrowserInfo = { name: string; width: number; height: number };

// ---------------------------------------------------------------------------
// Browser spec parsing  (<browser>@<width>x<height>)
// ---------------------------------------------------------------------------

const BROWSER_ALIASES: Record<string, string> = {
  chrome: 'chrome',
  chromium: 'chrome',
  firefox: 'firefox',
  ff: 'firefox',
  safari: 'safari',
  edge: 'edgechromium',
  edgechromium: 'edgechromium',
  ie: 'ie',
  ie11: 'ie',
  ie10: 'ie10',
};

const VERSION_SUFFIXES: Record<string, string> = {
  '1': 'one-version-back',
  '2': 'two-versions-back',
};

function resolveBrowserName(raw: string): string {
  const versionMatch = raw.match(/^(.+)-([12])$/);
  if (versionMatch) {
    const base = BROWSER_ALIASES[versionMatch[1]] ?? versionMatch[1];
    return `${base}-${VERSION_SUFFIXES[versionMatch[2]]}`;
  }
  return BROWSER_ALIASES[raw] ?? raw;
}

export function parseBrowserSpec(spec: string): DesktopBrowserInfo {
  const m = spec.match(/^([a-zA-Z0-9_-]+)@(\d+)x(\d+)$/i);
  if (!m) {
    throw new Error(
      `Invalid browser spec: "${spec}"\n` +
      `Expected format: {browser}@{width}x{height}  (e.g. chrome@1920x1080)`
    );
  }
  const name = resolveBrowserName(m[1].toLowerCase());
  const width = parseInt(m[2], 10);
  const height = parseInt(m[3], 10);
  return { name, width, height };
}

// ---------------------------------------------------------------------------
// Match level parsing
// ---------------------------------------------------------------------------

const MATCH_LEVEL_MAP: Record<string, string> = {
  none: 'None',
  strict: 'Strict',
  layout: 'Layout',
  dynamic: 'Dynamic',
  exact: 'Exact',
  ignorecolors: 'IgnoreColors',
  content: 'IgnoreColors',
};

export function parseMatchLevel(level: string): string {
  const mapped = MATCH_LEVEL_MAP[level.toLowerCase()];
  if (!mapped)
    throw new Error(
      `Unknown match level: "${level}"\n` +
      `Supported: ${Object.keys(MATCH_LEVEL_MAP).join(', ')}`
    );
  return mapped;
}

// ---------------------------------------------------------------------------
// Test name
// ---------------------------------------------------------------------------

function urlOrigin(u: URL): string {
  return u.port ? `${u.protocol}//${u.hostname}:${u.port}` : `${u.protocol}//${u.hostname}`;
}

export function generateTestName(baselineUrl: string, checkpointUrl: string): string {
  const u1 = new URL(baselineUrl);
  const u2 = new URL(checkpointUrl);
  const origin2 = urlOrigin(u2);
  const pathSegs2 = u2.pathname.split('/').filter(Boolean);
  const comps1 = [urlOrigin(u1), ...u1.pathname.split('/').filter(Boolean)];
  const comps2 = [origin2, ...pathSegs2];

  for (let len = 1; len <= comps2.length; len++) {
    const tail2 = comps2.slice(-len);
    const tail1 = len <= comps1.length ? comps1.slice(-len) : null;
    if (!tail1 || tail1.some((s, i) => s !== tail2[i])) {
      if (tail2[0] === origin2) {
        return origin2 + (pathSegs2.length > 0 ? '/' + pathSegs2.join('/') : '');
      }
      return tail2.join('/');
    }
  }
  return origin2 + (pathSegs2.length > 0 ? '/' + pathSegs2.join('/') : '');
}

function urlComponents(urlStr: string): string[] {
  const u = new URL(urlStr);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return [host, ...u.pathname.split('/').filter(Boolean)];
}

export function generateTags(url1: string, url2: string): { baselineTag: string; checkpointTag: string } {
  const c1 = urlComponents(url1);
  const c2 = urlComponents(url2);
  let diffIndex = Math.min(c1.length, c2.length);
  for (let i = 0; i < diffIndex; i++) {
    if (c1[i] !== c2[i]) { diffIndex = i; break; }
  }
  const tag = (comps: string[]) => comps.slice(diffIndex).join('/') || comps[comps.length - 1] || '';
  return { baselineTag: tag(c1), checkpointTag: tag(c2) };
}

// ---------------------------------------------------------------------------
// Read browser config from playwright.config.ts
// ---------------------------------------------------------------------------

async function readPlaywrightBrowsersInfo(projectRoot: string): Promise<any[]> {
  const configPath = path.join(projectRoot, 'playwright.config.ts');
  if (!fs.existsSync(configPath)) return [];
  try {
    const mod = await import(configPath);
    const info = mod.default?.use?.eyesConfig?.browsersInfo;
    if (Array.isArray(info) && info.length > 0) return info;
  } catch {
    // ignore — fall through
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatBrowserInfo(info: any): string {
  if (!info) return 'unknown';
  if (info.chromeEmulationInfo) {
    const { deviceName, screenOrientation } = info.chromeEmulationInfo;
    return screenOrientation ? `${deviceName} (${screenOrientation})` : deviceName;
  }
  if (info.iosDeviceInfo) {
    const { deviceName, screenOrientation } = info.iosDeviceInfo;
    return screenOrientation ? `${deviceName} (${screenOrientation})` : deviceName;
  }
  return `${info.name}@${info.width}x${info.height}`;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export async function runCompare(options: {
  url1?: string;
  url2: string;
  browsers: DesktopBrowserInfo[];
  matchLevel?: string;
  apiKey: string;
  projectRoot: string;
}): Promise<void> {
  const { url1, url2, browsers, matchLevel, apiKey, projectRoot } = options;

  const figmaMode = Boolean(url1 && isFigmaUrl(url1));
  let figmaAccessToken: string | undefined;
  if (figmaMode) {
    figmaAccessToken = process.env.FIGMA_ACCESS_TOKEN;
    if (!figmaAccessToken) {
      console.error(
        'Error: FIGMA_ACCESS_TOKEN is not set.\n\n' +
        'Set it in .env or as an environment variable:\n' +
        '  FIGMA_ACCESS_TOKEN=your_token_here'
      );
      process.exit(1);
    }
    process.stderr.write(`Mode: URL vs Figma\n`);
    process.stderr.write(`Design:     ${url1}\n`);
    process.stderr.write(`Checkpoint: ${url2}\n`);
  } else if (url1) {
    process.stderr.write(`Mode: URL vs URL\n`);
    process.stderr.write(`Baseline:   ${url1}\n`);
    process.stderr.write(`Checkpoint: ${url2}\n`);
  } else {
    process.stderr.write(`Mode: single-URL checkpoint\n`);
    process.stderr.write(`Checkpoint: ${url2}\n`);
  }

  // --- Dynamic imports with helpful error messages ---

  let eyesMod: any;
  try {
    eyesMod = await import('@applitools/eyes-playwright');
  } catch {
    console.error(
      'Error: @applitools/eyes-playwright is not installed.\n\n' +
      'Install it with:\n' +
      '  npm install --save-dev @applitools/eyes-playwright\n\n' +
      'Then retry.'
    );
    process.exit(1);
  }

  let playwrightMod: any;
  try {
    playwrightMod = await import('playwright');
  } catch {
    console.error(
      'Error: playwright is not installed.\n\n' +
      'Install it with:\n' +
      '  npm install --save-dev playwright\n' +
      '  npx playwright install chromium\n\n' +
      'Then retry.'
    );
    process.exit(1);
  }

  const { Eyes, VisualGridRunner, Configuration, BatchInfo, Target } = eyesMod;
  const { chromium } = playwrightMod;

  // --- Configuration ---

  let testName: string;
  let baselineTag: string | undefined;
  let checkpointTag: string;

  if (url1) {
    testName = generateTestName(url1, url2);
    ({ baselineTag, checkpointTag } = generateTags(url1, url2));
  } else {
    const u2 = new URL(url2);
    const host = u2.port ? `${u2.protocol}//${u2.hostname}:${u2.port}` : `${u2.protocol}//${u2.hostname}`;
    testName = host + (u2.pathname === '/' ? '' : u2.pathname);
    checkpointTag = u2.pathname || '/';
  }

  const batchName = `eyes-compare ${testName}`;
  const appName = 'eyes-compare';

  // Shared batch ID so both passes appear in one batch
  const batch = new BatchInfo(batchName);
  batch.setId(crypto.randomUUID());

  // Browser list: explicit args > playwright config > fallback
  const browsersInfo: any[] =
    browsers.length > 0 ? browsers : await readPlaywrightBrowsersInfo(projectRoot);
  if (browsersInfo.length === 0) browsersInfo.push({ name: 'chrome', width: 1280, height: 720 });

  const makeConfig = (dontCloseBatches = false, saveFailedTests = false) => {
    const cfg = new Configuration();
    cfg.setApiKey(apiKey);
    cfg.setAppName(appName);
    cfg.setTestName(testName);
    cfg.setBatch(batch);
    cfg.setSaveNewTests(true);
    cfg.setSaveFailedTests(saveFailedTests);
    cfg.setDontCloseBatches(dontCloseBatches);
    if (matchLevel) cfg.setMatchLevel(matchLevel);
    for (const b of browsersInfo) cfg.addBrowser(b);
    return cfg;
  };

  const browser = await chromium.launch();
  try {
    const isAborted = (c: any) => !!c.getException?.() && !c.getTestResults?.();

    if (url1 && !figmaMode) {
      // --- Pass 1: visit URL1 to establish baseline ---
      // Keep the batch open so runner2 can append to it.
      const runner1 = new VisualGridRunner();
      const eyes1 = new Eyes(runner1, makeConfig(true, true));
      const t1 = Date.now();
      const page1 = await browser.newPage();
      await eyes1.open(page1, appName, testName);
      await page1.goto(url1, { waitUntil: 'load' });
      await eyes1.check(baselineTag!, Target.window().fully());
      await eyes1.close(false);
      await page1.close();

      // Wait for all UFG renders to complete before starting pass 2 so that
      // the baseline is committed before URL2 is compared against it.
      const summary1 = await runner1.getAllTestResults(false);
      process.stderr.write(`Captured baseline: ${url1} (${Date.now() - t1}ms)\n`);

      const baselineAborts = summary1.getAllResults().filter(isAborted);
      if (baselineAborts.length > 0) {
        console.error(`Failed to capture baseline images of ${url1} for ${baselineAborts.length} browser(s):`);
        for (const c of baselineAborts) {
          const b = formatBrowserInfo(c.getBrowserInfo?.());
          const err = c.getException?.();
          console.error(`  ${b}: ${err instanceof Error ? err.message : String(err ?? 'unknown error')}`);
        }
        process.exit(1);
      }

      // Delete pass 1 sessions now — before pass 2 starts — to keep the dashboard clean
      for (const container of summary1.getAllResults()) {
        try { await container.getTestResults()?.delete(); } catch { /* non-fatal */ }
      }
    }

    // --- Pass 2: visit URL2 and compare against baseline ---
    const runner2 = new VisualGridRunner();
    const eyes2 = new Eyes(runner2, makeConfig());
    const t2 = Date.now();
    const page2 = await browser.newPage();
    if (figmaMode) {
      process.stderr.write(`Setting Figma baseline...\n`);
      await setFigmaBaseline(eyes2.configuration, url1!, { accessToken: figmaAccessToken });
      process.stderr.write(`Opening checkpoint...\n`);
    }
    if (figmaMode) {
      await eyes2.open(page2);  // relies on config set by setFigmaBaseline
    } else {
      await eyes2.open(page2, appName, testName);
    }
    await page2.goto(url2, { waitUntil: 'load' });
    await eyes2.check(checkpointTag, Target.window().fully());
    await eyes2.close(false);
    await page2.close();

    const summary2 = await runner2.getAllTestResults(false);
    process.stderr.write(`Captured checkpoint: ${url2} (${Date.now() - t2}ms)\n`);

    const containers: any[] = summary2.getAllResults();

    const checkpointAborts = containers.filter(isAborted);
    if (checkpointAborts.length > 0) {
      console.error(`Failed to capture checkpoint images of ${url2} for ${checkpointAborts.length} browser(s):`);
      for (const c of checkpointAborts) {
        const b = formatBrowserInfo(c.getBrowserInfo?.());
        const err = c.getException?.();
        console.error(`  ${b}: ${err instanceof Error ? err.message : String(err ?? 'unknown error')}`);
      }
      process.exit(1);
    }

    // --- Output ---
    let resultUrl: string | undefined;
    for (const c of containers) {
      try { resultUrl = resultUrl ?? c.getTestResults()?.getUrl?.() ?? undefined; } catch { /* ignore */ }
    }

    console.log(`test name: ${testName}`);
    if (resultUrl) console.log(`See results of '${testName}' at URL: ${resultUrl}`);

    const allPassed = containers.every((c: any) => {
      try { return c.getTestResults()?.getStatus?.() === 'Passed'; } catch { return false; }
    });

    if (allPassed) {
      console.log('No differences found!');
    } else {
      const rows = containers.map((c: any) => {
        const b = formatBrowserInfo(c.getBrowserInfo?.());
        switch ((c.getTestResults()?.getStatus?.() ?? '').toLowerCase()) {
          case 'passed':     return { browser: b, status: 'passed' };
          case 'unresolved': return { browser: b, status: 'differences found' };
          case 'failed':     return { browser: b, status: 'failed' };
          default:           return { browser: b, status: 'unknown' };
        }
      });

      const colWidth = Math.max(...rows.map((r: any) => r.browser.length));
      for (const { browser, status } of rows) {
        console.log(`${browser.padEnd(colWidth)}  ${status}`);
      }
    }
  } finally {
    await browser.close();
  }
}
