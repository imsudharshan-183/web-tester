# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: inventcare-landing.spec.js >> Invent Care Landing Page Test Suite >> 2. Header branding and navigation elements are present
- Location: tests\inventcare-landing.spec.js:27:3

# Error details

```
Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://inventcarepm-landing-staging.azurewebsites.net/
Call log:
  - navigating to "https://inventcarepm-landing-staging.azurewebsites.net/", waiting until "domcontentloaded"

```

# Test source

```ts
  1   | const { test, expect } = require('@playwright/test');
  2   | 
  3   | const TARGET_URL = 'https://inventcarepm-landing-staging.azurewebsites.net';
  4   | 
  5   | test.describe('Invent Care Landing Page Test Suite', () => {
  6   |   test.beforeEach(async ({ page }) => {
  7   |     // Navigate with domcontentloaded to handle continuous 3D/video asset loading gracefully
> 8   |     const response = await page.goto(TARGET_URL, {
      |                                 ^ Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://inventcarepm-landing-staging.azurewebsites.net/
  9   |       waitUntil: 'domcontentloaded',
  10  |       timeout: 30000,
  11  |     });
  12  |     expect(response).not.toBeNull();
  13  |     expect(response.status()).toBeLessThan(400);
  14  |     // Allow brief time for scripts to hydrate
  15  |     await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
  16  |   });
  17  | 
  18  |   test('1. Page responds with HTTP 200, valid title, and NRI meta description', async ({ page }) => {
  19  |     await expect(page).toHaveTitle(/Invent Care/i);
  20  | 
  21  |     const description = await page.locator('meta[name="description"]').getAttribute('content');
  22  |     expect(description).toBeTruthy();
  23  |     expect(description).toContain('Property care for NRI owners');
  24  |     expect(description).toContain('Tamil Nadu');
  25  |   });
  26  | 
  27  |   test('2. Header branding and navigation elements are present', async ({ page, isMobile }) => {
  28  |     // Top brand logo
  29  |     const brand = page.locator('.hud a.brand').first();
  30  |     await expect(brand).toBeVisible();
  31  |     await expect(brand).toHaveAttribute('href', /#covered/);
  32  | 
  33  |     // Login link is always visible on both desktop and mobile
  34  |     const loginLink = page.locator('#toolLogin');
  35  |     await expect(loginLink).toBeVisible();
  36  | 
  37  |     if (isMobile) {
  38  |       // On mobile viewports, secondary chips are tucked away via media queries
  39  |       const whatWeDoLink = page.locator('#toolWhat');
  40  |       await expect(whatWeDoLink).toBeAttached();
  41  |     } else {
  42  |       // Desktop displays all navigation chips
  43  |       const whatWeDoLink = page.locator('#toolWhat');
  44  |       const earlyAccessLink = page.locator('#toolAccess');
  45  |       await expect(whatWeDoLink).toBeVisible();
  46  |       await expect(earlyAccessLink).toBeVisible();
  47  |     }
  48  |   });
  49  | 
  50  |   test('3. Anchor links scroll to target sections', async ({ page, isMobile }) => {
  51  |     // Brand link points to #covered
  52  |     const brand = page.locator('.hud a.brand').first();
  53  |     await expect(brand).toHaveAttribute('href', /#covered/);
  54  | 
  55  |     // Verify sections exist in the DOM
  56  |     const coveredSection = page.locator('#covered');
  57  |     const accessSection = page.locator('#access');
  58  |     await expect(coveredSection).toBeAttached();
  59  |     await expect(accessSection).toBeAttached();
  60  | 
  61  |     if (!isMobile) {
  62  |       const whatWeDoLink = page.locator('#toolWhat');
  63  |       await expect(whatWeDoLink).toHaveAttribute('href', /#covered/);
  64  |       const earlyAccessLink = page.locator('#toolAccess');
  65  |       await expect(earlyAccessLink).toHaveAttribute('href', /#access/);
  66  |     }
  67  |   });
  68  | 
  69  |   test('4. External portal link points to staging application', async ({ page }) => {
  70  |     const loginLinks = page.locator('a[href*="inventcarepm-staging.azurewebsites.net"]');
  71  |     const count = await loginLinks.count();
  72  |     expect(count).toBeGreaterThan(0);
  73  | 
  74  |     const firstHref = await loginLinks.first().getAttribute('href');
  75  |     expect(firstHref).toContain('inventcarepm-staging.azurewebsites.net');
  76  |   });
  77  | 
  78  |   test('5. Key service pillars and owner information sections are visible', async ({ page }) => {
  79  |     const sections = [
  80  |       'Maintenance & day care',
  81  |       'Rent',
  82  |       'Taxes & bills',
  83  |       'Documents',
  84  |       'Site visits',
  85  |     ];
  86  | 
  87  |     for (const title of sections) {
  88  |       const heading = page.getByRole('heading', { name: title });
  89  |       await expect(heading).toBeAttached();
  90  |     }
  91  |   });
  92  | 
  93  |   test('6. "Get early access" form inputs and validation', async ({ page }) => {
  94  |     const form = page.locator('#form');
  95  |     await expect(form).toBeAttached();
  96  | 
  97  |     const nameInput = page.locator('#fName');
  98  |     const countryInput = page.locator('#fCountry');
  99  |     const placeInput = page.locator('#fPlace');
  100 |     const phoneInput = page.locator('#fPhone');
  101 |     const submitBtn = form.getByRole('button', { name: /Get early access/i });
  102 | 
  103 |     // Verify all input fields exist and have required attribute
  104 |     await expect(nameInput).toBeVisible();
  105 |     await expect(nameInput).toHaveAttribute('required', '');
  106 |     await expect(countryInput).toBeVisible();
  107 |     await expect(countryInput).toHaveAttribute('required', '');
  108 |     await expect(placeInput).toBeVisible();
```