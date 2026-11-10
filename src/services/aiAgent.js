const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { hasSavedLogin, STATE_FILE, requireEnv } = require('./auth');

const RECIPE_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'generated-tests');
const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_STEPS = 12;
const MAX_SNAPSHOT = 16000;

const ALLOWED_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'option',
  'combobox',
  'textbox',
  'searchbox',
]);

/**
 * Open the page, ask Gemini for a test recipe, validate it, and save it.
 * Gemini is called once here. Replaying the saved recipe never calls Gemini.
 */
async function generateTest({ url, goal, name }) {
  if (!url || !goal) {
    throw new Error('Both --url and --goal are required.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Please provide a valid http or https URL.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed.');
  }

  const apiKey = requireEnv('GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  // Use the saved login so Gemini sees the page the user actually wants to test.
  const browser = await chromium.launch({ headless: true });
  let title = '';
  let pageSnapshot = '';

  try {
    const context = await browser.newContext(
      (await hasSavedLogin()) ? { storageState: STATE_FILE } : {}
    );
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);
    title = await page.title();
    pageSnapshot = shorten(await page.locator('body').ariaSnapshot(), MAX_SNAPSHOT);
  } catch (err) {
    throw new Error(`Could not open the page for generation: ${firstLine(err.message)}`);
  } finally {
    await browser.close().catch(() => {});
  }

  const rawSteps = await askGemini({ apiKey, model, url, goal, title, pageSnapshot });
  const steps = validateSteps(rawSteps);

  const recipe = {
    name: name || shorten(goal, 60),
    url,
    goal,
    model,
    steps,
    createdAt: new Date().toISOString(),
  };

  await fs.mkdir(RECIPE_DIR, { recursive: true });
  const filePath = path.join(RECIPE_DIR, `${slugify(recipe.name)}-${Date.now()}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');

  return { recipe, filePath };
}

// One Gemini request. The API key goes in a header, never in the URL.
async function askGemini({ apiKey, model, url, goal, title, pageSnapshot }) {
  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const modelId = model.replace(/^models\//, '');
  const endpoint = `${base}/models/${encodeURIComponent(modelId)}:generateContent`;
  const prompt = buildPrompt({ url, goal, title, pageSnapshot });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${shorten(body, 300)}`);
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('');

  if (!text) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned an empty response.');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch {
    throw new Error('Gemini did not return valid JSON. Try again or change GEMINI_MODEL.');
  }

  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('Gemini response is missing a "steps" array.');
  }

  return parsed.steps;
}

function buildPrompt({ url, goal, title, pageSnapshot }) {
  return `You are generating a short, replayable browser test as JSON.

Page URL: ${url}
Page title: ${title || '(untitled)'}
Goal: ${goal}

Accessibility snapshot of the page:
---
${pageSnapshot}
---

Return only JSON in this shape:
{
  "steps": [
    { "action": "fill", "label": "Email", "value": "<USERNAME>" },
    { "action": "click", "role": "button", "name": "Sign in" },
    { "action": "expectText", "text": "Dashboard" },
    { "action": "expectUrl", "pattern": "dashboard" }
  ]
}

Rules:
- Use 1 to ${MAX_STEPS} steps.
- Allowed actions: fill, click, expectText, expectUrl, press.
- fill: use the exact visible label and either a literal value or one of <USERNAME>, <EMAIL>, <PASSWORD>.
- click: use an ARIA role and accessible name that appear in the snapshot.
- expectText: visible text that should appear.
- expectUrl: a regular expression source such as "dashboard", not "/dashboard/".
- press: a key such as "Enter".
- Never output real credentials, cookies, tokens, or secrets. Use placeholders.
- The browser may already be logged in from a saved session. Do not include login steps unless the goal needs them.
- Do not include goto steps or invent other URLs. The runner starts at the Page URL.
- Return no markdown, comments, or JavaScript code.`;
}

// Only a small, fixed set of actions is allowed. No generated code is executed.
function validateSteps(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('The recipe must contain at least one step.');
  }
  if (rawSteps.length > MAX_STEPS) {
    throw new Error(`The recipe has too many steps (maximum ${MAX_STEPS}).`);
  }

  return rawSteps.map((raw, index) => validateStep(raw, index));
}

function validateStep(raw, index) {
  const where = `Step ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object.`);
  }

  switch (raw.action) {
    case 'fill':
      return {
        action: 'fill',
        label: requireText(raw.label, `${where} fill label`, 200),
        value: requireText(raw.value, `${where} fill value`, 500),
      };

    case 'click': {
      const role = requireText(raw.role, `${where} click role`, 30).toLowerCase();
      if (!ALLOWED_ROLES.has(role)) {
        throw new Error(`${where} uses an unsupported role: ${role}`);
      }
      return {
        action: 'click',
        role,
        name: requireText(raw.name, `${where} click name`, 200),
      };
    }

    case 'expectText':
      return {
        action: 'expectText',
        text: requireText(raw.text, `${where} expected text`, 300),
      };

    case 'expectUrl': {
      const pattern = requireText(raw.pattern, `${where} URL pattern`, 200);
      try {
        new RegExp(pattern);
      } catch {
        throw new Error(`${where} has an invalid URL pattern.`);
      }
      return { action: 'expectUrl', pattern };
    }

    case 'press': {
      const key = requireText(raw.key, `${where} key`, 30);
      if (!/^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*$/.test(key)) {
        throw new Error(`${where} has an unsupported key.`);
      }
      return { action: 'press', key };
    }

    default:
      throw new Error(`${where} uses an unsupported action: ${String(raw.action)}`);
  }
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} is too long (maximum ${maxLength} characters).`);
  }
  return value.trim();
}

function stripCodeFences(text) {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'test'
  );
}

function firstLine(message) {
  return String(message || 'Unknown error').split('\n')[0].slice(0, 300);
}

function shorten(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

module.exports = { generateTest, validateSteps, MAX_STEPS };
