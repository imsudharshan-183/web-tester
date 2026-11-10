// Elements from the page.
const form = document.querySelector('#run-form');
const input = document.querySelector('#url-input');
const runButton = document.querySelector('#run-button');
const errorMessage = document.querySelector('#error-message');
const runList = document.querySelector('#run-list');
const emptyState = document.querySelector('#empty-state');

// One polling timer per running run, keyed by run id.
const pollTimers = new Map();

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function clearError() {
  errorMessage.textContent = '';
  errorMessage.hidden = true;
}

// Normalizes raw user input by adding https:// if no scheme is present.
function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

// Quick client-side check. The server also checks the URL and private addresses.
function isValidUrl(value) {
  try {
    const parsed = new URL(normalizeUrl(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatDate(value) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Small helper so we never put untrusted text into innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status) {
  return { running: 'Running', passed: 'Passed', failed: 'Failed' }[status] || status;
}

function createRunCard(run) {
  const card = el('li', 'run-card');
  card.dataset.runId = run._id;

  // URL, date, and status badge.
  const top = el('div', 'run-top');
  const info = el('div', 'run-info');

  const url = el('a', 'run-url', run.url);
  url.href = run.url;
  url.target = '_blank';
  url.rel = 'noopener noreferrer';

  info.append(url, el('span', 'run-date', formatDate(run.createdAt)));
  top.append(info, el('span', `badge badge-${run.status}`, statusLabel(run.status)));
  card.append(top);

  // Checks, or a progress line while the browser is working.
  if (run.status === 'running') {
    card.append(el('p', 'run-progress', 'Running checks...'));
  } else if (run.checks && run.checks.length > 0) {
    const checks = el('ul', 'checks');

    for (const check of run.checks) {
      const item = el('li', 'check');
      const mark = el('span', `check-mark ${check.passed ? 'passed' : 'failed'}`, check.passed ? '✓' : '✗');
      mark.setAttribute('aria-hidden', 'true');

      const text = el('div', 'check-text');
      text.append(
        el('span', 'check-name', check.name),
        el('span', 'check-detail', check.detail || '')
      );

      item.append(mark, text);
      checks.append(item);
    }

    card.append(checks);
  }

  if (run.errorMessage) {
    card.append(el('p', 'run-error', run.errorMessage));
  }

  // Screenshot link and Delete button.
  const footer = el('div', 'run-footer');
  if (run.screenshotPath) {
    const shot = el('a', 'screenshot-link', 'View screenshot');
    shot.href = run.screenshotPath;
    shot.target = '_blank';
    shot.rel = 'noopener noreferrer';
    footer.append(shot);
  } else {
    footer.append(el('span')); // Spacer keeps Delete on the right.
  }

  const deleteButton = el('button', 'delete-button', 'Delete');
  deleteButton.type = 'button';
  footer.append(deleteButton);
  card.append(footer);

  return card;
}

function stopPolling() {
  for (const timer of pollTimers.values()) clearInterval(timer);
  pollTimers.clear();
}

function startPolling(id) {
  if (pollTimers.has(id)) return;

  const timer = setInterval(() => pollRun(id, timer), 2000);
  pollTimers.set(id, timer);
}

async function pollRun(id, timer) {
  try {
    const response = await fetch(`/api/runs/${id}`);

    if (response.status === 404) {
      clearInterval(timer);
      pollTimers.delete(id);
      return;
    }

    if (!response.ok) return;

    const run = await response.json();
    replaceCard(run);

    if (run.status !== 'running') {
      clearInterval(timer);
      pollTimers.delete(id);
    }
  } catch {
    // Network hiccup: keep the timer and try again in two seconds.
  }
}

function replaceCard(run) {
  const current = runList.querySelector(`[data-run-id="${run._id}"]`);
  if (current) current.replaceWith(createRunCard(run));
}

function renderRuns(runs) {
  stopPolling();
  runList.innerHTML = '';
  emptyState.hidden = runs.length > 0;
  runList.hidden = runs.length === 0;

  for (const run of runs) {
    runList.append(createRunCard(run));
    if (run.status === 'running') startPolling(run._id);
  }
}

async function loadRuns() {
  try {
    const response = await fetch('/api/runs');
    if (!response.ok) throw new Error('Could not load runs.');
    renderRuns(await response.json());
  } catch {
    showError('Could not load test runs. Make sure the server is running.');
  }
}

// Start a new test run.
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const rawUrl = input.value.trim();
  const url = normalizeUrl(rawUrl);

  if (!url || !isValidUrl(url)) {
    showError('Please enter a valid website address.');
    input.focus();
    return;
  }

  input.value = url;
  runButton.disabled = true;
  runButton.textContent = 'Starting...';

  try {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      showError(data.error || 'Could not start the test. Please try again.');
      return;
    }

    input.value = '';
    await loadRuns();
  } catch {
    showError('Could not reach the server. Is it running?');
  } finally {
    runButton.disabled = false;
    runButton.textContent = 'Run test';
  }
});

// Click quick test suggestions
document.querySelectorAll('.quick-chip').forEach((button) => {
  button.addEventListener('click', () => {
    input.value = button.dataset.url;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  });
});

// Delete a run and its screenshot.
runList.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-button');
  if (!button) return;

  const card = button.closest('.run-card');
  if (!card) return;

  clearError();
  button.disabled = true;
  button.textContent = 'Deleting...';

  try {
    const response = await fetch(`/api/runs/${card.dataset.runId}`, {
      method: 'DELETE',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      showError(data.error || 'Could not delete this run.');
      button.disabled = false;
      button.textContent = 'Delete';
      return;
    }

    await loadRuns();
  } catch {
    showError('Could not reach the server. Is it running?');
    button.disabled = false;
    button.textContent = 'Delete';
  }
});

// Load existing runs when the page opens.
loadRuns();
