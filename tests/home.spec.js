const { test, expect } = require('@playwright/test');
const { Eyes, Target } = require('@applitools/eyes-playwright');
import { BatchClose } from '@applitools/eyes-playwright';

// Execute this in your Playwright global teardown or afterAll hook
async function closeMyBatch() {
  const batchId = process.env.APPLITOOLS_BATCH_ID;

  if (batchId) {
    const batchClose = new BatchClose();
    
    // FIX 1: Change to setBatchIds
    // FIX 2: Wrap the batchId string inside an array []
    await batchClose.setBatchIds([batchId]).close();
    
    console.log(`Batch ${batchId} closed successfully.`);
  }
}

async function runVisualTest(page, testInfo, callback) {
  const eyes = new Eyes();

  await eyes.open(page, 'playwright-demo', testInfo.title, { width: 1280, height: 720 });

  try {
    await callback(eyes);
    await eyes.close();
    await closeMyBatch();
  } catch (error) {
    await eyes.abortIfNotClosed();
    throw error;
  }
}

test('homepage title', async ({ page }, testInfo) => {
  await runVisualTest(page, testInfo, async (eyes) => {
    await page.goto('/');
    await expect(page.locator('#title')).toHaveText('Hello Playwright');
    await eyes.check('starting page', Target.window());
  });
});

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
