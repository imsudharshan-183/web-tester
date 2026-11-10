const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { hasSavedLogin, STATE_FILE } = require('./auth');

const NAV_TIMEOUT = 30000;
const LINK_TIMEOUT = 10000;
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts');

/**
 * Test one URL in a real browser.
 * Returns { checks, screenshotPath, errorMessage }.
 */
async function runChecks(url, runId) {
  const checks = [];
  let screenshotPath = null;
  let errorMessage = null;
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });

    // Reuse the saved login session when one exists.
    const context = await browser.newContext(
      (await hasSavedLogin()) ? { storageState: STATE_FILE } : {}
    );
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // Collect console errors and uncaught page errors while the page runs.
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    // 1. Load the page with domcontentloaded so heavy asset streams don't stall navigation.
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1000);
    } catch (navError) {
      errorMessage = firstLine(navError.message);
      checks.push({ name: 'Page loads', passed: false, detail: errorMessage });

      for (const name of ['Has a title', 'No console errors', 'Page has visible content', 'Links work']) {
        checks.push({ name, passed: false, detail: 'Skipped because the page did not load.' });
      }

      return { checks, screenshotPath, errorMessage };
    }

    const status = response ? response.status() : 0;
    checks.push({
      name: 'Page loads',
      passed: status >= 200 && status < 400,
      detail: response ? `HTTP ${status}` : 'No HTTP response received.',
    });

    // 2. Title.
    let title = '';
    try {
      title = (await page.title()).trim();
    } catch {
      // Leave the title empty if the page went away.
    }
    checks.push({
      name: 'Has a title',
      passed: title.length > 0,
      detail: title ? `Title: "${shorten(title, 120)}"` : 'The page has no title.',
    });

    // This object is filled in after the screenshot, so late errors are included.
    const consoleCheck = { name: 'No console errors', passed: false, detail: '' };
    checks.push(consoleCheck);

    // 3. Visible text.
    let visibleText = '';
    try {
      visibleText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    } catch {
      // An empty string simply fails the check.
    }
    visibleText = String(visibleText || '').replace(/\s+/g, ' ').trim();
    checks.push({
      name: 'Page has visible content',
      passed: visibleText.length > 0,
      detail: visibleText.length
        ? `${visibleText.length} characters of visible text.`
        : 'No visible text was found on the page.',
    });

    // 4. Find up to 10 links and test each one.
    let links = [];
    try {
      links = await page.evaluate(() => {
        const urls = [];
        const seen = new Set();

        for (const anchor of document.querySelectorAll('a[href]')) {
          try {
            const href = new URL(anchor.getAttribute('href'), document.baseURI).href;
            if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
            seen.add(href);
            urls.push(href);
            if (urls.length === 10) break;
          } catch {
            // Ignore links that are not valid URLs.
          }
        }

        return urls;
      });
    } catch {
      // Treat a failure to read links as "no links found".
    }

    const linkResults = await Promise.all(links.map(checkLink));
    const broken = linkResults.filter((result) => result.broken);

    let linkDetail = 'No links found on the page.';
    if (links.length > 0) {
      linkDetail = broken.length
        ? `Checked ${links.length} link(s), ${broken.length} broken: ${broken
            .slice(0, 3)
            .map((result) => `${result.href} (${result.status || result.error || 'network error'})`)
            .join(' | ')}`
        : `Checked ${links.length} link(s), all working.`;
    }

    checks.push({
      name: 'Links work',
      passed: broken.length === 0,
      detail: shorten(linkDetail, 400),
    });

    // 5. Save a full-page screenshot.
    try {
      await fs.mkdir(ARTIFACT_DIR, { recursive: true });
      const fileName = `${runId}.png`;
      await page.screenshot({
        path: path.join(ARTIFACT_DIR, fileName),
        fullPage: true,
        timeout: 15000,
      });
      screenshotPath = `/artifacts/${fileName}`;
    } catch (shotError) {
      errorMessage = `Screenshot failed: ${firstLine(shotError.message)}`;
    }

    // 6. Finish the console check using everything collected so far.
    consoleCheck.passed = consoleErrors.length === 0;
    consoleCheck.detail = consoleErrors.length
      ? `${consoleErrors.length} console error(s): ${consoleErrors
          .slice(0, 3)
          .map((message) => shorten(message, 120))
          .join(' | ')}`
      : 'No console errors.';

    return { checks, screenshotPath, errorMessage };
  } catch (err) {
    // Browser crash, launch failure, or anything unexpected.
    errorMessage = firstLine(err.message);
    return { checks, screenshotPath, errorMessage };
  } finally {
    // Always close Chromium, even when a check failed.
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// Try HEAD first, then GET for servers that do not allow HEAD.
async function checkLink(href) {
  try {
    const headStatus = await requestStatus(href, 'HEAD');
    if (headStatus < 400) {
      return { href, status: headStatus, broken: false };
    }

    const getStatus = await requestStatus(href, 'GET');
    return { href, status: getStatus, broken: getStatus >= 400 };
  } catch {
    try {
      const status = await requestStatus(href, 'GET');
      return { href, status, broken: status >= 400 };
    } catch (error) {
      return {
        href,
        status: null,
        broken: true,
        error: error.name === 'TimeoutError' ? 'timed out' : 'network error',
      };
    }
  }
}

async function requestStatus(href, method) {
  const response = await fetch(href, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(LINK_TIMEOUT),
    headers: { 'User-Agent': 'web-tester/1.0' },
  });

  // We only need the status code, so stop downloading the body.
  if (response.body) {
    await response.body.cancel().catch(() => {});
  }

  return response.status;
}

function firstLine(message) {
  return String(message || 'Unknown error')
    .split('\n')[0]
    .slice(0, 300);
}

function shorten(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

module.exports = { runChecks };
