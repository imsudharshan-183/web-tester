const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { hasSavedLogin, STATE_FILE } = require('./auth');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts');
const CREATED_ACCOUNTS_PATH = path.join(ARTIFACT_DIR, 'created-test-accounts.json');
const DEFAULT_CLEANUP_TIMEOUT_MS = 30000;

// Statuses written to created-test-accounts.json. These mean different things
// and must not be conflated:
//   cleaned                               - record removed or deactivated
//   cleanup_unsupported_pending_invite    - UI exposes no control for an unopened invite
//   cleanup_unsupported_completed_record  - read-only or completed record
//   cleanup_unsupported_no_delete_control - entity type exposes no delete/deactivate in UI
//   cleanup_failed                        - an actual error / control not found
//   cleanup_failed_timeout                - hard 30s deadline exceeded
//   cleanup_skipped                       - no created record to clean up

function readAccounts() {
  try {
    if (!fs.existsSync(CREATED_ACCOUNTS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(CREATED_ACCOUNTS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAccounts(list) {
  fs.mkdirSync(path.dirname(CREATED_ACCOUNTS_PATH), { recursive: true });
  fs.writeFileSync(CREATED_ACCOUNTS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

// Latest created-account entry for a run (the one cleanup should act on).
function getLatestAccountForRun(runId) {
  const list = readAccounts();
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i].runId) === String(runId)) return list[i];
  }
  return null;
}

// Update the existing entry's status instead of adding a new logging mechanism.
function updateAccountStatus(runId, status, extra = {}) {
  const list = readAccounts();
  let entry = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i].runId) === String(runId)) {
      entry = list[i];
      break;
    }
  }

  const stamp = new Date().toISOString();
  if (!entry) {
    entry = {
      runId: String(runId),
      timestamp: stamp,
      entityType: extra.entityType || 'entity',
      pageUrl: '',
      role: '',
      email: '',
      password: null,
      name: '',
      phone: '',
      status,
    };
    list.push(entry);
  }

  entry.status = status;
  entry.cleanup = { status, timestamp: stamp, ...extra };
  writeAccounts(list);
  return entry;
}

