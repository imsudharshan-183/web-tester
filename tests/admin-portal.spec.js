const { test, expect } = require('@playwright/test');
require('dotenv').config();

const LOGIN_URL = process.env.STAGING_LOGIN_URL || 'https://invent-ui.vercel.app/admin/login';
const USERNAME = process.env.TEST_USERNAME || 'superadmin@amtex.in';
const PASSWORD = process.env.TEST_PASSWORD || 'sGwW64KBCjbiB4qRrueJ';

test.describe('Invent Care Admin Portal - Authenticated End-to-End Suite', () => {
  test('1. Admin login page renders sign-in form correctly', async ({ page }) => {
    const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    expect(response.status()).toBeLessThan(400);

    await expect(page).toHaveTitle(/Invent Care/i);
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign ?in|log ?in/i })).toBeVisible();
  });

  test('2. Successful authentication redirects to Super Admin dashboard', async ({ page }) => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    await page.locator('#email').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();

    // Verify redirection to /admin
    await page.waitForURL(/\/admin/i, { timeout: 30000 });
    expect(page.url()).toContain('/admin');

    // Allow dashboard APIs to resolve
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Verify Super Admin profile & greeting
    await expect(page.getByText(/Super admin/i).first()).toBeVisible();
    await expect(page.getByText(/Murugan/i).first()).toBeVisible();

    // Verify core navigation modules
    await expect(page.getByText(/OVERVIEW/i).first()).toBeVisible();
    await expect(page.getByText(/PORTFOLIO/i).first()).toBeVisible();
    await expect(page.getByText(/OPERATIONS/i).first()).toBeVisible();
    await expect(page.getByText(/WORKSPACE/i).first()).toBeVisible();
  });

  test('3. Admin metrics and portfolio data load properly', async ({ page }) => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#email').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
    await page.waitForURL(/\/admin/i, { timeout: 30000 });

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Check dashboard statistics
    await expect(page.getByText(/properties in our care/i).first()).toBeVisible();
    await expect(page.getByText(/Clients/i).first()).toBeVisible();
    await expect(page.getByText(/Renewals & dues/i).first()).toBeVisible();
    await expect(page.getByText(/Field visits/i).first()).toBeVisible();
  });

  test('4. Edge Case: Invalid credentials show error and block dashboard access', async ({ page }) => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    await page.locator('#email').fill('invalid_user@amtex.in');
    await page.locator('#password').fill('wrongpassword123');
    await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();

    // Verify error banner appears
    await expect(page.getByText(/Invalid email or password/i)).toBeVisible({ timeout: 15000 });

    // Verify user remains on the login page and is not redirected
    expect(page.url()).toContain('/admin/login');
  });
});
