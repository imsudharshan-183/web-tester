const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts');
const CREATED_ACCOUNTS_PATH = path.join(ARTIFACT_DIR, 'created-test-accounts.json');
const POOLS_PATH = path.join(__dirname, '..', '..', 'config', 'test-data-pools.json');

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

/**
 * Generate a valid password complying with test-data-pools.json rules
 * (8+ chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 symbol)
 */
function generateValidPassword() {
  try {
    if (fs.existsSync(POOLS_PATH)) {
      const pools = JSON.parse(fs.readFileSync(POOLS_PATH, 'utf8'));
      if (pools.password && pools.password.generator) {
        const stamp = Date.now().toString().slice(-4);
        return pools.password.generator.replace('{timestamp}', stamp);
      }
    }
  } catch {}
  const stamp = Date.now().toString().slice(-4);
  return `InventCare!${stamp}Aa1`;
}

/**
 * Single source of truth: updates an existing entry or appends if new
 */
function updateAccountEntry(identifier, updates) {
  const list = readAccounts();
  let entry = null;

  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    const matchRunId = identifier.runId && String(item.runId) === String(identifier.runId);
    const matchEmail = identifier.email && item.email && item.email.toLowerCase() === identifier.email.toLowerCase();
    const matchName = identifier.name && item.name && item.name.toLowerCase() === identifier.name.toLowerCase();

    if (matchEmail || (matchRunId && matchName) || matchRunId) {
      entry = item;
      break;
    }
  }

  const stamp = new Date().toISOString();
  if (!entry) {
    entry = {
      runId: String(identifier.runId || ''),
      timestamp: stamp,
      entityType: identifier.entityType || (identifier.role ? 'team_member' : 'client'),
      pageUrl: identifier.pageUrl || '',
      role: identifier.role || '',
      email: identifier.email || '',
      password: identifier.password || null,
      name: identifier.name || '',
      phone: identifier.phone || '',
      status: updates.status || 'created',
    };
    list.push(entry);
  }

  Object.assign(entry, updates);
  if (!entry.updatedAt) entry.updatedAt = stamp;
  writeAccounts(list);
  return entry;
}

/**
 * Locate invite link on the current page or open modal
 */
