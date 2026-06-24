const {test, expect} = require('@playwright/test');
test('homepage title', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await expect(page.locator('#title')).toHaveText('Hello Playwright');
});