const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const STATE_FILE = path.join(__dirname, '..', '..', 'test-artifacts', 'auth-state.json');
const DEFAULT_POST_LOGIN_PATTERN = 'admin|dashboard';

// Values like "<your login page address>" are placeholders, not real settings.
function isPlaceholder(value) {
  return /^<.*>$/.test(String(value).trim());
}

// Throw a clear error if a required .env value is missing or still a placeholder.
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Add it to your .env file.`);
  }
  if (isPlaceholder(value)) {
    throw new Error(`${name} is still a placeholder. Replace it in your .env file.`);
  }
  return value;
}

// Check whether a saved session already exists.
async function hasSavedLogin() {
  try {
    await fs.access(STATE_FILE);
    return true;
  } catch {
    return false;
  }
}

// Log in once and save cookies/localStorage for later browser runs.
async function saveLogin() {
  const loginUrl = requireEnv('STAGING_LOGIN_URL');
  const username = requireEnv('TEST_USERNAME');
  const password = requireEnv('TEST_PASSWORD');
  const postLoginPattern = process.env.STAGING_POST_LOGIN_PATTERN || DEFAULT_POST_LOGIN_PATTERN;

  if (isPlaceholder(postLoginPattern)) {
    throw new Error('STAGING_POST_LOGIN_PATTERN is still a placeholder. Replace it in your .env file.');
  }

  // Reject values that cannot be opened before launching a browser.
  try {
    const parsedLoginUrl = new URL(loginUrl);
    if (parsedLoginUrl.protocol !== 'http:' && parsedLoginUrl.protocol !== 'https:') {
      throw new Error('bad protocol');
    }
  } catch {
    throw new Error('STAGING_LOGIN_URL must be a full URL starting with http:// or https://.');
  }

  let urlPattern;
  try {
    urlPattern = new RegExp(postLoginPattern, 'i');
  } catch {
    throw new Error('STAGING_POST_LOGIN_PATTERN is not a valid regular expression.');
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});

    // Fill username/email field
    const userField = page.getByLabel(/email|username/i).first();
    if (await userField.count()) {
      await userField.fill(username);
    } else {
      await page.locator('#email, input[type="email"], input[name="email"], input[name="username"]').first().fill(username);
    }

    // Fill password field
    const passField = page.getByLabel(/password/i).first();
    if (await passField.count()) {
      await passField.fill(password);
    } else {
      await page.locator('#password, input[type="password"], input[name="password"]').first().fill(password);
    }

    await page.getByRole('button', { name: /log ?in|sign ?in/i }).first().click();
    await page.waitForURL(urlPattern, { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await context.storageState({ path: STATE_FILE });

    return STATE_FILE;
  } catch (err) {
    throw new Error(`Login failed: ${String(err.message).split('\n')[0]}`);
  } finally {
    // Always close the browser, even when login fails.
    await browser.close().catch(() => {});
  }
}

module.exports = { saveLogin, hasSavedLogin, STATE_FILE, requireEnv };