// Hard overall deadline. The underlying work is abandoned when this rejects.
function withTimeout(promise, ms, label = 'cleanup_failed_timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deriveListUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

// Ensure the cleanup page is authenticated before trying to find the record.
async function ensureLoggedIn(page, targetUrl) {
  const emailField = page.locator('#email, input[type="email"], input[name="email"]').first();
  await emailField.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  const onLogin = await emailField.isVisible().catch(() => false);
  if (!onLogin) return;
  const email = process.env.TEST_USERNAME;
  const password = process.env.TEST_PASSWORD;
  if (!email || !password) return;
  await emailField.fill(email).catch(() => {});
  await page.locator('#password, input[type="password"]').first().fill(password).catch(() => {});
  await page
    .getByRole('button', { name: /sign ?in|log ?in/i })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(5000);
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

// Best-effort UI cleanup: find the new record, trigger its delete/deactivate
// control, confirm, then check the list no longer shows it as active.
// Generalized across any entity type: team member, client, property, visit, task.
async function cleanupCreatedRecord(page, account) {
  const needles = [
    account.name,
    account.propertyName,
    account.title,
    account.email,
    account.phone,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  if (needles.length === 0) {
    return { status: 'cleanup_failed', detail: 'No name, title, or email recorded for the created record' };
  }

  const listUrl = deriveListUrl(account.pageUrl);
  if (listUrl) {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await ensureLoggedIn(page, listUrl);
  }

  // Wait for the record to appear in the rendered page
  const appeared = await page
    .waitForFunction(
      (texts) => {
        const body = document.body ? document.body.innerText : '';
        return texts.some((t) => body.includes(t));
      },
      needles,
      { timeout: 10000 }
    )
    .then(() => true)
    .catch(() => false);

  const needle = needles[0];
  console.log(`[cleanup] looking for "${needle}" at ${page.url()} (appeared: ${appeared})`);

  if (!appeared) {
    return {
      status: 'cleanup_failed',
      detail: `Could not find a record containing "${needle}" (page: ${page.url()})`,
    };
  }

  // Anchor to exactly one row/card containing this record's name.
  // Support team tables (div.border-t), table rows (tr), lists (li), grid cards (.card, article, div.rounded-lg)
  let row = page.locator('div.border-t').filter({ hasText: needle });
  let rowCount = await row.count().catch(() => 0);
  if (rowCount === 0) {
    row = page.locator('tr, li, [role="row"], [role="listitem"]').filter({ hasText: needle });
    rowCount = await row.count().catch(() => 0);
  }
  if (rowCount === 0) {
    row = page.locator('.card, article, div.rounded-lg, div.p-4').filter({ hasText: needle });
    rowCount = await row.count().catch(() => 0);
  }

  // If multiple matching rows and we have a secondary needle (e.g. email or phone), refine
  if (rowCount > 1 && needles.length > 1) {
    for (let i = 1; i < needles.length; i++) {
      const refined = row.filter({ hasText: needles[i] });
      const refinedCount = await refined.count().catch(() => 0);
      if (refinedCount === 1) {
        row = refined;
        rowCount = 1;
        break;
      }
    }
  }

  if (rowCount !== 1) {
    return {
      status: 'cleanup_failed',
      detail: `Expected exactly one row for "${needle}" but found ${rowCount}; refusing to act to avoid touching another record.`,
    };
  }
  row = row.first();

  const actionRe = /^\s*(deactivate|delete|remove|archive|disable|revoke|cancel)\b/i;

  // Scope every lookup to this row (or the dialog opened from it). Never a page-wide lookup.
  const findAction = async (scope) => {
    const btn = scope.getByRole('button', { name: actionRe }).first();
    if (await btn.isVisible().catch(() => false)) return btn;
    const link = scope.locator('a, button, [role="button"]').filter({ hasText: actionRe }).first();
    return (await link.isVisible().catch(() => false)) ? link : null;
  };

  const rowTextNow = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  if (/(deactivated|inactive|archived|disabled|removed|closed)/i.test(rowTextNow)) {
    return { status: 'cleaned', detail: `Record "${needle}" is already deactivated/inactive` };
  }

  let action = await findAction(row);

  if (!action) {
    const editor = row.getByRole('button', { name: /edit|open|manage|view|details/i }).first();
    if (await editor.isVisible().catch(() => false)) {
      await editor.click().catch(() => {});
    } else {
      await row.click().catch(() => {});
    }
    await page.waitForTimeout(1500);

    const dialog = page.locator('[role="dialog"], [aria-modal="true"], dialog[open]').last();
    const dialogOpen = await dialog.isVisible().catch(() => false);
    const dialogText = dialogOpen
      ? ((await dialog.innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
      : '';
    // Only trust a dialog that belongs to THIS record (contains the needle)
    const dialogBelongsToRecord = dialogOpen && needles.some((n) => dialogText.includes(n));

    // Still strictly scoped: only this record's dialog, then this row.
    action =
      (dialogBelongsToRecord ? await findAction(dialog) : null) || (await findAction(row));

    if (!action) {
      const allText = `${rowTextNow} ${dialogBelongsToRecord ? dialogText : ''}`;

      if (/(invite (?:sent|not opened)|invited|pending invite)/i.test(allText)) {
        return {
          status: 'cleanup_unsupported_pending_invite',
          detail: `Record "${needle}" is a pending invite. This UI exposes no delete/revoke/deactivate control until the invite is accepted (only "Resend invite" and "Edit").`,
        };
      }
      if (/(completed|closed|read-?only|view only)/i.test(allText)) {
        return {
          status: 'cleanup_unsupported_completed_record',
          detail: `Record "${needle}" is read-only or completed. This UI exposes no delete control.`,
        };
      }
      return {
        status: 'cleanup_unsupported_no_delete_control',
        detail: `Record "${needle}" (${account.entityType || 'entity'}) has no delete, archive, or deactivate control exposed in this UI.`,
      };
    }
  }

  await action.click().catch(() => {});
  await page.waitForTimeout(800);

  // Confirm only inside a dialog. Never fall back to a page-wide lookup.
  const confirmDialog = page.locator('[role="dialog"], [aria-modal="true"], dialog[open]').last();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirm = confirmDialog
      .getByRole('button', { name: /^\s*(confirm|yes|ok|deactivate|delete|remove|proceed)\b/i })
      .last();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // Verify the record is gone, or at least no longer active.
  await page.waitForTimeout(1500);
  const rowsAfter = page.locator('div.border-t, tr, li, .card, article').filter({ hasText: needle });
  const remaining = await rowsAfter.count().catch(() => 0);
  if (remaining === 0) {
    return { status: 'cleaned', detail: `Removed "${needle}"` };
  }

  const rowTextAfter = ((await rowsAfter.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  if (/(deactivated|inactive|archived|disabled|removed)/i.test(rowTextAfter)) {
    return { status: 'cleaned', detail: `Deactivated "${needle}"` };
  }

  return { status: 'cleanup_failed', detail: `Record "${needle}" is still active after the cleanup attempt` };
}

// Run cleanup on an already-open page, always bounded by the hard deadline and
// always logged. Never throws, so it can never block a test response.
async function runCleanupWithTimeout({ page, account, runId, timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS }) {
  try {
    const result = await withTimeout(cleanupCreatedRecord(page, account), timeoutMs);
    updateAccountStatus(runId, result.status, { detail: result.detail, timeoutMs, entityType: account.entityType });
    return result;
  } catch (err) {
    const timedOut = /cleanup_failed_timeout/.test(String(err && err.message));
    const status = timedOut ? 'cleanup_failed_timeout' : 'cleanup_failed';
    const detail = String((err && err.message) || err).slice(0, 300);
    updateAccountStatus(runId, status, { detail, timeoutMs, entityType: account.entityType });
    return { status, detail };
  }
}

// Endpoint variant: open its own browser/context/page using the saved login,
// with the entire lifecycle (launch included) under the hard deadline.
async function runCleanupStandalone({ runId, account, timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS }) {
  let browser = null;
  try {
    const work = (async () => {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext(
        (await hasSavedLogin()) ? { storageState: STATE_FILE } : {}
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      return cleanupCreatedRecord(page, account);
    })();

    const result = await withTimeout(work, timeoutMs);
    updateAccountStatus(runId, result.status, { detail: result.detail, timeoutMs, entityType: account.entityType });
    return result;
  } catch (err) {
    const timedOut = /cleanup_failed_timeout/.test(String(err && err.message));
    const status = timedOut ? 'cleanup_failed_timeout' : 'cleanup_failed';
    const detail = String((err && err.message) || err).slice(0, 300);
    updateAccountStatus(runId, status, { detail, timeoutMs, entityType: account.entityType });
    return { status, detail };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  CREATED_ACCOUNTS_PATH,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  getLatestAccountForRun,
  updateAccountStatus,
  withTimeout,
  cleanupCreatedRecord,
  runCleanupWithTimeout,
  runCleanupStandalone,
};
