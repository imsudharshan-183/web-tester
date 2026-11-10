# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-portal.spec.js >> Invent Care Admin Portal - Authenticated End-to-End Suite >> 1. Admin login page renders sign-in form correctly
- Location: tests\admin-portal.spec.js:9:3

# Error details

```
Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://invent-ui.vercel.app/admin/login
Call log:
  - navigating to "https://invent-ui.vercel.app/admin/login", waiting until "domcontentloaded"

```

# Test source

```ts
  1  | const { test, expect } = require('@playwright/test');
  2  | require('dotenv').config();
  3  | 
  4  | const LOGIN_URL = process.env.STAGING_LOGIN_URL || 'https://invent-ui.vercel.app/admin/login';
  5  | const USERNAME = process.env.TEST_USERNAME || 'superadmin@amtex.in';
  6  | const PASSWORD = process.env.TEST_PASSWORD || 'sGwW64KBCjbiB4qRrueJ';
  7  | 
  8  | test.describe('Invent Care Admin Portal - Authenticated End-to-End Suite', () => {
  9  |   test('1. Admin login page renders sign-in form correctly', async ({ page }) => {
> 10 |     const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
     |                                 ^ Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://invent-ui.vercel.app/admin/login
  11 |     expect(response.status()).toBeLessThan(400);
  12 | 
  13 |     await expect(page).toHaveTitle(/Invent Care/i);
  14 |     await expect(page.locator('#email')).toBeVisible();
  15 |     await expect(page.locator('#password')).toBeVisible();
  16 |     await expect(page.getByRole('button', { name: /sign ?in|log ?in/i })).toBeVisible();
  17 |   });
  18 | 
  19 |   test('2. Successful authentication redirects to Super Admin dashboard', async ({ page }) => {
  20 |     await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  21 | 
  22 |     await page.locator('#email').fill(USERNAME);
  23 |     await page.locator('#password').fill(PASSWORD);
  24 |     await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  25 | 
  26 |     // Verify redirection to /admin
  27 |     await page.waitForURL(/\/admin/i, { timeout: 30000 });
  28 |     expect(page.url()).toContain('/admin');
  29 | 
  30 |     // Allow dashboard APIs to resolve
  31 |     await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  32 | 
  33 |     // Verify Super Admin profile & greeting
  34 |     await expect(page.getByText(/Super admin/i).first()).toBeVisible();
  35 |     await expect(page.getByText(/Murugan/i).first()).toBeVisible();
  36 | 
  37 |     // Verify core navigation modules
  38 |     await expect(page.getByText(/OVERVIEW/i).first()).toBeVisible();
  39 |     await expect(page.getByText(/PORTFOLIO/i).first()).toBeVisible();
  40 |     await expect(page.getByText(/OPERATIONS/i).first()).toBeVisible();
  41 |     await expect(page.getByText(/WORKSPACE/i).first()).toBeVisible();
  42 |   });
  43 | 
  44 |   test('3. Admin metrics and portfolio data load properly', async ({ page }) => {
  45 |     await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  46 |     await page.locator('#email').fill(USERNAME);
  47 |     await page.locator('#password').fill(PASSWORD);
  48 |     await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  49 |     await page.waitForURL(/\/admin/i, { timeout: 30000 });
  50 | 
  51 |     await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  52 | 
  53 |     // Check dashboard statistics
  54 |     await expect(page.getByText(/properties in our care/i).first()).toBeVisible();
  55 |     await expect(page.getByText(/Clients/i).first()).toBeVisible();
  56 |     await expect(page.getByText(/Renewals & dues/i).first()).toBeVisible();
  57 |     await expect(page.getByText(/Field visits/i).first()).toBeVisible();
  58 |   });
  59 | 
  60 |   test('4. Edge Case: Invalid credentials show error and block dashboard access', async ({ page }) => {
  61 |     await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  62 | 
  63 |     await page.locator('#email').fill('invalid_user@amtex.in');
  64 |     await page.locator('#password').fill('wrongpassword123');
  65 |     await page.getByRole('button', { name: /sign ?in|log ?in/i }).click();
  66 | 
  67 |     // Verify error banner appears
  68 |     await expect(page.getByText(/Invalid email or password/i)).toBeVisible({ timeout: 15000 });
  69 | 
  70 |     // Verify user remains on the login page and is not redirected
  71 |     expect(page.url()).toContain('/admin/login');
  72 |   });
  73 | });
  74 | 
```