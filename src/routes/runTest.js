const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { chromium } = require('playwright');
const { faker, allFakers } = require('@faker-js/faker');
const { validateUrl } = require('../services/urlSafety');
const { TestRun } = require('../models/dbAdapter');
const { hasSavedLogin, STATE_FILE } = require('../services/auth');
const { getLatestAccountForRun, runCleanupWithTimeout } = require('../services/cleanup');
const {
  generateValidPassword,
  updateAccountEntry,
  findInviteLinkOnPage,
  handleInviteActivation,
  findReusableActivatedAccount,
} = require('../services/accountManager');

const router = express.Router();
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts');
const UPLOAD_DIR = path.join(ARTIFACT_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Field-testing context: rules file, field knowledge, created-account log
// ---------------------------------------------------------------------------
const FIELD_RULES_PATH = path.join(__dirname, '..', '..', 'config', 'field-testing-rules.json');
const FIELD_KNOWLEDGE_PATH = path.join(ARTIFACT_DIR, 'field-knowledge.json');
const CREATED_ACCOUNTS_PATH = path.join(ARTIFACT_DIR, 'created-test-accounts.json');

const MODAL_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  'dialog[open]',
  '[aria-modal="true"]',
  '.modal',
  '.modal-dialog',
  '.modal-content',
  '.MuiDialog-paper',
  '.ant-modal-content',
  '.ant-drawer-content',
  '.drawer',
  '.offcanvas',
  '.side-panel',
].join(', ');

let currentRunId = '';
let lastCapturedInviteLink = null;
let cachedFieldRules = null;

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadFieldRules() {
  if (cachedFieldRules) return cachedFieldRules;
  cachedFieldRules = readJsonFile(FIELD_RULES_PATH, { fieldTypes: {}, passFailLogic: '' });
  return cachedFieldRules;
}

function hintMatches(text, hint) {
  const h = String(hint || '').toLowerCase();
  if (!h) return false;
  if (h.length <= 4) {
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
  }
  return text.includes(h);
}

// Map a field's label/name/placeholder/id/type to one of the rules file types.
function inferFieldType(hint) {
  const text = String(hint || '').toLowerCase();
  if (!text) return '';
  if (/\b(e-?mail)\b/.test(text)) return 'email';
  if (/\b(phone|mobile|tel|whatsapp|telephone)\b/.test(text) || /contact\s*(number|no)/.test(text)) return 'phone';
  if (/(confirm|re-?enter|retype|repeat)\s*(new\s*)?password/.test(text)) return 'confirmPassword';
  if (/\b(password|passcode)\b/.test(text) || /\bpin\b/.test(text)) return 'password';
  if (/\b(date|dob|expiry|due)\b/.test(text)) return 'date';
  if (/\b(amount|quantity|age|count)\b/.test(text)) return 'numeric';

  const types = loadFieldRules().fieldTypes || {};
  for (const [type, def] of Object.entries(types)) {
    if ((def.matchHints || []).some((h) => hintMatches(text, h))) return type;
  }
  return '';
}

function buildFieldRulesPrompt() {
  const rules = loadFieldRules();
  const lines = [];
  for (const [type, def] of Object.entries(rules.fieldTypes || {})) {
    const cases = (def.testCases || [])
      .slice(0, 5)
      .map((c) => `${c.case}:"${c.input === null ? '(none)' : c.input}"->${c.expect}`)
      .join('; ');
    lines.push(`- ${type} [${(def.matchHints || []).join(', ')}]: ${def.validRule} Tests: ${cases}`);
  }
  return `Field-testing rules (match label/name/placeholder/id/type against the bracketed hints):
${lines.join('\n')}
Coverage: ${rules.minimumTestCasesPerField || ''}
Pass/fail: ${rules.passFailLogic || ''}`;
}

function normalizePageUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search || ''}`;
  } catch {
    return String(url || '');
  }
}

function loadFieldKnowledge() {
  const data = readJsonFile(FIELD_KNOWLEDGE_PATH, []);
  return Array.isArray(data) ? data : [];
}

function rememberFieldKnowledge(pageUrl, selector, inferredType) {
  if (!selector || !inferredType) return;
  try {
    const list = loadFieldKnowledge();
    const url = normalizePageUrl(pageUrl);
    const now = new Date().toISOString();
    const existing = list.find((e) => e.pageUrl === url && e.selector === selector);
    if (existing) {
      existing.inferredType = inferredType;
      existing.lastConfirmed = now;
    } else {
      list.push({ pageUrl: url, selector, inferredType, lastConfirmed: now });
    }
    writeJsonFile(FIELD_KNOWLEDGE_PATH, list);
  } catch (e) {
    console.warn('Field knowledge write warning:', e.message);
  }
}

function buildFieldKnowledgePrompt(pageUrl) {
  const url = normalizePageUrl(pageUrl);
  const known = loadFieldKnowledge()
    .filter((e) => e.pageUrl === url)
    .slice(-25);
  if (known.length === 0) return '';
  return `Known field mappings for this exact page (reuse these types, do not re-infer):
${known.map((e) => `- ${e.selector} -> ${e.inferredType}`).join('\n')}`;
}

function loadCreatedAccounts() {
  const data = readJsonFile(CREATED_ACCOUNTS_PATH, []);
  return Array.isArray(data) ? data : [];
}

function appendCreatedAccount(entry) {
  try {
    const full = {
      runId: currentRunId,
      timestamp: new Date().toISOString(),
      entityType: entry.entityType || (entry.role ? 'team_member' : 'client'),
      pageUrl: entry.pageUrl || '',
      role: entry.role || '',
      email: entry.email || '',
      password: entry.password || null,
      name: entry.name || '',
      phone: entry.phone || '',
      status: entry.status || 'created',
    };
    return updateAccountEntry(
      { runId: currentRunId, email: full.email, name: full.name, entityType: full.entityType },
      full
    );
  } catch (e) {
    console.warn('Created-account write warning:', e.message);
    return null;
  }
}

// Return the topmost visible modal/dialog locator, if one is open.
async function getOpenModalLocator(page) {
  const locators = page.locator(MODAL_SELECTOR);
  const count = await locators.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const candidate = locators.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }

  // Fallback for custom overlays without ARIA/modal classes: tag the topmost
  // visible fixed/absolute container that actually holds form controls.
  try {
    const tagged = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const minArea = window.innerWidth * window.innerHeight * 0.08;
      let best = null;
      let bestZ = -1;
      for (const el of document.querySelectorAll('div, aside, section, form')) {
        if (!visible(el)) continue;
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;
        const z = Number.parseInt(style.zIndex, 10);
        if (!Number.isFinite(z) || z <= 0) continue;
        if (!el.querySelector('input, textarea, select')) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < minArea) continue;
        if (z >= bestZ) {
          best = el;
          bestZ = z;
        }
      }
      if (best) {
        best.setAttribute('data-agent-modal', '1');
        return true;
      }
      return false;
    });
    if (tagged) return page.locator('[data-agent-modal="1"]').first();
  } catch {}

  return null;
}

// List the controls available inside the open modal so a mis-targeted action
// gets an actionable error instead of silently clicking the background.
async function listModalControls(modal) {
  try {
    const items = await modal.evaluate((m) => {
      function visible(el) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const out = [];
      for (const el of m.querySelectorAll('button, [role="button"], input[type="submit"]')) {
        if (!visible(el)) continue;
        const t = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
        if (t) out.push(`button "${t.slice(0, 40)}"`);
      }
      for (const el of m.querySelectorAll('input, textarea, select')) {
        if (!visible(el)) continue;
        const id = el.id ? `#${el.id}` : '';
        const ph = el.getAttribute('placeholder');
        out.push(`field ${id}${ph ? ` placeholder="${ph}"` : ''}`.trim());
      }
      return out.slice(0, 15);
    });
    return items.join(', ') || '(none found)';
  } catch {
    return '(unavailable)';
  }
}

// Prefer an element inside the open modal over a same-named background control.
// This prevents clicking the background "Add person" button after the form opens.
// In strict mode (used by click/fill/select), a target that is missing from the
// modal fails fast with the modal's own controls listed, so the planner cannot
// keep looping on the opener behind the overlay.
async function resolveActionLocator(page, selector, options = {}) {
  const modal = await getOpenModalLocator(page);
  if (modal) {
    const scoped = modal.locator(selector);
    const count = await scoped.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = scoped.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    if (options.strictModal) {
      const controls = await listModalControls(modal);
      throw new Error(
        `Target "${selector}" is not inside the open modal, so it will not be clicked. ` +
          `Do NOT use the background control that opened the modal. ` +
          `Available modal controls: ${controls}`
      );
    }
  }
  return page.locator(selector).first();
}

