const { test, expect } = require('@playwright/test');

test('homepage title', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await expect(page.locator('#title')).toHaveText('Hello Playwright');
});

test('login form navigates to a profile page with the username and cat image', async ({ page }) => {
  await page.goto('http://localhost:3000');

  await page.getByLabel('Username').fill('Ada');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.locator('#profile-title')).toContainText('Ada');
  await expect(page.locator('#cat-image')).toHaveAttribute('src', /cataas\.com\/cat/);
});