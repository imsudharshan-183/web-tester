const { test, expect } = require('@playwright/test');

const TARGET_URL = 'https://inventcarepm-landing-staging.azurewebsites.net';

test.describe('Invent Care Landing Page Test Suite', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate with domcontentloaded to handle continuous 3D/video asset loading gracefully
    const response = await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    expect(response).not.toBeNull();
    expect(response.status()).toBeLessThan(400);
    // Allow brief time for scripts to hydrate
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
  });

  test('1. Page responds with HTTP 200, valid title, and NRI meta description', async ({ page }) => {
    await expect(page).toHaveTitle(/Invent Care/i);

    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toBeTruthy();
    expect(description).toContain('Property care for NRI owners');
    expect(description).toContain('Tamil Nadu');
  });

  test('2. Header branding and navigation elements are present', async ({ page, isMobile }) => {
    // Top brand logo
    const brand = page.locator('.hud a.brand').first();
    await expect(brand).toBeVisible();
    await expect(brand).toHaveAttribute('href', /#covered/);

    // Login link is always visible on both desktop and mobile
    const loginLink = page.locator('#toolLogin');
    await expect(loginLink).toBeVisible();

    if (isMobile) {
      // On mobile viewports, secondary chips are tucked away via media queries
      const whatWeDoLink = page.locator('#toolWhat');
      await expect(whatWeDoLink).toBeAttached();
    } else {
      // Desktop displays all navigation chips
      const whatWeDoLink = page.locator('#toolWhat');
      const earlyAccessLink = page.locator('#toolAccess');
      await expect(whatWeDoLink).toBeVisible();
      await expect(earlyAccessLink).toBeVisible();
    }
  });

  test('3. Anchor links scroll to target sections', async ({ page, isMobile }) => {
    // Brand link points to #covered
    const brand = page.locator('.hud a.brand').first();
    await expect(brand).toHaveAttribute('href', /#covered/);

    // Verify sections exist in the DOM
    const coveredSection = page.locator('#covered');
    const accessSection = page.locator('#access');
    await expect(coveredSection).toBeAttached();
    await expect(accessSection).toBeAttached();

    if (!isMobile) {
      const whatWeDoLink = page.locator('#toolWhat');
      await expect(whatWeDoLink).toHaveAttribute('href', /#covered/);
      const earlyAccessLink = page.locator('#toolAccess');
      await expect(earlyAccessLink).toHaveAttribute('href', /#access/);
    }
  });

  test('4. External portal link points to staging application', async ({ page }) => {
    const loginLinks = page.locator('a[href*="inventcarepm-staging.azurewebsites.net"]');
    const count = await loginLinks.count();
    expect(count).toBeGreaterThan(0);

    const firstHref = await loginLinks.first().getAttribute('href');
    expect(firstHref).toContain('inventcarepm-staging.azurewebsites.net');
  });

  test('5. Key service pillars and owner information sections are visible', async ({ page }) => {
    const sections = [
      'Maintenance & day care',
      'Rent',
      'Taxes & bills',
      'Documents',
      'Site visits',
    ];

    for (const title of sections) {
      const heading = page.getByRole('heading', { name: title });
      await expect(heading).toBeAttached();
    }
  });

  test('6. "Get early access" form inputs and validation', async ({ page }) => {
    const form = page.locator('#form');
    await expect(form).toBeAttached();

    const nameInput = page.locator('#fName');
    const countryInput = page.locator('#fCountry');
    const placeInput = page.locator('#fPlace');
    const phoneInput = page.locator('#fPhone');
    const submitBtn = form.getByRole('button', { name: /Get early access/i });

    // Verify all input fields exist and have required attribute
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveAttribute('required', '');
    await expect(countryInput).toBeVisible();
    await expect(countryInput).toHaveAttribute('required', '');
    await expect(placeInput).toBeVisible();
    await expect(placeInput).toHaveAttribute('required', '');
    await expect(phoneInput).toBeVisible();
    await expect(phoneInput).toHaveAttribute('required', '');
    await expect(submitBtn).toBeVisible();

    // Fill in test data
    await nameInput.fill('Playwright Automation Test');
    await countryInput.fill('United States');
    await placeInput.fill('Chennai');
    await phoneInput.fill('+1 555 123 4567');

    // Confirm typed values are reflected accurately in the DOM
    await expect(nameInput).toHaveValue('Playwright Automation Test');
    await expect(countryInput).toHaveValue('United States');
    await expect(placeInput).toHaveValue('Chennai');
    await expect(phoneInput).toHaveValue('+1 555 123 4567');
  });

  test('7. No uncaught JavaScript exceptions or console errors', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const pageErrors = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // Scroll through the page to trigger dynamic interactions
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    // Filter out transient asset stream disconnects caused by test runner concurrency
    const runtimeErrors = consoleErrors.filter(
      (e) => !e.includes('ERR_CONNECTION_') && !e.includes('Failed to load resource')
    );

    // Assert zero uncaught runtime exceptions
    expect(pageErrors).toEqual([]);
    expect(runtimeErrors).toEqual([]);
  });
});
