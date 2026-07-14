const { test, expect } = require('@playwright/test');
const { Eyes, Target, BatchClose, VisualGridRunner, Configuration } = require('@applitools/eyes-playwright');

const sharedBatchName = process.env.APPLITOOLS_BATCH_NAME || 'playwright-demo';
const sharedBatchId = process.env.APPLITOOLS_BATCH_ID;

// Execute this in your Playwright global teardown or afterAll hook
async function closeMyBatch() {
  if (sharedBatchId) {
    const batchClose = new BatchClose();
    await batchClose.setBatchIds([sharedBatchId]).close();
    console.log(`Batch ${sharedBatchId} closed successfully.`);
  }
}

async function runVisualTest(page, testInfo, callback) {
  const runner = new VisualGridRunner();
  const config = new Configuration();

  config.setAppName('playwright-demo');
  config.setTestName(testInfo.title);
  config.setViewportSize({ width: 1280, height: 720 });
  config.addBrowser(1280, 720, 'firefox');
  config.addBrowser(1280, 720, 'safari');
  config.addBrowser(1280, 720, 'chrome');
  config.setBatch({ name: sharedBatchName, id: sharedBatchId });

  const eyes = new Eyes(runner, config);

  await eyes.open(page);

  try {
    await callback(eyes);
    await eyes.close(false);
    await closeMyBatch();
  } catch (error) {
    await eyes.abortIfNotClosed();
    throw error;
  }
}

/*
test('homepage title', async ({ page }, testInfo) => {
  await runVisualTest(page, testInfo, async (eyes) => {
    await page.goto('/');
    await expect(page.locator('#title')).toHaveText('Hello Playwright');
    await eyes.check('starting page', Target.window());
  });
});
*/

test('login form navigates to a profile page with the username and cat image', async ({ page }, testInfo) => {
  await runVisualTest(page, testInfo, async (eyes) => {
    await page.goto('/');
    await eyes.check('starting page', Target.window());

    await page.getByLabel('Username').fill('Ada');
    await page.getByLabel('Password').fill('secret');
    await eyes.check('after filling login information', Target.window());

    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.locator('#profile-title')).toContainText('Ada');
    await expect(page.locator('#cat-image')).toHaveAttribute('src', /cataas\.com\/cat/);
    await eyes.check('after login', Target.window());
  });
});