async function getFieldMeta(locator) {
  return locator
    .evaluate((el) => {
      function labelOf(node) {
        if (node.labels && node.labels[0]) {
          return (node.labels[0].innerText || node.labels[0].textContent || '').trim().replace(/\s+/g, ' ');
        }
        const aria = node.getAttribute('aria-label');
        if (aria) return aria.trim();
        const g = node.closest('label, .form-group, .field, .form-field, .ant-form-item, .MuiFormControl-root');
        const l = g && g.querySelector('label, .label, .ant-form-item-label, .MuiFormLabel-root');
        return l ? (l.innerText || l.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }
      return {
        label: labelOf(el),
        placeholder: el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        type: el.type || el.tagName.toLowerCase(),
      };
    })
    .catch(() => null);
}

async function captureFormSnapshot(page) {
  try {
    return await page.evaluate((modalSelector) => {
      function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function labelOf(el) {
        if (el.labels && el.labels[0]) {
          return (el.labels[0].innerText || el.labels[0].textContent || '').trim().replace(/\s+/g, ' ');
        }
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
        const g = el.closest('label, .form-group, .field, .form-field, .ant-form-item, .MuiFormControl-root');
        const l = g && g.querySelector('label, .label, .ant-form-item-label, .MuiFormLabel-root');
        return l ? (l.innerText || l.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }

      const modals = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
      const modal = modals.length > 0 ? modals[modals.length - 1] : null;
      if (!modal) return { pageUrl: location.href, modalOpen: false, fields: [] };

      const skipTypes = new Set(['hidden', 'submit', 'button', 'reset', 'file']);
      const fields = [];
      for (const el of Array.from(modal.querySelectorAll('input, textarea, select'))) {
        if (!isVisible(el) || el.disabled) continue;
        if (skipTypes.has(el.type)) continue;
        let value = el.value || '';
        if (el.tagName.toLowerCase() === 'select') {
          const opt = el.options[el.selectedIndex];
          value = opt ? (opt.textContent || '').trim() : value;
        }
        fields.push({
          label: labelOf(el),
          name: el.getAttribute('name') || '',
          id: el.id || '',
          placeholder: el.getAttribute('placeholder') || '',
          type: el.type || el.tagName.toLowerCase(),
          value: String(value || '').trim(),
        });
      }
      return {
        pageUrl: location.href,
        modalOpen: true,
        modalText: (modal.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
        roleText: (() => {
          const roleBtn = modal.querySelector('[id*="role" i], [aria-label*="role" i], [name*="role" i]');
          return roleBtn ? (roleBtn.innerText || roleBtn.value || '').trim().replace(/\s+/g, ' ') : '';
        })(),
        fields,
      };
    }, MODAL_SELECTOR);
  } catch {
    return { pageUrl: page.url(), modalOpen: false, fields: [] };
  }
}

async function detectSubmitSuccess(page, before) {
  try {
    return await page.evaluate(
      ({ before, modalSelector }) => {
        function isVisible(el) {
          if (!el) return false;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
        const SUCCESS =
          /(added as|successfully (?:added|created|invited|saved)|invite (?:for|sent)|invitation (?:sent|for)|link (?:has been )?sent|has been added|new (?:staff|member|client|user) added|account (?:is )?(?:active|created|ready))/i;
        const ERROR =
          /(already (?:has|exists|used)|is required|invalid|error|failed|cannot|can't|not allowed|duplicate)/i;

        const modals = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
        const modalOpen = modals.length > 0;
        const modalNow = modals.length > 0 ? modals[modals.length - 1] : null;
        const modalText = modalNow ? (modalNow.innerText || '').replace(/\s+/g, ' ').trim() : '';
        const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
        const segments = text.split(/\n|\s\|\s/).map((s) => s.trim()).filter(Boolean);

        // The create form and a confirmation modal are different dialogs. When
        // the submit succeeds, the form's fields disappear and a confirmation
        // ("Done", "Invite for ...", a login link) replaces them.
        const beforeIds = (before.fields || []).map((f) => f.id).filter(Boolean);
        const formFieldsGone =
          before.modalOpen &&
          Boolean(modalNow) &&
          beforeIds.length > 0 &&
          beforeIds.every((id) => {
            try {
              return !modalNow.querySelector('#' + CSS.escape(id));
            } catch {
              return true;
            }
          });
        const createSubmitStillThere = /add (?:and send invite|client and send invite)|create|save/i.test(modalText);
        const confirmationModal = formFieldsGone && !createSubmitStillThere;

        const successLine = confirmationModal
          ? modalText.slice(0, 180) || 'confirmation modal'
          : segments.find((s) => s.length < 220 && SUCCESS.test(s));
        const errorLine = segments.find((s) => s.length < 220 && ERROR.test(s));
        const modalClosed = before.modalOpen && !modalOpen;
        const navigatedToDetail =
          location.href !== before.pageUrl && /\/[a-z-]+\/[a-z0-9-]{6,}(?:\?|$)/i.test(location.href);

        const succeeded =
          Boolean(successLine) || modalClosed || navigatedToDetail || confirmationModal;
        const evidence = successLine
          ? successLine
          : modalClosed
            ? 'form/modal closed after submit'
            : navigatedToDetail
              ? `navigated to ${location.href}`
              : '';
        return { succeeded: succeeded && !errorLine, evidence };
      },
      { before, modalSelector: MODAL_SELECTOR }
    );
  } catch {
    return { succeeded: false, evidence: '' };
  }
}

// A post-submit confirmation dialog (for example "Invite for ..." with a
// read-only login link) replaces the create form. Clicking submit there again
// would create a duplicate record, so the click action must refuse.
async function detectConfirmationModal(page) {
  try {
    return await page.evaluate((modalSelector) => {
      function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const modals = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
      if (!modals.length) return null;
      const modal = modals[modals.length - 1];
      const text = (modal.innerText || '').replace(/\s+/g, ' ').trim();
      const editable = Array.from(modal.querySelectorAll('input, textarea, select')).filter(
        (el) =>
          isVisible(el) &&
          !el.disabled &&
          !el.readOnly &&
          !['hidden', 'submit', 'button', 'reset', 'file'].includes(el.type)
      );
      const looksLikeConfirmation =
        /(invite for|invitation|successfully|has been added|created successfully|sent to|login link|emailed to|works for \d+ days)/i.test(
          text
        ) && !/(add (?:and send invite|client and send invite)|create account|save changes)/i.test(text);
      return editable.length === 0 && looksLikeConfirmation ? text.slice(0, 200) : null;
    }, MODAL_SELECTOR);
  } catch {
    return null;
  }
}

async function waitForSubmitSuccess(page, before, { timeout = 8000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last = { succeeded: false, evidence: '' };
  while (Date.now() <= deadline) {
    last = await detectSubmitSuccess(page, before);
    if (last.succeeded) return last;
    if (Date.now() + interval > deadline) break;
    await page.waitForTimeout(interval);
  }
  return last;
}

function accountFromSnapshot(snapshot) {
  const fields = (snapshot && snapshot.fields) || [];
  const pick = (re) => {
    const hit = fields.find((f) => re.test(`${f.label} ${f.name} ${f.id} ${f.placeholder}`));
    return hit ? hit.value : '';
  };
  const pageUrl = String((snapshot && snapshot.pageUrl) || '');
  let entityType = 'entity';
  if (pageUrl.includes('/team')) entityType = 'team_member';
  else if (pageUrl.includes('/clients')) entityType = 'client';
  else if (pageUrl.includes('/properties')) entityType = 'property';
  else if (pageUrl.includes('/visits') || pageUrl.includes('/tasks')) entityType = 'visit';
  else if (snapshot && snapshot.roleText) entityType = 'team_member';

  const name =
    pick(/\b(full\s*name|property\s*name|property|title|subject|name)\b/i) ||
    (snapshot && snapshot.roleText) ||
    '';

  return {
    entityType,
    pageUrl: snapshot ? snapshot.pageUrl : '',
    name,
    role: pick(/\brole\b/i) || (snapshot && snapshot.roleText) || '',
    email: pick(/e-?mail/i),
    phone: pick(/(phone|mobile|whatsapp|contact\s*(number|no))/i),
    password: (fields.find((f) => f.type === 'password' && f.value) || {}).value || null,
  };
}

// Multer upload configuration with file size and type limits
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.env', '.js', '.ts', '.jsx', '.tsx', '.css', '.html', '.csv', '.yaml', '.yml'
]);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file max
    files: 5,                   // 5 files max
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ALLOWED_MIMES = [
      'text/plain', 'text/markdown', 'application/json', 'text/javascript', 'application/javascript',
      'text/typescript', 'text/css', 'text/html', 'text/csv', 'text/yaml', 'application/x-yaml', 'application/octet-stream'
    ];
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`File type ${ext} is not allowed. Upload code, text, or config files.`));
    }
    if (file.mimetype && !ALLOWED_MIMES.includes(file.mimetype) && !file.mimetype.startsWith('text/')) {
      return cb(new Error(`MIME type ${file.mimetype} is not allowed.`));
    }
    cb(null, true);
  },
});

function getGeminiModel() {
  // Use exactly what is configured. No substitution or "upgrade" logic.
  return process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
}

// Shared Gemini request helper. Retries thrown network errors ("fetch failed")
// and HTTP 429/503 responses with exponential backoff (2s, 4s, 8s), max 3
// attempts. Returns the Response on success and throws the last error when all
// attempts are exhausted so callers can fail gracefully.
const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_BACKOFF_MS = [2000, 4000, 8000];

