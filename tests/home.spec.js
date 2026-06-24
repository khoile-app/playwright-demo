const { test, expect } = require('@playwright/test');
const { Eyes, Target } = require('@applitools/eyes-playwright');

async function runVisualTest(page, testInfo, callback) {
  const eyes = new Eyes();

  await eyes.open(page, 'playwright-demo', testInfo.title, { width: 1280, height: 720 });

  try {
    await callback();
    await eyes.check(testInfo.title, Target.window());
    await eyes.close();
  } catch (error) {
    await eyes.abortIfNotClosed();
    throw error;
  }
}

test('homepage title', async ({ page }, testInfo) => {
  await runVisualTest(page, testInfo, async () => {
    await page.goto('/');
    await expect(page.locator('#title')).toHaveText('Hello Playwright');
  });
});

test('login form navigates to a profile page with the username and cat image', async ({ page }, testInfo) => {
  await runVisualTest(page, testInfo, async () => {
    await page.goto('/');

    await page.getByLabel('Username').fill('Ada');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.locator('#profile-title')).toContainText('Ada');
    await expect(page.locator('#cat-image')).toHaveAttribute('src', /cataas\.com\/cat/);
  });
});