import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

export function generateTestName(url1: string, url2: string): string {
  const u1 = new URL(url1);
  const u2 = new URL(url2);
  const clean = (p: string) => p.replace(/\/+$/, '') || '/';
  const p1 = clean(u1.pathname);
  const p2 = clean(u2.pathname);
  const label = (p: string) =>
    p === '/' ? '/' : '/' + p.split('/').filter(Boolean).slice(-2).join('/');
  if (p1 === p2) {
    if (p1 === '/') {
      return u1.hostname === u2.hostname
        ? u1.hostname
        : `${u1.hostname} vs ${u2.hostname}`;
    }
    const base = label(p1);
    return u1.hostname === u2.hostname
      ? base
      : `${base} (${u1.hostname} vs ${u2.hostname})`;
  }
  return `${label(p1)} vs ${label(p2)}`;
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
  url1: string;
  url2: string;
  browsers: DesktopBrowserInfo[];
  matchLevel?: string;
  apiKey: string;
  projectRoot: string;
}): Promise<void> {
  const { url1, url2, browsers, matchLevel, apiKey, projectRoot } = options;

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

  const checkpointTag = generateTestName(url1, url2);
  const testName = `eyes-inspect compare ${checkpointTag}`;
  const appName = 'eyes-inspect';
  const batchName = testName;

  // Shared batch ID so both passes appear in one batch
  const batch = new BatchInfo(batchName);
  batch.setId(crypto.randomUUID());

  // Browser list: explicit args > playwright config > fallback
  const browsersInfo: any[] =
    browsers.length > 0 ? browsers : await readPlaywrightBrowsersInfo(projectRoot);
  if (browsersInfo.length === 0) browsersInfo.push({ name: 'chrome', width: 1280, height: 720 });

  const makeConfig = (dontCloseBatches = false) => {
    const cfg = new Configuration();
    cfg.setApiKey(apiKey);
    cfg.setAppName(appName);
    cfg.setTestName(testName);
    cfg.setBatch(batch);
    cfg.setSaveNewTests(true);
    cfg.setDontCloseBatches(dontCloseBatches);
    if (matchLevel) cfg.setMatchLevel(matchLevel);
    for (const b of browsersInfo) cfg.addBrowser(b);
    return cfg;
  };

  const browser = await chromium.launch();
  try {
    // --- Pass 1: visit URL1 to establish baseline ---
    // Keep the batch open so runner2 can append to it.
    const runner1 = new VisualGridRunner();
    const eyes1 = new Eyes(runner1, makeConfig(true));
    const t1 = Date.now();
    const page1 = await browser.newPage();
    await eyes1.open(page1, appName, testName);
    await page1.goto(url1, { waitUntil: 'load' });
    await eyes1.check(checkpointTag, Target.window().fully());
    await eyes1.close(false);
    await page1.close();

    // Wait for all UFG renders to complete before starting pass 2 so that
    // the baseline is committed before URL2 is compared against it.
    const summary1 = await runner1.getAllTestResults(false);
    process.stderr.write(`Captured baseline: ${url1} (${Date.now() - t1}ms)\n`);

    const isAborted = (c: any) => !!c.getException?.() && !c.getTestResults?.();
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

    // --- Pass 2: visit URL2 and compare against URL1's baseline ---
    const runner2 = new VisualGridRunner();
    const eyes2 = new Eyes(runner2, makeConfig());
    const t2 = Date.now();
    const page2 = await browser.newPage();
    await eyes2.open(page2, appName, testName);
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