async function fetchWithRetry(endpoint, options = {}) {
  let lastError;

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, {
        ...options,
        signal: AbortSignal.timeout(15000),
      });

      if (response.status !== 429 && response.status !== 503) {
        return response;
      }

      const errBody = await response.text().catch(() => '');
      lastError = new Error(`Gemini HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < GEMINI_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, GEMINI_BACKOFF_MS[attempt - 1]));
    }
  }

  throw lastError || new Error('Gemini request failed after retries');
}

/**
 * POST /api/run-test
 * Accepts multipart/form-data with fields:
 * - url (string)
 * - prompt (string)
 * - mode (string, "one-shot" | "agentic")
 * - files (file array, optional)
 */
router.post('/', upload.array('files'), async (req, res, next) => {
  const startedAt = new Date().toISOString();
  let browser = null;

  try {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const mode = req.body?.mode === 'agentic' ? 'agentic' : 'one-shot';
    const autoCleanup = req.body?.autoCleanup === true || req.body?.autoCleanup === 'true';
    const uploadedFiles = req.files || [];

    // SSRF & URL safety check
    const validation = await validateUrl(rawUrl);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    if (!prompt) {
      return res.status(400).json({ error: 'Please enter what Playwright should check.' });
    }

    // 1. Create run record in DB
    const runRecord = await TestRun.create({
      url: validation.url,
      prompt,
      mode,
      autoCleanup,
      title: `${new URL(validation.url).hostname} · ${mode === 'agentic' ? 'Agentic' : 'Test'} Run`,
      status: 'running',
      createdAt: startedAt,
    });

    const runId = runRecord.id || runRecord._id;
    currentRunId = String(runId);
    const fileNames = uploadedFiles.map((f) => f.originalname).join(', ');

    // 2. Launch Playwright
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(
      (await hasSavedLogin()) ? { storageState: STATE_FILE } : {}
    );
    const page = await context.newPage();
    page.setDefaultTimeout(25000);

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    // Intercept POST /api/v1/users responses to capture invite links
    lastCapturedInviteLink = null;
    page.on('response', async (res) => {
      try {
        if (res.request().method() === 'POST' && /\/api\/v\d+\/users\b/.test(res.url()) && res.status() === 201) {
          const body = await res.json().catch(() => null);
          if (body && body.invite && body.invite.link) {
            lastCapturedInviteLink = body.invite.link;
            console.log(`[invite-capture] Captured invite link from API: ${lastCapturedInviteLink}`);
            // Also update the account entry if we can match it
            if (body.user && body.user.email) {
              updateAccountEntry(
                { runId: currentRunId, email: body.user.email },
                { inviteLink: lastCapturedInviteLink }
              );
            }
          }
        }
      } catch {}
    });

    // 3. Initial navigation
    let navStatus = null;
    try {
      const response = await page.goto(validation.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      navStatus = response ? response.status() : 200;
      await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
    } catch (navErr) {
      navStatus = 500;
    }

    const testCases = [];

    // Always include connectivity check first
    testCases.push({
      name: 'Connectivity & Page Load',
      input: validation.url,
      expected: 'HTTP status 200-399',
      actual: navStatus ? `HTTP ${navStatus}` : 'Page failed to load',
      status: navStatus && navStatus < 400 ? 'PASS' : 'FAIL',
      reason:
        navStatus && navStatus < 400
          ? undefined
          : {
              expected: 'Page responds with HTTP status 200-399',
              actual: `HTTP ${navStatus}`,
              cause: 'Target server is unreachable or returned an error status',
              next: 'Verify URL host reachability, staging status, and network connection',
            },
    });

    // 4. Execute test suite based on chosen mode
    if (mode === 'agentic') {
      // DYNAMIC OBSERVE-DECIDE-ACT LOOP
      const agenticCases = await runAgenticLoop({
        page,
        url: validation.url,
        prompt,
        fileNames,
      });
      testCases.push(...agenticCases);
    } else {
      // ONE-SHOT PLANNER (Fast mode)
      const steps = await generateStepsWithGemini({
        url: validation.url,
        prompt,
        fileNames,
      });

      for (const step of steps) {
        const stepResult = await executePlaywrightStep(page, step, validation.url);
        testCases.push(stepResult);
      }
    }

    // 5. Capture runtime console errors (exclude transient network drops and expected auth checks)
    const fatalErrors = consoleErrors.filter(
      (e) => !e.includes('ERR_CONNECTION_') && !e.includes('Failed to load resource: net::') && !e.includes('401')
    );
    testCases.push({
      name: 'Console Runtime Error Check',
      input: 'Browser error listener',
      expected: '0 fatal uncaught console errors',
      actual: fatalErrors.length === 0 ? 'No console errors detected' : `${fatalErrors.length} error(s): ${fatalErrors[0]}`,
      status: fatalErrors.length === 0 ? 'PASS' : 'FAIL',
      reason:
        fatalErrors.length === 0
          ? undefined
          : {
              expected: '0 fatal uncaught console errors',
              actual: `${fatalErrors.length} error(s) logged in browser console`,
              cause: 'Uncaught JavaScript exception or failed asset bundle execution',
              next: 'Inspect browser console logs and component error boundaries',
            },
    });

    // 6. Save full page screenshot
    let screenshotPath = null;
    try {
      const fileName = `${runId}.png`;
      const fullPath = path.join(ARTIFACT_DIR, fileName);
      await page.screenshot({ path: fullPath, fullPage: true, timeout: 15000 });
      screenshotPath = `/artifacts/${fileName}`;
    } catch (e) {
      console.warn('Screenshot capture warning:', e.message);
    }

    // 6b. Optional cleanup (default OFF). Hard-capped inside the service, and
    // never included in the pass/fail decision because it must not block or
    // fail an otherwise valid report.
    let cleanup = null;
    if (autoCleanup && mode === 'agentic') {
      const account = getLatestAccountForRun(runId);
      cleanup = account
        ? await runCleanupWithTimeout({ page, account, runId, timeoutMs: 30000 })
        : { status: 'cleanup_skipped', detail: 'No created test account recorded for this run' };
    }

    // Determine final status
    const allPassed = testCases.every((c) => c.status === 'PASS');
    const finalStatus = allPassed ? 'passed' : 'failed';

    const checks = testCases.map((c) => ({
      name: c.name,
      passed: c.status === 'PASS',
      detail: c.actual,
    }));

    // Update DB record
    await TestRun.findByIdAndUpdate(runId, {
      status: finalStatus,
      checks,
      cases: testCases,
      screenshotPath,
      finishedAt: new Date().toISOString(),
    });

    // Clean up temporary uploaded files
    for (const file of uploadedFiles) {
      fs.unlink(file.path, () => {});
    }

    return res.json({
      runId,
      url: validation.url,
      startedAt,
      mode,
      title: `${new URL(validation.url).hostname} · ${mode === 'agentic' ? 'Autonomous Agent' : 'Test'} Report`,
      cases: testCases,
      screenshotPath,
      status: finalStatus,
      cleanup,
    });
  } catch (err) {
    console.error('Error in POST /api/run-test:', err);
    return res.status(500).json({ error: `Test execution failed: ${err.message}` });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

/**
 * ============================================================================
 * AGENTIC OBSERVE-DECIDE-ACT LOOP
 * ============================================================================
 */

// Unique per-run suffix so generated test data never collides with older runs.
let currentRunSuffix = '';
let currentTestTag = '';
let currentTestProfile = null;

function newRunSuffix() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// One stable tag per run so every generated record is identifiable as test data.
function testDataTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `AUTOTEST_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Real Tamil Nadu service areas. Only used for district/area fields, which are
// semantically constrained even when they render as free-text inputs.
const SERVICE_DISTRICTS = [
  'Madurai', 'Trichy', 'Chennai', 'Coimbatore', 'Salem', 'Vellore',
  'Tirunelveli', 'Erode', 'Thanjavur', 'Dindigul', 'Kanchipuram', 'Tiruppur',
];

// A different culture/country is picked for every run.
const FAKER_LOCALES = Object.keys(allFakers).filter((key) => key !== 'base');

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Faker locales like ja/ar/zh_CN produce non-Latin names. Emails must stay
// ASCII, so strip accents and non-ASCII characters for the local part.
function asciiSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase()
    .slice(0, 24);
}

// Build one realistic, internationally varied identity for the whole run. The
// agent is told these exact values, and auto-fill uses the same ones, so the
// submitted data always matches what the agent later verifies.
function buildTestProfile(testTag, locale) {
  const f = allFakers[locale] || faker;
  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value || fallback;
    } catch {
      return fallback;
    }
  };

  const first = safe(() => f.person.firstName(), 'Test');
  const last = safe(() => f.person.lastName(), 'User');
  const full = safe(() => f.person.fullName(), `${first} ${last}`);
  const firstSlug = asciiSlug(first) || 'first';
  const lastSlug = asciiSlug(last) || 'last';
  // Derive the email from the SAME person that is displayed, so name and email
  // never come from two different faker draws. Non-Latin scripts cannot be
  // transliterated reliably here, so fall back to the locale code.
  const localeSlug = String(locale).replace(/[^a-z0-9]+/gi, '') || 'intl';
  const nameSlug = asciiSlug(full) || `user.${localeSlug}`;
  const stamp = Date.now();

  const passwordBase = safe(() => f.internet.password({ length: 9 }), 'QaPassword');
  const password = /[0-9]/.test(passwordBase) ? `${passwordBase}!` : `${passwordBase}7!`;

  return {
    locale,
    firstName: `${testTag} ${first}`,
    lastName: last,
    fullName: `${testTag} ${full}`,
    email: `${testTag.toLowerCase()}.${nameSlug}.${stamp}@inventcare-test.example`,
    phoneIndian: `+91${pickRandom(['6', '7', '8', '9'])}${String(
      Math.floor(100000000 + Math.random() * 899999999)
    ).slice(0, 9)}`,
    phoneLocal: safe(() => f.phone.number(), '+919840012345'),
    address: `${safe(() => f.location.streetAddress(), '12 Test Street')}, ${safe(
      () => f.location.city(),
      'Chennai'
    )}`,
    city: safe(() => f.location.city(), 'Chennai'),
    district: pickRandom(SERVICE_DISTRICTS),
    pin: `6000${Math.floor(10 + Math.random() * 89)}`,
    company: `${testTag} ${safe(() => f.company.name(), 'Test Co')}`,
    propertyName: `${safe(() => f.word.noun(), 'Sunrise')}${Math.floor(100 + Math.random() * 900)}`,
    username: `${testTag.toLowerCase()}.${firstSlug}${Math.floor(10 + Math.random() * 89)}`.slice(0, 60),
    password,
  };
}

