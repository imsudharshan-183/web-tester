const { chromium } = require('playwright');
const { hasSavedLogin, STATE_FILE } = require('./auth');

const NAV_TIMEOUT = 30000;
const MAX_FIELD = 1000;

/**
 * Open a URL and read its title and meta description.
 * Returns { name, summary }. Either field may be an empty string.
 */
async function inspectSite(url) {
  const browser = await chromium.launch({ headless: true });

  try {
    // Reuse the saved login when one exists; cookies are domain-scoped.
    const context = await browser.newContext(
      (await hasSavedLogin()) ? { storageState: STATE_FILE } : {}
    );
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);

    const name = clean(await page.title());
    const summary = clean(await readMetaDescription(page));

    return { name: shorten(name, MAX_FIELD), summary: shorten(summary, MAX_FIELD) };
  } finally {
    // Always close Chromium, even when the page fails to load.
    await browser.close().catch(() => {});
  }
}

async function readMetaDescription(page) {
  try {
    const content = await page.locator('meta[name="description"]').first().getAttribute('content');
    return content || '';
  } catch {
    // No description tag, or the page changed while reading it.
    return '';
  }
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

module.exports = { inspectSite };