async function findInviteLinkOnPage(page, account = {}) {
  try {
    return await page.evaluate((needles) => {
      function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      // 1. Check open modal/dialog first
      const modals = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open], .modal')).filter(isVisible);
      const scope = modals.length > 0 ? modals[modals.length - 1] : document.body;

      // Check <a> elements
      const links = Array.from(scope.querySelectorAll('a[href]')).filter(isVisible);
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (/(?:accept-invite|invite|token=|join|activate|auth\/invite)/i.test(href)) {
          try {
            return new URL(href, location.href).href;
          } catch {
            return href;
          }
        }
      }

      // Check input/textarea/code with link text
      const textEls = Array.from(scope.querySelectorAll('input, textarea, code, pre, span, p')).filter(isVisible);
      for (const el of textEls) {
        const val = (el.value || el.innerText || el.textContent || '').trim();
        const match = val.match(/https?:\/\/[^\s"']+(?:accept-invite|invite|token=[^\s"']+|activate|join)[^\s"']*/i);
        if (match) return match[0];
      }

      // Check button attributes
      const buttons = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible);
      for (const b of buttons) {
        for (const attr of ['data-clipboard-text', 'data-url', 'data-link', 'data-invite-url', 'data-href']) {
          const val = b.getAttribute(attr);
          if (val && /https?:\/\//i.test(val)) return val;
        }
        const text = (b.innerText || '').trim();
        if (/copy\s*(?:invite\s*)?link/i.test(text)) {
          const parentText = b.closest('div, p, form')?.innerText || '';
          const match = parentText.match(/https?:\/\/[^\s"']+/i);
          if (match) return match[0];
        }
      }

      // Check modal text for invite links
      const modalText = scope.innerText || '';
      const textMatch = modalText.match(/https?:\/\/[^\s"']+(?:accept-invite|invite|token=[a-zA-Z0-9_-]+|accept|join)[^\s"']*/i);
      if (textMatch) return textMatch[0];

      // Generic non-asset URL
      const genericUrls = modalText.match(/https?:\/\/[^\s"']+/g) || [];
      for (const u of genericUrls) {
        if (!/(?:vercel\.com|google|gstatic|w3\.org|schema\.org|\.png|\.svg|\.jpg|\.css|\.js)/i.test(u)) {
          return u;
        }
      }

      return null;
    }, [account.name, account.email].filter(Boolean));
  } catch (err) {
    console.warn('[findInviteLinkOnPage] error:', err.message);
    return null;
  }
}

/**
 * PART B: Open invite link in an ISOLATED browser context (no admin cookies),
 * set and confirm password, submit, verify activation, and update created-test-accounts.json.
 *
 * The InventCare /field/join/:token page rejects requests that carry the admin
 * session cookie (ic_refresh).  So we must open the link in a brand-new
 * BrowserContext, not context.newPage() which shares cookies.
 */
async function handleInviteActivation({ context, page, account = {}, runId = '' }) {
  // --- 1. Locate the invite link ------------------------------------------
  let inviteLink = account.inviteLink || null;

  // Try extracting from the confirmation dialog text on screen
  if (!inviteLink) {
    inviteLink = await findInviteLinkOnPage(page, account);
  }

  // If not found directly, check if a "Copy link" button exists
  if (!inviteLink) {
    const copyBtn = page.locator('button:has-text("Copy invite link"), button:has-text("Copy link")').first();
    if (await copyBtn.isVisible().catch(() => false)) {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
      await copyBtn.click().catch(() => {});
      await page.waitForTimeout(600);
      const clipboardText = await page.evaluate(() => navigator.clipboard ? navigator.clipboard.readText() : '').catch(() => '');
      if (clipboardText && /^https?:\/\//i.test(clipboardText)) {
        inviteLink = clipboardText.trim();
      }
      if (!inviteLink) {
        inviteLink = await findInviteLinkOnPage(page, account);
      }
    }
  }

  if (!inviteLink) {
    return {
      success: false,
      status: 'FAIL',
      detail: 'Could not locate invite link in DOM or confirmation modal',
    };
  }

  console.log(`[invite-activation] Opening invite link in ISOLATED context: ${inviteLink}`);

  // --- 2. Open the link in a FRESH browser context (no cookies) -----------
  const browser = context.browser();
  const isolatedCtx = await browser.newContext();
  const invitePage = await isolatedCtx.newPage();
  invitePage.setDefaultTimeout(25000);

  try {
    await invitePage.goto(inviteLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await invitePage.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    await invitePage.waitForTimeout(2000);

    // --- 3. Fill password fields ------------------------------------------
    // InventCare join page uses #password and #confirm
    let primaryField = invitePage.locator('#password').first();
    let confirmField = invitePage.locator('#confirm').first();

    // Fallback: generic password input detection
    if (!(await primaryField.isVisible().catch(() => false))) {
      const passLocators = invitePage.locator('input[type="password"]');
      const pCount = await passLocators.count().catch(() => 0);
      if (pCount >= 2) {
        primaryField = passLocators.nth(0);
        confirmField = passLocators.nth(1);
      } else if (pCount === 1) {
        primaryField = passLocators.nth(0);
        const altConfirm = invitePage.locator('input[name*="confirm" i], input[id*="confirm" i], input[placeholder*="confirm" i]').first();
        if (await altConfirm.isVisible().catch(() => false)) {
          confirmField = altConfirm;
        }
      } else {
        primaryField = invitePage.locator('input[placeholder*="password" i], input[name*="password" i]').first();
        confirmField = invitePage.locator('input[placeholder*="confirm" i], input[name*="confirm" i]').first();
      }
    }

    if (!primaryField || !(await primaryField.isVisible().catch(() => false))) {
      const pageText = await invitePage.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      return {
        success: false,
        status: 'FAIL',
        detail: `Opened invite page (${invitePage.url()}) but password fields were not found. Page text: ${pageText.slice(0, 300)}`,
        inviteLink,
      };
    }

    // Generate valid password from test-data-pools.json
    const newPassword = generateValidPassword();
    console.log(`[invite-activation] Filling password (length ${newPassword.length}) into #password and #confirm`);
    await primaryField.fill(newPassword);

    if (confirmField && (await confirmField.isVisible().catch(() => false))) {
      await confirmField.fill(newPassword);
    }

    // --- 4. Submit the activation form ------------------------------------
    const submitBtn = invitePage.locator(
      'button[type="submit"], button:has-text("Set password"), button:has-text("Activate"), button:has-text("Save"), button:has-text("Create account"), button:has-text("Continue")'
    ).first();

    if (await submitBtn.isVisible().catch(() => false)) {
      console.log(`[invite-activation] Clicking submit: "${await submitBtn.innerText().catch(() => '?')}"`);
      await submitBtn.click();
      // Wait for navigation or confirmation
      await invitePage.waitForTimeout(4000);
    }

    // --- 5. Verify activation succeeded -----------------------------------
    const finalUrl = invitePage.url();
    const finalBodyText = (await invitePage.evaluate(() => document.body ? document.body.innerText : '')).replace(/\s+/g, ' ');
    console.log(`[invite-activation] Final URL: ${finalUrl}`);
    console.log(`[invite-activation] Final page text (first 300): ${finalBodyText.slice(0, 300)}`);

    const isActivated =
      /field\/login|field$|admin|dashboard/i.test(finalUrl) ||
      /(password (?:set|saved|updated)|account activated|welcome|sign ?in|success|signed in)/i.test(finalBodyText);

    // Also check on the original admin page (team list) if possible
    let listVerified = false;
    if (account && account.name) {
      try {
        await page.goto('https://invent-ui.vercel.app/admin/team', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const teamBody = (await page.evaluate(() => document.body ? document.body.innerText : '')).replace(/\s+/g, ' ');
        // After activation the status changes from "Invite sent" to "Active"
        if (teamBody.includes(account.name) && !/Invite sent/.test(teamBody.split(account.name)[1]?.slice(0, 80) || '')) {
          listVerified = true;
        }
      } catch {}
    }

    if (!isActivated && !listVerified) {
      return {
        success: false,
        status: 'FAIL',
        detail: `Submitted activation form but could not confirm activation on screen (URL: ${finalUrl}, text: ${finalBodyText.slice(0, 200)})`,
        inviteLink,
      };
    }

    // --- 6. Update single source of truth ---------------------------------
    const updated = updateAccountEntry(
      { runId, email: account.email, name: account.name, role: account.role, entityType: 'team_member' },
      {
        status: 'activated',
        password: newPassword,
        inviteLink,
        activatedAt: new Date().toISOString(),
      }
    );

    return {
      success: true,
      status: 'PASS',
      detail: `Invite link activated in isolated tab; password set and account verified active (${account.name || account.email})`,
      inviteLink,
      password: newPassword,
      account: updated,
    };
  } finally {
    await invitePage.close().catch(() => {});
    await isolatedCtx.close().catch(() => {});
  }
}

/**
 * PART C: Verify an account still works by attempting login
 */
async function verifyAccountLogin(page, email, password) {
  if (!email || !password) return false;
  try {
    const loginUrl = 'https://invent-ui.vercel.app/admin/login';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const emailField = page.locator('#email, input[type="email"], input[name="email"]').first();
    const passField = page.locator('#password, input[type="password"], input[name="password"]').first();
    const submitBtn = page.getByRole('button', { name: /sign ?in|log ?in/i }).first();

    if (!(await emailField.isVisible().catch(() => false))) return false;

    await emailField.fill(email);
    await passField.fill(password);
    await submitBtn.click();
    await page.waitForTimeout(3500);

    const currentUrl = page.url();
    const bodyText = (await page.evaluate(() => document.body ? document.body.innerText : '')).replace(/\s+/g, ' ');

    // If redirected to /admin or dashboard without error
    const success =
      /\/admin/i.test(currentUrl) &&
      !/login/i.test(currentUrl) &&
      !/(invalid (?:credentials|email|password)|authentication failed|unauthorized)/i.test(bodyText);

    return success;
  } catch (err) {
    console.warn(`[verifyAccountLogin] failed for ${email}:`, err.message);
    return false;
  }
}

/**
 * PART C: Check created-test-accounts.json for an existing "activated" account
 * to reuse instead of always creating a new one.
 * Verifies it still works before returning it; if failed, marks "stale_or_invalid".
 */
async function findReusableActivatedAccount({ role = '', page = null } = {}) {
  const accounts = readAccounts();
  const roleLower = String(role || '').toLowerCase();

  // Find activated accounts with password
  const candidates = accounts.filter((a) => {
    if (a.status !== 'activated') return false;
    if (!a.email || !a.password) return false;
    if (roleLower && a.role && !a.role.toLowerCase().includes(roleLower) && !roleLower.includes(a.role.toLowerCase())) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    console.log(`[credential-reuse] Found candidate activated account: ${candidate.email} (${candidate.role || 'no role'})`);

    // Verify it still works if page is provided
    let isValid = true;
    if (page) {
      isValid = await verifyAccountLogin(page, candidate.email, candidate.password);
    }

    if (isValid) {
      console.log(`[credential-reuse] Candidate ${candidate.email} is active and verified.`);
      candidate.lastReusedAt = new Date().toISOString();
      writeAccounts(accounts);
      return candidate;
    } else {
      console.warn(`[credential-reuse] Candidate ${candidate.email} failed verification; marking stale_or_invalid`);
      candidate.status = 'stale_or_invalid';
      candidate.staleReason = 'Login verification failed on attempt to reuse';
      candidate.staleAt = new Date().toISOString();
      writeAccounts(accounts);
    }
  }

  return null;
}

module.exports = {
  CREATED_ACCOUNTS_PATH,
  readAccounts,
  writeAccounts,
  generateValidPassword,
  updateAccountEntry,
  findInviteLinkOnPage,
  handleInviteActivation,
  verifyAccountLogin,
  findReusableActivatedAccount,
};