// Fill any empty, visible form fields inside the open modal before submit.
// This guarantees name/email/phone/district are present even if the planner
// forgets one, and returns the exact values so they appear in action history.
async function ensureFormFieldsFilled(page, suffix, options = {}) {
  if (!suffix) return [];
  const overwriteContact = Boolean(options.overwriteContact);
  const testTag = options.testTag || currentTestTag || testDataTag();
  const profile =
    options.profile || currentTestProfile || buildTestProfile(testTag, pickRandom(FAKER_LOCALES));
  try {
    const result = await page.evaluate(({ sfx, overwriteContact, testTag, profile }) => {
      function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function labelOf(el) {
        if (el.labels && el.labels[0]) {
          return (el.labels[0].innerText || el.labels[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        }
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim().replace(/\s+/g, ' ').slice(0, 80);
        const g = el.closest('label, .form-group, .field, .form-field, .ant-form-item, .MuiFormControl-root');
        const l = g && g.querySelector('label, .label, .ant-form-item-label, .MuiFormLabel-root');
        return l ? (l.innerText || l.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '';
      }

      function valueFor(el, label) {
        const tag = el.tagName.toLowerCase();
        const hint = [label, el.getAttribute('placeholder'), el.getAttribute('name'), el.id, el.type, tag]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (el.type === 'password' || /(confirm|new|re-?enter|retype|choose|set)\s*password/.test(hint)) {
          return profile.password;
        }
        if (el.type === 'email' || /e-?mail/.test(hint)) return profile.email;
        if (el.type === 'tel' || /(phone|mobile|whatsapp|telephone|contact\s*(number|no))/.test(hint)) {
          // Only force Indian formatting when the field itself asks for it.
          return /(\+91|india|indian|10\s*-?\s*digit)/.test(hint) ? profile.phoneIndian : profile.phoneLocal;
        }
        if (/(pin\s*code|pincode|zip|postal)/.test(hint)) return profile.pin;
        // District/area is constrained to real service areas even when it is a
        // free-text input, so never type an arbitrary international city here.
        if (/(district|area)/.test(hint)) return profile.district;
        if (/(property|building|residence|house)/.test(hint)) return profile.propertyName;
        if (/(living|address|city|location|place|town|street)/.test(hint)) return profile.address;
        if (/(company|organi[sz]ation|business)/.test(hint)) return profile.company;
        if (/first\s*name/.test(hint)) return profile.firstName;
        if (/(last\s*name|surname)/.test(hint)) return profile.lastName;
        if (/(full\s*name|owner\s*name|\bname\b)/.test(hint)) return profile.fullName;
        if (/(user\s*name|login)/.test(hint)) return profile.username;
        return profile.fullName;
      }

      function setNativeValue(el, value) {
        const tag = el.tagName.toLowerCase();
        const proto =
          tag === 'textarea'
            ? window.HTMLTextAreaElement.prototype
            : tag === 'select'
              ? window.HTMLSelectElement.prototype
              : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      const modalSelector =
        '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], .modal, .drawer, .offcanvas';
      const modals = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
      if (modals.length === 0) return { filled: [] };
      const modal = modals[modals.length - 1];

      const skipTypes = new Set([
        'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset',
        'search', 'range', 'color', 'date', 'datetime-local', 'month', 'week', 'time',
      ]);
      // Password fields are only auto-filled on forms that also ask to confirm
      // the password (registration/activation), never on a login form.
      const passwordInputs = Array.from(modal.querySelectorAll('input[type="password"]')).filter(isVisible);
      const modalAsksToConfirmPassword =
        passwordInputs.length >= 2 ||
        /confirm\s*(new\s*)?password|re-?enter\s*password|retype\s*password/i.test(modal.innerText || '');
      const filled = [];

      for (const el of Array.from(modal.querySelectorAll('input, textarea, select'))) {
        if (!isVisible(el) || el.disabled || el.readOnly) continue;
        if (skipTypes.has(el.type)) continue;
        if (el.type === 'password' && !modalAsksToConfirmPassword) continue;
        const label = labelOf(el);
        const hint = [label, el.getAttribute('placeholder'), el.getAttribute('name'), el.id]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (/(search|filter)/.test(hint)) continue;

        const isRequiredish =
          Boolean(el.required) ||
          el.getAttribute('aria-required') === 'true' ||
          label.includes('*');
        const isKnownKind =
          /(e-?mail|phone|mobile|whatsapp|telephone|contact\s*(number|no)|pin\s*code|pincode|zip|postal|living|address|city|district|area|location|place|town|company|organi[sz]ation|business|first\s*name|last\s*name|surname|full\s*name|owner\s*name|\bname\b|user\s*name|login|password|property|building|residence|house|street)/.test(
            hint
          );
        // Never invent data for unrelated optional fields (e.g. "Referred by").
        if (!isRequiredish && !isKnownKind) continue;

        const isEmailField = el.type === 'email' || /e-?mail/.test(hint);
        const isPhoneField =
          el.type === 'tel' || /(phone|mobile|whatsapp|telephone|contact\s*(number|no))/.test(hint);
        const existing = String(el.value || '').trim();
        const mayOverwrite = overwriteContact && (isEmailField || isPhoneField);
        if (existing && !mayOverwrite) continue;
        // Keep the planner's uniquely tagged email so its later verification
        // still matches the value that was actually submitted.
        if (existing && isEmailField && testTag && existing.toLowerCase().includes(String(testTag).toLowerCase())) {
          continue;
        }

        if (el.tagName.toLowerCase() === 'select') {
          if (existing) continue;
          const opt = Array.from(el.options).find((o) => o.value && !o.disabled);
          if (!opt) continue;
          setNativeValue(el, opt.value);
          filled.push({ label: label || el.id || 'select', value: opt.textContent.trim() });
          continue;
        }

        const value = valueFor(el, label);
        setNativeValue(el, value);
        filled.push({ label: label || el.id || el.getAttribute('placeholder') || el.tagName.toLowerCase(), value });
      }

      return { filled };
    }, { sfx: suffix, overwriteContact, testTag, profile });

    return result.filled || [];
  } catch {
    return [];
  }
}

async function runAgenticLoop({ page, url, prompt, fileNames }) {
  const MAX_AGENT_STEPS = 35; // Hard cap on total actions to prevent runaway costs
  const history = [];
  const agentCases = [];
  currentRunSuffix = newRunSuffix();
  currentTestTag = testDataTag();
  currentTestProfile = buildTestProfile(currentTestTag, pickRandom(FAKER_LOCALES));

  // PART C: Dynamic credential reuse check across future runs
  let reusedAccount = null;
  const isCreationPrompt = /\b(?:create|add|invite|register|new)\s+(?:member|person|staff|user|client|account)\b/i.test(prompt);
  const isReuseRequested = /\b(?:reuse|existing|staff\s*login|sign\s*in\s*as\s*staff)\b/i.test(prompt);
  if (!isCreationPrompt || isReuseRequested) {
    try {
      reusedAccount = await findReusableActivatedAccount({ page });
      if (reusedAccount) {
        console.log(`[credential-reuse] Found verified reusable account: ${reusedAccount.email}`);
      }
    } catch (reuseErr) {
      console.warn('[credential-reuse] check warning:', reuseErr.message);
    }
  }

  for (let stepIndex = 1; stepIndex <= MAX_AGENT_STEPS; stepIndex++) {
    // 1. OBSERVE: capture current page state
    const observation = await observePageState(page);

    // Detect an exact action+target repeated twice with two failures, so the
    // planner is explicitly told to stop looping on that element.
    const lastTwo = history.slice(-2);
    const repeatWarning =
      lastTwo.length === 2 &&
      lastTwo.every((h) => h.status === 'FAIL') &&
      lastTwo[0].action === lastTwo[1].action &&
      lastTwo[0].target === lastTwo[1].target
        ? `WARNING: you just tried ${lastTwo[0].action} on "${lastTwo[0].target}" twice and it failed both times — do NOT repeat it. Try a different element (for example the submit button inside the open modal, not the background button that opened it).`
        : '';

    // 2. DECIDE: send goal + observation + action history to Gemini
    let decision;
    try {
      decision = await decideNextActionWithGemini({
        goal: prompt,
        observation,
        history,
        fileNames,
        stepIndex,
        maxSteps: MAX_AGENT_STEPS,
        repeatWarning,
        testTag: currentTestTag,
        testProfile: currentTestProfile,
        reusedAccount,
      });
    } catch (geminiErr) {
      agentCases.push({
        name: `Agent Decision Step ${stepIndex}`,
        input: 'Gemini Agent Planner',
        expected: 'Valid next browser action decision',
        actual: `Agent decision failed: ${geminiErr.message}`,
        status: 'FAIL',
        thought: 'Could not contact decision model or model returned invalid JSON.',
        reason: {
          expected: 'Valid JSON action from decision model',
          actual: geminiErr.message,
          cause: 'Model network timeout, rate limit, or schema failure',
          next: 'Check Gemini API key, network access, or prompt formulation',
        },
      });
      break;
    }

    // Check if goal complete
    if (decision.action === 'done') {
      agentCases.push({
        name: decision.name || 'Goal Accomplished',
        input: 'Autonomous Verification',
        expected: decision.expected || 'Goal conditions satisfied',
        actual: 'Agent confirmed goal has been successfully achieved on screen',
        status: 'PASS',
        thought: decision.thought,
      });
      break;
    }

    // Check if agent reported failure / stuck
    if (decision.action === 'failed') {
      agentCases.push({
        name: decision.name || 'Agent Stalled / Failure Detected',
        input: decision.target || 'Current view state',
        expected: decision.expected || 'Progress toward goal',
        actual: decision.thought || 'Agent decided goal cannot be reached',
        status: 'FAIL',
        thought: decision.thought,
        reason: {
          expected: decision.expected || 'Goal steps to continue',
          actual: 'Agent terminated loop with failure status',
          cause: decision.thought || 'Blocking UI error or missing element',
          next: 'Inspect target application state and error messages',
        },
      });
      break;
    }

    // 3. ACT: execute decided action via Playwright
    const stepResult = await executePlaywrightStep(page, decision, url);
    stepResult.thought = decision.thought;
    agentCases.push(stepResult);

    // 4. REPEAT: record into history for next iteration
    history.push({
      step: stepIndex,
      action: decision.action,
      target: decision.target,
      // Keep the exact value typed so the model can reuse it for verification
      // later instead of inventing a different name/email.
      inputValue: decision.inputValue ? maskValue(decision.inputValue) : undefined,
      status: stepResult.status,
      actual: stepResult.actual,
      thought: decision.thought,
      validationTest: stepResult.validationTest || undefined,
      validationOutcome: stepResult.validationOutcome,
    });

    // If reached max steps without completing
    if (stepIndex === MAX_AGENT_STEPS) {
      agentCases.push({
        name: 'Agent Step Limit Safety Cap',
        input: `Safety threshold (${MAX_AGENT_STEPS} steps)`,
        expected: 'Goal reached within maximum permitted steps',
        actual: `Agent reached maximum safety cap of ${MAX_AGENT_STEPS} steps without reaching "done"`,
        status: 'FAIL',
        thought: 'Loop terminated to prevent runaway API usage and infinite cycles.',
        reason: {
          expected: `Goal accomplished within ${MAX_AGENT_STEPS} steps`,
          actual: 'Step budget exhausted',
          cause: 'Complex workflow or repetitive navigation loops',
          next: 'Refine the prompt into more atomic sub-goals',
        },
      });
    }
  }

  return agentCases;
}

/**
 * OBSERVE: captures interactive elements and visible page text
 */
async function observePageState(page) {
  const currentUrl = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {}

  const observation = await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // 1. Visible interactive elements. If a modal/dialog/drawer is open,
    // collect its controls first so the agent always sees the current form's
    // action buttons instead of only the first 35 elements in DOM order.
    const MAX_ELEMENTS = 50;
    const interactiveSelectors = 'button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="menuitem"]';

    function getLabel(node) {
      if (node.labels && node.labels.length > 0) {
        return (node.labels[0].innerText || node.labels[0].textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 80);
      }
      const aria = node.getAttribute('aria-label');
      if (aria) return aria.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (node.id) {
        const forLabel = document.querySelector(`label[for="${node.id}"]`);
        if (forLabel) {
          return (forLabel.innerText || forLabel.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80);
        }
      }
      const group = node.closest('label, .form-group, .field, .form-field, .ant-form-item, .MuiFormControl-root');
      if (group) {
        const groupLabel = group.querySelector('label, .label, .ant-form-item-label, .MuiFormLabel-root');
        if (groupLabel) {
          return (groupLabel.innerText || groupLabel.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80);
        }
      }
      return '';
    }

    function describeNode(node) {
      const tag = node.tagName.toLowerCase();
      const type = node.getAttribute('type') || '';
      const text = (node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const label = getLabel(node);
      const required =
        node.hasAttribute('required') ||
        node.getAttribute('aria-required') === 'true' ||
        /\*/.test(label);

      let selector = '';
      if (node.id) {
        selector = `#${node.id}`;
      } else if (node.name) {
        selector = `${tag}[name="${node.name}"]`;
      } else if (node.getAttribute('placeholder')) {
        selector = `${tag}[placeholder="${node.getAttribute('placeholder')}"]`;
      } else if (tag === 'a' && node.getAttribute('href') && node.getAttribute('href') !== '#') {
        // Prefer a stable href selector for links: their visible text often
        // spans multiple lines, which breaks a truncated :has-text() match.
        selector = `a[href="${node.getAttribute('href')}"]`;
      } else if (tag === 'button' && text) {
        selector = `button:has-text("${text.slice(0, 30)}")`;
      } else if (tag === 'a' && text) {
        selector = `a:has-text("${text.slice(0, 30)}")`;
      } else if (node.getAttribute('aria-label')) {
        selector = `[aria-label="${node.getAttribute('aria-label')}"]`;
      } else {
        const cls = Array.from(node.classList).slice(0, 2).join('.');
        selector = cls ? `${tag}.${cls}` : tag;
      }

      return {
        tag,
        type: type || undefined,
        text: text || undefined,
        label: label || undefined,
        required: required || undefined,
        placeholder: node.getAttribute('placeholder') || undefined,
        selector,
      };
    }

    function findOpenModal() {
      const modalSelector = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        'dialog[open]',
        '[aria-modal="true"]',
        '.modal',
        '.modal-dialog',
        '.modal-content',
        '.MuiDialog-paper',
        '.MuiDialog-container',
        '.ant-modal-content',
        '.ant-drawer-content',
        '.drawer',
        '.offcanvas',
        '.side-panel',
        '.overlay',
      ].join(', ');

      const known = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
      if (known.length > 0) return known[known.length - 1];

      // Fallback for custom overlays: the topmost visible fixed/absolute
      // container that actually contains form controls.
      let best = null;
      let bestZ = -Infinity;
      for (const el of document.querySelectorAll('div, aside, section, form')) {
        if (!isVisible(el)) continue;
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;
        const z = Number.parseInt(style.zIndex, 10);
        if (!Number.isFinite(z) || z <= 0) continue;
        if (!el.querySelector('input, textarea, select, button')) continue;
        if (z >= bestZ) {
          best = el;
          bestZ = z;
        }
      }
      return best;
    }

    const modal = findOpenModal();

    // Scroll scrollable modal bodies so controls below the fold (often the
    // submit button) are rendered and collected in this observation.
    if (modal) {
      const scrollables = [modal, ...modal.querySelectorAll('*')].filter((el) => {
        try {
          return el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4;
        } catch {
          return false;
        }
      });
      for (const el of scrollables) {
        try {
          el.scrollTop = el.scrollHeight;
        } catch {}
      }
    }

    const allNodes = Array.from(document.querySelectorAll(interactiveSelectors)).filter(isVisible);
    const modalNodes = modal
      ? Array.from(modal.querySelectorAll(interactiveSelectors)).filter(isVisible)
      : [];
    const backgroundNodes = allNodes.filter((node) => !modal || !modal.contains(node));
    const orderedNodes = [...modalNodes, ...backgroundNodes];

    const elements = [];
    const seen = new Set();
    for (const node of orderedNodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      elements.push(describeNode(node));
      if (elements.length >= MAX_ELEMENTS) break;
    }

    const modalHeading = modal ? modal.querySelector('h1, h2, h3, [role="heading"]') : null;
    const modalLabel = modal
      ? (modal.getAttribute('aria-label') || (modalHeading && modalHeading.innerText) || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 120)
      : '';

    // 2. Visible text summary (errors, toasts, headers, badges)
    const textSnippets = [];
    const importantNodes = document.querySelectorAll('h1, h2, h3, [role="alert"], .error, .toast, .success, p, span, td, th');
    for (const el of importantNodes) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && t.length > 2 && t.length < 200 && !textSnippets.includes(t)) {
        textSnippets.push(t);
        if (textSnippets.length >= 25) break;
      }
    }

    return {
      elements,
      visibleText: textSnippets.join(' | ').slice(0, 1500),
      modalOpen: Boolean(modal),
      modalLabel: modalLabel || undefined,
    };
  });

  annotateFieldTypes(observation, currentUrl);
  return {
    url: currentUrl,
    title,
    ...observation,
  };
}

