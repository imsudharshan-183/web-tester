const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { hasSavedLogin, STATE_FILE, requireEnv } = require('./auth');
const { validateSteps } = require('./aiAgent');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts');
const STEP_TIMEOUT = 10000;

/**
 * Replay a saved recipe. This function never calls Gemini.
 */
async function runRecipe(filePath) {
  const recipe = JSON.parse(await fs.readFile(filePath, 'utf8'));

  if (!recipe || typeof recipe.url !== 'string') {
    throw new Error('Recipe is missing a URL.');
  }

  // Validate again because a recipe file can be edited by hand.
  const steps = validateSteps(recipe.steps);

  const checks = [];
  let screenshotPath = null;
  let errorMessage = null;
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(
      (await hasSavedLogin()) ? { storageState: STATE_FILE } : {}
    );
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Start every recipe from the saved URL.
    let response;
    try {
      response = await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
    } catch (navError) {
      errorMessage = firstLine(navError.message);
      checks.push({ name: 'Page loads', passed: false, detail: errorMessage });
      return { checks, screenshotPath, errorMessage, status: 'failed' };
    }

    const status = response ? response.status() : 0;
    checks.push({
      name: 'Page loads',
      passed: status >= 200 && status < 400,
      detail: response ? `HTTP ${status}` : 'No HTTP response received.',
    });

    // Stop after the first failed step so later failures do not cascade.
    let failed = false;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const name = describeStep(step);

      if (failed) {
        checks.push({ name, passed: false, detail: 'Skipped after an earlier failure.' });
        continue;
      }

      try {
        await executeStep(page, step);
        checks.push({ name, passed: true, detail: 'Passed.' });
      } catch (err) {
        failed = true;
        checks.push({ name, passed: false, detail: firstLine(err.message) });
      }
    }

    // Save a screenshot of the final state for review.
    try {
      await fs.mkdir(ARTIFACT_DIR, { recursive: true });
      screenshotPath = path.join(ARTIFACT_DIR, `recipe-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 15000 });
    } catch (shotError) {
      errorMessage = `Screenshot failed: ${firstLine(shotError.message)}`;
    }
  } catch (err) {
    errorMessage = firstLine(err.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  const passed =
    !errorMessage &&
    checks.length > 0 &&
    checks.every((check) => check.passed);

  return {
    checks,
    screenshotPath,
    errorMessage,
    status: passed ? 'passed' : 'failed',
  };
}

async function executeStep(page, step) {
  switch (step.action) {
    case 'fill':
      await page
        .getByLabel(step.label, { exact: false })
        .first()
        .fill(resolvePlaceholders(step.value));
      break;

    case 'click':
      await page
        .getByRole(step.role, { name: step.name, exact: false })
        .first()
        .click();
      break;

    case 'expectText':
      await page
        .getByText(step.text, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      break;

    case 'expectUrl':
      await page.waitForURL(new RegExp(step.pattern), { timeout: STEP_TIMEOUT });
      break;

    case 'press':
      await page.keyboard.press(step.key);
      break;

    default:
      throw new Error(`Unsupported action: ${step.action}`);
  }
}

// Credentials are swapped in only at run time. They never go to Gemini.
function resolvePlaceholders(value) {
  return String(value)
    .replace(/<(?:USERNAME|EMAIL)>/gi, () => requireEnv('TEST_USERNAME'))
    .replace(/<PASSWORD>/gi, () => requireEnv('TEST_PASSWORD'));
}

function describeStep(step) {
  switch (step.action) {
    case 'fill':
      return `Fill "${step.label}"`;
    case 'click':
      return `Click "${step.name}"`;
    case 'expectText':
      return `See "${step.text}"`;
    case 'expectUrl':
      return `URL matches ${step.pattern}`;
    case 'press':
      return `Press ${step.key}`;
    default:
      return step.action;
  }
}

function firstLine(message) {
  return String(message || 'Unknown error').split('\n')[0].slice(0, 300);
}

module.exports = { runRecipe };
