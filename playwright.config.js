// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright Test Configuration for Invent Care Staging
 * https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 2,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-artifacts/playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-artifacts/test-results.json' }],
  ],
  use: {
    baseURL: process.env.TEST_BASE_URL || 'https://inventcarepm-landing-staging.azurewebsites.net',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
      },
    },
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
        headless: true,
      },
    },
  ],
});