// Enrich observed form controls with their inferred rules type, preferring a
// selector previously confirmed on this exact page.
function annotateFieldTypes(observation, pageUrl) {
  const knowledge = loadFieldKnowledge().filter((e) => e.pageUrl === normalizePageUrl(pageUrl));
  for (const el of observation.elements || []) {
    const tag = String(el.tag || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) {
      const known = knowledge.find((k) => k.selector === el.selector);
      const inferred = inferFieldType(
        `${el.label || ''} ${el.placeholder || ''} ${el.type || ''} ${el.selector || ''}`
      );
      let fieldType = (known && known.inferredType) || inferred || undefined;
      // The rules file is semantic: it may label an "area"/"district" control
      // dropdown_select even when it renders as a free-text <input>. Never tell
      // the agent to call selectOption on something that is not a <select>.
      if (fieldType === 'dropdown_select' && tag !== 'select') fieldType = 'text';
      el.fieldType = fieldType;
    } else if (tag === 'button') {
      // Custom select/combobox controls expose the chosen option as button text.
      if (/role|district|area|category|status|type/i.test(`${el.selector || ''} ${el.label || ''} ${el.text || ''}`)) {
        el.fieldType = el.fieldType || 'dropdown_select';
      }
    }
  }
  return observation;
}

/**
 * DECIDE: asks Gemini for one single next action with reasoning
 */
async function decideNextActionWithGemini({ goal, observation, history, fileNames, stepIndex, maxSteps, repeatWarning, testTag, testProfile, reusedAccount }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = getGeminiModel();

  if (!apiKey || apiKey.includes('PASTE_')) {
    throw new Error('GEMINI_API_KEY is not configured in .env');
  }

  const hasBudget = Number.isFinite(stepIndex) && Number.isFinite(maxSteps);
  const remainingSteps = hasBudget ? Math.max(0, maxSteps - stepIndex) : null;
  const fieldRulesPrompt = buildFieldRulesPrompt();
  const fieldKnowledgePrompt = buildFieldKnowledgePrompt(observation.url);

  const systemPrompt = `You are an autonomous browser testing agent navigating a web application to fulfill an open-ended goal.
User Goal: ${goal}
${fileNames ? `Attached context files: ${fileNames}` : ''}
${hasBudget ? `Step Budget: You are on step ${stepIndex} of ${maxSteps}. ${remainingSteps} step(s) remain after this one. Prioritize the most direct path to the goal and avoid unnecessary exploration, especially as the budget runs low.\n` : ''}${reusedAccount ? `Verified Reusable Account from prior run:
  Email: "${reusedAccount.email}"
  Password: "${reusedAccount.password}"
  Role: "${reusedAccount.role || 'Staff'}"
If the goal is to log in, verify access, or test as staff without creating a new user, reuse these verified credentials.\n` : ''}${testTag ? `Run test-data tag: ${testTag} (faker locale for this run: ${testProfile ? testProfile.locale : 'en'}).
Use this exact identity on create forms instead of inventing values:
  Full name: "${testProfile ? testProfile.fullName : `${testTag} Client`}"
  First name: "${testProfile ? testProfile.firstName : `${testTag} First`}" / Last name: "${testProfile ? testProfile.lastName : 'Client'}"
  Email: "${testProfile ? testProfile.email : `${testTag.toLowerCase()}@example.com`}"
  Phone: "${testProfile ? testProfile.phoneIndian : '+919840012345'}"
  Address (free-text): "${testProfile ? testProfile.address : 'Chennai, India'}"
  District/area (free-text field): "${testProfile ? testProfile.district : 'Madurai'}"
Every generated name/label must begin with ${testTag} and every email must contain it. Never use "John Doe" or "Test User". Names may contain accents or non-Latin scripts — type them exactly as given.
If a district/area control is a real dropdown/select, choose one of its REAL options with selectOption; never type an arbitrary international city into a constrained dropdown.\n` : ''}${repeatWarning ? `\n${repeatWarning}\n` : ''}
Current Page Observation:
- URL: ${observation.url}
- Title: ${observation.title}
${observation.modalOpen ? `- Open modal/dialog: ${observation.modalLabel || 'yes'} (its controls are listed first)\n` : ''}- Visible Text Snippets: ${observation.visibleText}
- Interactive Elements on Screen:
${observation.elements.map((el, i) => `  [${i + 1}] <${el.tag}> type="${el.type || ''}" text="${el.text || ''}" label="${el.label || ''}"${el.required ? ' required="true"' : ''}${el.fieldType ? ` fieldType="${el.fieldType}"` : ''} selector="${el.selector}"`).join('\n')}

${fieldRulesPrompt}
${fieldKnowledgePrompt ? `\n${fieldKnowledgePrompt}` : ''}

Action History so far:
${history.length === 0 ? 'No actions taken yet.' : history.map((h, i) => `Step ${i + 1}: ${h.action} on "${h.target}"${h.inputValue ? ` with input "${h.inputValue}"` : ''} -> Result: ${h.actual} (${h.status})${h.validationTest ? ` [validation: ${h.validationOutcome}]` : ''}`).join('\n')}

Instructions:
1. Examine the current observation and action history against the goal.
2. Never declare "done" just because an action completed without an error. Before returning "done", you MUST visually confirm the expected outcome on screen. For example, after creating a record, navigate to the relevant list or search view and verify the new record's identifying text (name, email, or ID) actually appears there. Use "waitForElement", "expectToast", or "expectText" to confirm. Only return "done" once that confirmation is visible in the current observation.
3. If you are blocked or an unrecoverable error prevents the goal, return action "failed".
4. Otherwise, pick the SINGLE next atomic browser action ("fill", "click", "selectOption", "check", "uncheck", "navigate", "wait", "waitForElement", "expectText", "expectToast", "activateInvite").
5. For user credentials, always use exactly the placeholders "<USERNAME>" and "<PASSWORD>" in inputValue. Never invent, guess, or type a literal email/username/password (for example "coordinator@example.com"); the placeholder is replaced with the real test account at runtime.
6. Provide a concise, clear "thought" explaining WHY you chose this action based on what is on screen.
7. "waitForElement" and "expectToast" accept an optional "timeout" in milliseconds. Use them when the UI needs time to update.
8. Validation testing: If the user's goal asks you to test invalid input, rejection, or uses language like "invalid", "should fail", "should not allow", or similar, deliberately try bad input (for example numbers in a name field, an empty required field, or a malformed email). Set "expectValidationError": true on the step that submits/attempts that invalid input. This INVERTS pass/fail: the step passes only if the app shows a validation error or rejection (error text near the field, an invalid-field state, or the form/modal staying open) and does NOT accept the data. A step where invalid data is silently accepted fails and is reported as a real validation bug. After the validation check, continue toward the rest of the goal (for example, create a valid record and verify it in the list). Set "expectValidationError": false for normal functional steps. Before submitting the invalid value, fill all other required fields with valid data so the only invalid value is the one under test. Set "expectValidationError": true ONLY on the final "click" action that submits/saves/adds the record — never on fill, selectOption, check, or uncheck steps. Fill the invalid value first with a normal step, then submit on the next step with "expectValidationError": true.
9. Test data: When filling any create/edit form, fill EVERY required field before submitting — including name, email, phone/mobile, district/area, role, and any element marked required="true" or whose label contains "*". Use the exact faker-generated identity given above (full name, first/last name, email, phone, address) instead of inventing values; it already starts with the run test-data tag and is guaranteed unique. Never use an untagged name like "John Doe" or "Test User 4821", and never swap the given email for a different one. For a district/area text field, type the given district/area name; for a real select, use "selectOption" with a valid option from that select. Do not click the final submit/Save/Add button until all required fields are filled; a missing required field will keep the modal open and make the submit action appear to fail. After submitting valid data, do NOT click Cancel — Cancel discards the form. Wait for the modal to close or a success confirmation, then verify the new record's unique name or email in the list using "expectText" or "waitForElement".
10. Remember your own test data: the Action History lists the exact value you typed for each fill step. When verifying, reuse that exact string verbatim (for example the same "Test Client 4821" and "qa.4821@example.com" you entered). Never switch to a different name like "Test Owner" or an old ID from a previous run. If a verification step fails, read the Action History, find the exact value typed into the create form, and search for that exact value instead of guessing.
11. Run the invalid-input validation test exactly ONCE. As soon as a validation step reports a conclusive result (PASS or FAIL), do not repeat the invalid submission or create another invalid record. Move on to creating the single valid record and verifying it. If a validation step reports "INCONCLUSIVE" because a different required field was empty, fill that field and retry the invalid submit at most ONCE, then proceed.
12. Confirm creation before verifying: after clicking the final submit, wait for the form/modal to close (or a success banner) and, if needed, navigate to the list. A name typed into the search box is NOT proof of creation, and a "Nothing matches ..." message means it does not exist. Only pass when the record's name/email appears in an actual list row.
13. For "expectText", the target must be the literal text you expect to see — the exact record name/email you typed, for example "Test Client 9988". Never use "body", "html", a CSS selector, a URL, or the word "text" as an expectText target.
14. When a modal/dialog is open, operate on the controls listed under that modal. Never re-click the background button that originally opened the modal. If a button with the same text exists both behind and inside the modal, the modal's own control is the correct target (the runtime prefers it automatically).
15. Use the fieldType shown for each control to choose values: name → alphabetic, email → unique valid email, phone → digits matching the placeholder, dropdown_select → pick a real option (use "selectOption" ONLY when the element tag is "select"; for an input or button/combobox, click it and choose a listed option, or type the value for a free-text area/district field), password → meets the stated complexity. Follow the field-testing rules above for which invalid cases to try.
16. Do not declare success while the create form is still open. After the final submit, wait for the modal to close, a success/invite banner, or the new record in the list.
17. If after submitting you see a CONFIRMATION modal instead of the create form (for example a "Done" button, or a modal titled "Invite for ..." showing a link), the create action already SUCCEEDED. Do NOT click the create/submit button again. If an invite link is shown, you can use action "activateInvite" to open the invite link in a new tab, set the password, and verify activation, or click "Done"/"Close" and verify the record in the list.
18. A create form and a confirmation modal are different dialogs. If the submit button is missing from the currently open modal, do not guess another target; read the listed modal controls and choose the appropriate one (usually "Done" or "Close").

Respond ONLY with valid JSON in this exact shape:
{
  "thought": "Reasoning explaining what you observe and why you chose this action",
  "name": "Short test case name",
  "action": "fill" | "click" | "selectOption" | "check" | "uncheck" | "navigate" | "wait" | "waitForElement" | "expectText" | "expectToast" | "activateInvite" | "done" | "failed",
  "target": "valid CSS selector or text from elements list",
  "inputValue": "value to fill if action is fill, selectOption, check, or uncheck, otherwise empty string",
  "timeout": 10000,
  "expectValidationError": false,
  "expected": "What you expect to happen after this action"
}`;

  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const modelId = model.replace(/^models\//, '');
  const endpoint = `${base}/models/${encodeURIComponent(modelId)}:generateContent?key=${apiKey}`;

  // The model occasionally returns JSON with an unescaped quote/newline. Retry
  // once with a corrective reminder instead of aborting the whole run.
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const promptText =
      attempt === 1
        ? systemPrompt
        : `${systemPrompt}\n\nIMPORTANT: Your previous reply was not valid JSON. Reply with ONE valid JSON object only. Escape all quotes and newlines inside string values.`;

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gemini HTTP ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    try {
      return parseModelJson(text);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Gemini returned invalid JSON');
}

// Best-effort extraction of a JSON object from a model reply.
function parseModelJson(text) {
  const raw = String(text || '').trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(cleaned.slice(first, last + 1));
  }
  throw new Error('Model reply did not contain a JSON object');
}

/**
 * ============================================================================
 * ONE-SHOT STEP PLANNER (FAST MODE)
 * ============================================================================
 */
async function generateStepsWithGemini({ url, prompt, fileNames }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = getGeminiModel();

  if (apiKey && !apiKey.includes('PASTE_')) {
    try {
      const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
      const modelId = model.replace(/^models\//, '');
      const endpoint = `${base}/models/${encodeURIComponent(modelId)}:generateContent?key=${apiKey}`;

      const systemPrompt = `You are a test automation planner. Convert this user test prompt into an array of atomic browser test steps.
Target URL: ${url}
User Prompt: ${prompt}
${fileNames ? `Attached context files: ${fileNames}` : ''}

Respond ONLY with valid JSON in this exact shape:
{
  "steps": [
    {
      "name": "Short test case name",
      "action": "navigate" | "fill" | "click" | "wait" | "expectText" | "expectUrl" | "selectOption",
      "target": "selector, label, placeholder, or text",
      "inputValue": "text to fill, or <USERNAME> or <PASSWORD>",
      "expected": "Description of expected outcome"
    }
  ]
}

Safety rules:
- For credentials, use <USERNAME> and <PASSWORD> placeholders only. Never use real credentials.
- Keep actions realistic for Playwright. Limit to 3-6 essential steps.`;

      const response = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.steps) && parsed.steps.length > 0) {
          return parsed.steps;
        }
      } else {
        const errBody = await response.text().catch(() => '');
        console.warn(`Gemini step generation returned HTTP ${response.status}: ${errBody.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn('Gemini API call skipped or timed out, using rule-based test planner:', err.message);
    }
  }

  // Resilient rule-based planner based on the prompt keywords and target URL
  return buildFallbackSteps(url, prompt);
}

function buildFallbackSteps(url, prompt) {
  const p = prompt.toLowerCase();
  const steps = [];

  const isLoginFlow = p.includes('log in') || p.includes('sign in') || p.includes('auth') || url.includes('login');
  const isDashboardCheck = p.includes('dashboard') || p.includes('admin');
  const isLandingFlow = url.includes('landing') || p.includes('landing') || p.includes('smoke');

  if (isLoginFlow) {
    steps.push({
      name: 'Fill User Credentials',
      action: 'fill',
      target: '#email, input[type="email"], input[name="email"], input[name="username"], input[autocomplete="name"]',
      inputValue: '<USERNAME>',
      expected: 'User identifier filled into login field',
    });

    steps.push({
      name: 'Fill Password',
      action: 'fill',
      target: '#password, input[type="password"], input[name="password"]',
      inputValue: '<PASSWORD>',
      expected: 'Password field filled securely',
    });

    steps.push({
      name: 'Submit Sign In Form',
      action: 'click',
      target: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit")',
      expected: 'Form submission initiates and transitions to authenticated route',
    });

    steps.push({
      name: 'Verify Post-Login Navigation',
      action: 'expectUrl',
      target: process.env.STAGING_POST_LOGIN_PATTERN || 'admin|dashboard',
      expected: 'URL redirects to protected dashboard/admin route',
    });

    if (isDashboardCheck) {
      steps.push({
        name: 'Verify Dashboard Elements Load',
        action: 'expectText',
        target: 'Invent Care|Dashboard|Super admin|Overview|Clients',
        expected: 'Dashboard header and workspace metrics appear on screen',
      });
    }
  } else if (isLandingFlow) {
    steps.push({
      name: 'Branding & Title Verification',
      action: 'expectText',
      target: 'Invent Care',
      expected: 'Page displays brand name "Invent Care"',
    });

    steps.push({
      name: 'Section Anchors Verification',
      action: 'click',
      target: 'a[href*="#covered"], a[href*="#access"], a.brand',
      expected: 'Navigation links trigger smooth scroll to target content section',
    });

    steps.push({
      name: 'Service Offerings Check',
      action: 'expectText',
      target: 'Property care|Maintenance|Rent|Documents',
      expected: 'Service proposition copy is visible to visitors',
    });
  } else {
    steps.push({
      name: 'Primary Content Presence',
      action: 'expectText',
      target: 'body',
      expected: 'Page body renders visible text and layout elements',
    });

    steps.push({
      name: 'Interactive Navigation Verification',
      action: 'click',
      target: 'a[href]:not([href="#"]):not([href^="javascript"])',
      expected: 'First primary navigation link responds to user click',
    });
  }

  return steps;
}

/**
 * ACT: Execute an individual Playwright step
 */
async function executePlaywrightStep(page, step, originalUrl) {
  if (step.expectValidationError && step.action === 'click') {
    return executeValidationStep(page, step, originalUrl);
  }

  const name = step.name || `${step.action}: ${step.target}`;
  const input = step.inputValue
    ? `${step.target} <- ${maskValue(step.inputValue)}`
    : step.target || step.action;
  const expected = step.expected || `Action ${step.action} completes successfully`;

  const resolvedValue = resolveCredentials(step.inputValue || '');

  try {
    switch (step.action) {
      case 'navigate': {
        const dest = step.target || originalUrl;
        const res = await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const st = res ? res.status() : 200;
        return {
          name,
          input,
          expected,
          actual: `HTTP ${st} at ${page.url()}`,
          status: st < 400 ? 'PASS' : 'FAIL',
        };
      }

      case 'fill': {
        const selector = step.target;
        const locator = await resolveActionLocator(page, selector, { strictModal: true });
        await locator.waitFor({ state: 'visible', timeout: 12000 });
        await locator.fill(resolvedValue);
        const actualVal = await locator.inputValue().catch(() => '');
        const meta = await getFieldMeta(locator);
        if (meta) {
          const inferred = inferFieldType(
            `${meta.label} ${meta.placeholder} ${meta.name} ${meta.id} ${meta.type}`
          );
          rememberFieldKnowledge(page.url(), selector, inferred);
        }
        return {
          name,
          input,
          expected,
          actual: `Field successfully filled (${actualVal ? 'length ' + actualVal.length : 'ok'})`,
          status: 'PASS',
        };
      }

      case 'click': {
        const selector = step.target;
        const locator = await resolveActionLocator(page, selector, { strictModal: true });
        await locator.waitFor({ state: 'visible', timeout: 12000 });
        const clickText = ((await locator.innerText().catch(() => '')) || '').trim();
        const isSubmitLike =
          /\b(add|save|create|submit|send|invite|continue|confirm|register|update|next|finish)\b/i.test(clickText) &&
          !/\b(cancel|close|delete|remove|search|filter|back|edit|view|done)\b/i.test(clickText);
        const testsEmptiness = /(empty|blank|missing|omit|leave\b.{0,30}\bempty|without (?:a |an )?\w+)/i.test(
          `${step.name || ''} ${step.expected || ''} ${step.thought || ''}`
        );
        const protectsContact =
          /(invalid|malformed|bad|wrong|empty|blank|missing).{0,40}(e-?mail|phone|mobile|contact)|(e-?mail|phone|mobile|contact).{0,40}(invalid|malformed|bad|wrong|empty|blank|missing)/i.test(
            `${step.name || ''} ${step.expected || ''} ${step.thought || ''}`
          );

        let autoFilled = [];
        if (isSubmitLike && !testsEmptiness) {
          // Anti-resubmit guard: if a confirmation dialog already shows the
          // created record, clicking create/save again would duplicate it.
          const confirmationText = await detectConfirmationModal(page);
          if (confirmationText) {
            return {
              name,
              input,
              expected,
              actual: `Duplicate submit prevented: a confirmation dialog is already open ("${confirmationText.slice(0, 120)}"). The record was already created — close this dialog with "Done"/"Close" and verify it in the list instead of submitting again.`,
              status: 'PASS',
              duplicateSubmitPrevented: true,
            };
          }

          autoFilled = await ensureFormFieldsFilled(page, currentRunSuffix, {
            overwriteContact: !protectsContact,
            testTag: currentTestTag,
            profile: currentTestProfile,
          });
        }

        // Capture the modal's final values just before submission so a
        // successful creation can be written to created-test-accounts.json.
        const submitSnapshot = isSubmitLike ? await captureFormSnapshot(page) : null;

        await locator.click();
        await page.waitForTimeout(isSubmitLike && !step.expectValidationError ? 1200 : 2000);

        let accountNote = '';
        if (submitSnapshot && submitSnapshot.modalOpen && submitSnapshot.fields.length > 0) {
          // Wait for the async submit to settle: a confirmation modal replaces
          // the form, or the modal closes and the list updates.
          const outcome =
            isSubmitLike && !step.expectValidationError
              ? await waitForSubmitSuccess(page, submitSnapshot, { timeout: 8000 })
              : await detectSubmitSuccess(page, submitSnapshot);
          if (outcome.succeeded) {
            const account = accountFromSnapshot(submitSnapshot);
            const saved = appendCreatedAccount(account);
            if (saved) {
              accountNote = ` | Created account logged${saved.email ? ` (${saved.email})` : ''}`;
            }

            // PART B: Invite-link -> new-tab -> set-password -> activate flow
            if (account.entityType === 'team_member' || (submitSnapshot.pageUrl && submitSnapshot.pageUrl.includes('/team'))) {
              try {
                await page.waitForTimeout(1500);
                const acctForActivation = saved || account;
                // Inject captured invite link from network intercept
                if (!acctForActivation.inviteLink && lastCapturedInviteLink) {
                  acctForActivation.inviteLink = lastCapturedInviteLink;
                }
                const activationResult = await handleInviteActivation({
                  context: page.context(),
                  page,
                  account: acctForActivation,
                  runId: currentRunId,
                });
                if (activationResult && activationResult.success) {
                  accountNote += ` | Invite activated in new tab (${activationResult.detail})`;
                }
              } catch (actErr) {
                console.warn('[invite-activation] error during activation:', actErr.message);
              }
            }
          }
        }

        const filledNote = autoFilled.length
          ? ` | Auto-filled required fields: ${autoFilled.map((f) => `${f.label}=${f.value}`).join(', ')}`
          : '';
        return {
          name,
          input,
          expected,
          actual: `Clicked "${selector}", current URL: ${page.url()}${filledNote}${accountNote}`,
          status: 'PASS',
        };
      }

      case 'selectOption': {
        const selector = step.target;
        const locator = await resolveActionLocator(page, selector, { strictModal: true });
        await locator.waitFor({ state: 'visible', timeout: 10000 });
        await locator.selectOption(resolvedValue || step.inputValue || '');
        const meta = await getFieldMeta(locator);
        if (meta) {
          const inferred = inferFieldType(
            `${meta.label} ${meta.placeholder} ${meta.name} ${meta.id} ${meta.type}`
          );
          rememberFieldKnowledge(page.url(), selector, inferred);
        }
        return {
          name,
          input,
          expected,
          actual: `Selected option in "${selector}"`,
          status: 'PASS',
        };
      }

      case 'check': {
        const selector = step.target;
        const locator = await waitForVisibleTarget(page, selector, 12000);
        await locator.check();
        return {
          name,
          input,
          expected,
          actual: `Checked "${selector}"`,
          status: 'PASS',
        };
      }

      case 'uncheck': {
        const selector = step.target;
        const locator = await waitForVisibleTarget(page, selector, 12000);
        await locator.uncheck();
        return {
          name,
          input,
          expected,
          actual: `Unchecked "${selector}"`,
          status: 'PASS',
        };
      }

      case 'waitForElement': {
        const timeout = Number(step.timeout) || 15000;
        await waitForVisibleTarget(page, step.target, timeout);
        return {
          name,
          input,
          expected,
          actual: `Element "${step.target}" became visible (waited up to ${timeout}ms)`,
          status: 'PASS',
        };
      }

      case 'expectToast': {
        const timeout = Number(step.timeout) || 10000;
        const defaultToastSelector =
          '[role="alert"], [role="status"], .toast, .Toastify__toast, .MuiSnackbar-root, .ant-message-notice, .alert, .success, .error';
        const locator = step.target
          ? await waitForVisibleTarget(page, step.target, timeout)
          : page.locator(defaultToastSelector).first();
        if (!step.target) {
          await locator.waitFor({ state: 'visible', timeout });
        }
        const toastText = ((await locator.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
        return {
          name,
          input,
          expected,
          actual: toastText
            ? `Toast/banner appeared: "${toastText}"`
            : 'Toast/banner appeared (no text content)',
          status: 'PASS',
        };
      }

      case 'activateInvite': {
        const account = getLatestAccountForRun(currentRunId) || {};
        // Inject captured invite link if the account doesn't already have one
        if (!account.inviteLink && lastCapturedInviteLink) {
          account.inviteLink = lastCapturedInviteLink;
        }
        const activationResult = await handleInviteActivation({
          context: page.context(),
          page,
          account,
          runId: currentRunId,
        });
        return {
          name,
          input: step.target || 'Invite link in DOM / modal',
          expected: step.expected || 'Invite link opened in new tab, password set, account verified active',
          actual: activationResult.detail,
          status: activationResult.status,
          reason: activationResult.success
            ? undefined
            : {
                expected: 'Invite activation to complete and account verified active',
                actual: activationResult.detail,
                cause: 'Invite link not found or activation form failed to submit',
                next: 'Check that invite was created and copy link is accessible in UI',
              },
        };
      }

      case 'expectUrl': {
        const pattern = new RegExp(step.target || '.*', 'i');
        await page.waitForURL(pattern, { timeout: 15000 });
        return {
          name,
          input,
          expected,
          actual: `URL matches pattern: ${page.url()}`,
          status: 'PASS',
        };
      }

      case 'expectText': {
        const rawTarget = String(step.target || '').trim();
        const genericTarget = /^(body|html|page|document|content|text|screen|main|div|span|table|row|list)$/i.test(
          rawTarget
        );
        const pageSnippet = await page
          .evaluate(() => (document.body ? document.body.innerText : ''))
          .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 600))
          .catch(() => '');
        if (genericTarget) {
          return {
            name,
            input,
            expected,
            actual: `expectText target "${rawTarget}" is a selector, not the text to find. Use the exact record name/email you typed (for example "Test Client 9988"). Current visible text: ${pageSnippet}`,
            status: 'FAIL',
            reason: {
              expected: 'The literal text that should be visible (e.g. the new record name)',
              actual: `Received generic selector "${rawTarget}"`,
              cause: 'expectText searches visible text; it does not resolve CSS selectors',
              next: 'Retry expectText with the exact name/email value you typed into the form',
            },
          };
        }

        const patterns = rawTarget.split('|').map((p) => p.trim()).filter(Boolean);
        // Match visible text nodes, but ignore "no results" / empty-state
        // messages: e.g. 'Nothing matches "X"' must not count as finding X.
        const result = await page.evaluate((patternSources) => {
          const regexes = patternSources
            .map((p) => {
              try {
                return new RegExp(p, 'i');
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          const NEGATIVE =
            /(no (?:matches|results?|records?|items?|clients?|rows?)|nothing matches|nothing found|no .{0,30}found|did not match|doesn'?t match|does not match|0 results|no data)/i;

          function isVisible(el) {
            if (!el) return false;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }

          const matches = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const text = (node.nodeValue || '').trim();
            if (!text || !regexes.some((re) => re.test(text))) continue;
            const el = node.parentElement;
            if (!el || !isVisible(el)) continue;

            let negative = false;
            for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
              const t = (cur.innerText || '').trim();
              if (t && t.length < 400 && NEGATIVE.test(t)) {
                negative = true;
                break;
              }
            }
            if (negative) continue;

            matches.push(text.slice(0, 160));
            if (matches.length >= 3) break;
          }
          return { matched: matches.length > 0, matches };
        }, patterns);

        if (result.matched) {
          return {
            name,
            input,
            expected,
            actual: `Found expected content matching "${step.target}"${result.matches.length ? `: "${result.matches[0]}"` : ''}`,
            status: 'PASS',
          };
        }
        return {
          name,
          input,
          expected,
          actual: `Target text "${step.target}" was not visible on the page. Current visible text: ${pageSnippet}`,
          status: 'FAIL',
          reason: {
            expected: `Page contains "${step.target}"`,
            actual: 'Text pattern not matched in rendered body (empty-state messages are ignored)',
            cause: 'Component state did not load, or text was changed',
            next: 'Verify selector or check network API response in DevTools',
          },
        };
      }

      case 'wait': {
        await page.waitForTimeout(3000);
        return {
          name,
          input,
          expected,
          actual: `Waited successfully, URL: ${page.url()}`,
          status: 'PASS',
        };
      }

      default: {
        return {
          name,
          input,
          expected,
          actual: `Unsupported action: ${step.action}`,
          status: 'FAIL',
          reason: {
            expected:
              'Supported action (navigate, fill, click, selectOption, check, uncheck, expectUrl, expectText, expectToast, waitForElement, activateInvite, wait)',
            actual: step.action,
            cause: 'Unknown step action instruction',
            next: 'Adjust test prompt wording',
          },
        };
      }
    }
  } catch (err) {
    const errorLine = String(err.message || 'Execution error').split('\n')[0].slice(0, 200);
    return {
      name,
      input,
      expected,
      actual: `Step failed: ${errorLine}`,
      status: 'FAIL',
      reason: {
        expected,
        actual: errorLine,
        cause: errorLine.includes('timeout') ? 'Element wait timeout exceeded' : 'Action failed during execution',
        next: 'Check that target selector exists and is interactable',
      },
    };
  }
}

// Resolve a target that may be a CSS selector or visible text. The overall wait
// is bounded by one timeout so the text fallback does not double it.
async function waitForVisibleTarget(page, target, timeout) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('Missing target selector or text');

  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1000, deadline - Date.now());

  try {
    const locator = await resolveActionLocator(page, raw);
    await locator.waitFor({ state: 'visible', timeout: remaining() });
    return locator;
  } catch (err) {
    if (Date.now() >= deadline) throw err;
    const textLocator = page.getByText(raw, { exact: false }).first();
    await textLocator.waitFor({ state: 'visible', timeout: remaining() });
    return textLocator;
  }
}

// Snapshot visible validation evidence plus the current modal's text lines.
async function getValidationSnapshot(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const modalSelector =
      '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], .modal, .drawer, .offcanvas';
    const modals = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
    const modal = modals.length > 0 ? modals[modals.length - 1] : null;
    const scope = modal || document.body;

    const lines = ((scope && scope.innerText) || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 250);

    const messages = [];
    const errorSelector = [
      '[role="alert"]',
      '[aria-invalid="true"]',
      '.error',
      '.error-message',
      '.field-error',
      '.validation-error',
      '.invalid',
      '.is-invalid',
      '.invalid-feedback',
      '.Mui-error',
      '.MuiFormHelperText-root.Mui-error',
      '.ant-form-item-explain-error',
      '.ant-form-item-has-error',
      '.text-red-500',
      '.text-danger',
      '.help-block',
      '.form-error',
      '.Toastify__toast--error',
      '.toast-error',
      '.alert-danger',
      '[data-error]',
    ].join(', ');

    const successWord = /(success|successfully|created|saved|added|invited|updated)/i;
    for (const el of document.querySelectorAll(errorSelector)) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      // A role="alert" success banner is not a validation error.
      if (!t || t.length < 2 || t.length >= 300 || successWord.test(t) || messages.includes(t)) continue;
      messages.push(t);
    }

    const invalidFieldNames = Array.from(
      document.querySelectorAll('[aria-invalid="true"], input:invalid, textarea:invalid, select:invalid')
    )
      .filter(isVisible)
      .map((el) => el.getAttribute('name') || el.id || el.getAttribute('placeholder') || el.tagName.toLowerCase())
      .slice(0, 5);

    const successSelector =
      '.toast-success, .alert-success, .Toastify__toast--success, [data-success], .MuiAlert-standardSuccess';
    const successToast = Array.from(document.querySelectorAll(successSelector)).some(isVisible);

    return {
      modalOpen: Boolean(modal),
      lines,
      messages: messages.slice(0, 5),
      invalidFieldNames,
      successToast,
    };
  });
}

const VALIDATION_ERROR_TEXT =
  /(already|invalid|required|must|cannot|can't|not allowed|please (?:enter|provide|select|choose)|enter a valid|is not a valid|too short|too long|only (?:letters|numbers|digits)|duplicate|failed|error|unable to|no more than|between \d)/i;
const VALIDATION_SUCCESS_TEXT = /(success|successfully|created|saved|added|invited|updated)/i;

// Validation steps invert the normal pass/fail rule: they PASS only when the
// app rejects the invalid input, and FAIL when bad data is silently accepted.
async function executeValidationStep(page, step, originalUrl) {
  const baseName = step.name || `${step.action}: ${step.target}`;
  const validationName = `[Validation] ${baseName}`;

  const before = await getValidationSnapshot(page).catch(() => ({
    modalOpen: false,
    lines: [],
    messages: [],
    invalidFieldNames: [],
    successToast: false,
  }));

  const actionResult = await executePlaywrightStep(
    page,
    { ...step, expectValidationError: false },
    originalUrl
  );

  // Async server-side validation can take several seconds. Poll for new error
  // text, error UI, invalid fields, a success toast, or the modal closing.
  const waitMs = Math.max(3000, Math.min(Number(step.timeout) || 10000, 12000));
  const deadline = Date.now() + waitMs;
  let snapshot = before;
  let errorLines = [];
  let newMessages = [];
  let newInvalidFields = [];
  let rejectionShown = false;
  let acceptedEvidence = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(600).catch(() => {});

    let current;
    try {
      current = await getValidationSnapshot(page);
    } catch {
      continue;
    }
    if (!current) continue;
    snapshot = current;

    const newLines = current.lines.filter((line) => !before.lines.includes(line));
    errorLines = newLines.filter(
      (line) => line.length <= 220 && VALIDATION_ERROR_TEXT.test(line) && !VALIDATION_SUCCESS_TEXT.test(line)
    );
    newMessages = current.messages.filter((message) => !before.messages.includes(message));
    newInvalidFields = current.invalidFieldNames.filter(
      (field) => !before.invalidFieldNames.includes(field)
    );

    if (newMessages.length > 0 || newInvalidFields.length > 0 || errorLines.length > 0) {
      rejectionShown = true;
      break;
    }

    if ((before.modalOpen && !current.modalOpen) || current.successToast) {
      acceptedEvidence = true;
      break;
    }
  }

  const evidence = [];
  for (const message of [...newMessages, ...errorLines]) {
    if (message && !evidence.includes(message)) evidence.push(message);
  }
  if (evidence.length === 0 && newInvalidFields.length > 0) {
    evidence.push(`field(s) newly marked invalid: ${newInvalidFields.join(', ')}`);
  }
  const detail =
    evidence.length > 0 ? evidence.slice(0, 5).join(' | ') : 'no validation feedback or rejection was detected';

  // A submit can be blocked merely because a *different* required field is
  // empty (e.g. "Presently living in is required."). That does not prove the
  // value under test was validated, so report it as inconclusive, not a pass.
  const onlyRequiredEvidence =
    evidence.length > 0 && evidence.every((line) => /required/i.test(line));

  if (rejectionShown && onlyRequiredEvidence && !acceptedEvidence) {
    return {
      name: validationName,
      input: actionResult.input,
      expected: step.expected || 'Invalid input is rejected with a visible validation error',
      actual: `Validation test INCONCLUSIVE: the submit was blocked only by a different empty required field (${detail}), so validation of the value under test was not exercised. Fill the remaining required field(s) and submit again.`,
      status: 'FAIL',
      validationTest: true,
      validationOutcome: 'inconclusive-other-required-field',
      thought: step.thought,
      reason: {
        expected: 'The invalid value under test is rejected by its own field validation',
        actual: detail,
        cause: 'Another required field was left empty, so the form stopped before validating the tested value',
        next: 'Fill all remaining required fields, then retry the invalid submit once',
      },
    };
  }

  if (rejectionShown) {
    return {
      name: validationName,
      input: actionResult.input,
      expected: step.expected || 'Invalid input is rejected with a visible validation error',
      actual: `Validation test PASSED: the app correctly rejected the invalid input (${detail}). This confirms the app DOES validate this field.`,
      status: 'PASS',
      validationTest: true,
      validationOutcome: 'rejected-as-expected',
      thought: step.thought,
    };
  }

  if (actionResult.status === 'FAIL') {
    return {
      ...actionResult,
      name: validationName,
      actual: `Validation test could not complete because the action failed: ${actionResult.actual}`,
      status: 'FAIL',
      validationTest: true,
      validationOutcome: 'action-failed',
      thought: step.thought,
    };
  }

  const acceptedDetail = acceptedEvidence
    ? `${detail} (the form closed or showed a success confirmation)`
    : `${detail} within ${waitMs}ms`;

  return {
    name: validationName,
    input: actionResult.input,
    expected: step.expected || 'Invalid input is rejected with a visible validation error',
    actual: `Validation test FAILED: the app accepted invalid input — this is a real validation bug (${acceptedDetail}).`,
    status: 'FAIL',
    validationTest: true,
    validationOutcome: 'invalid-input-accepted',
    thought: step.thought,
    reason: {
      expected: 'Invalid input should be rejected with a visible validation error',
      actual: acceptedDetail,
      cause: 'No validation feedback appeared; the invalid data was not blocked',
      next: 'Reproduce manually and check client/server validation for this field',
    },
  };
}

function resolveCredentials(val) {
  const str = String(val || '');
  return str
    .replace(/<(?:USERNAME|EMAIL)>/gi, process.env.TEST_USERNAME || '')
    .replace(/<PASSWORD>/gi, process.env.TEST_PASSWORD || '');
}

function maskValue(val) {
  const str = String(val || '');
  if (str.includes('<PASSWORD>')) return '••••••••';
  return str;
}

module.exports = router;
