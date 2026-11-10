/**
 * Automated Health & Regression Monitor for Staging Websites
 *
 * Usage:
 *   node src/scripts/monitor.js
 *   node src/scripts/monitor.js --url "https://inventcarepm-landing-staging.azurewebsites.net"
 *   node src/scripts/monitor.js --watch --interval 60
 */
require('dotenv').config();

const { runChecks } = require('../services/checker');
const { TestRun } = require('../models/dbAdapter');
const { validateUrl } = require('../services/urlSafety');

const DEFAULT_TARGET = 'https://inventcarepm-landing-staging.azurewebsites.net';

function parseArgs() {
  const args = process.argv.slice(2);
  let url = DEFAULT_TARGET;
  let watch = false;
  let intervalSeconds = 60;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[++i];
    } else if (args[i] === '--watch') {
      watch = true;
    } else if (args[i] === '--interval' && args[i + 1]) {
      intervalSeconds = parseInt(args[++i], 10) || 60;
    }
  }

  return { url, watch, intervalSeconds };
}

async function executeCheck(targetUrl) {
  const timestamp = new Date().toISOString();
  console.log(`\n======================================================`);
  console.log(`🕒 Automated Test Run at ${timestamp}`);
  console.log(`🎯 Target: ${targetUrl}`);
  console.log(`======================================================`);

  const validation = await validateUrl(targetUrl);
  if (!validation.ok) {
    console.error(`❌ Validation failed: ${validation.error}`);
    return false;
  }

  const runId = `monitor-${Date.now()}`;
  const record = await TestRun.create({
    url: validation.url,
    status: 'running',
  });

  const startTime = Date.now();
  const result = await runChecks(validation.url, record.id || runId);
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  const passed =
    !result.errorMessage &&
    result.checks.length > 0 &&
    result.checks.every((check) => check.passed);

  await TestRun.findByIdAndUpdate(record.id, {
    checks: result.checks,
    status: passed ? 'passed' : 'failed',
    screenshotPath: result.screenshotPath,
    errorMessage: result.errorMessage,
    finishedAt: new Date(),
  });

  console.log(`Status: ${passed ? '✅ PASSED' : '❌ FAILED'} (${duration}s)\n`);
  for (const check of result.checks) {
    const symbol = check.passed ? '  ✓' : '  ✗';
    console.log(`${symbol} [${check.name}]: ${check.detail}`);
  }

  if (result.screenshotPath) {
    console.log(`📸 Screenshot: ${result.screenshotPath}`);
  }
  if (result.errorMessage) {
    console.error(`⚠️ Error: ${result.errorMessage}`);
  }

  return passed;
}

async function main() {
  const { url, watch, intervalSeconds } = parseArgs();

  if (!watch) {
    const passed = await executeCheck(url);
    process.exit(passed ? 0 : 1);
  }

  console.log(`🚀 Automated Monitor started for ${url}`);
  console.log(`Interval: every ${intervalSeconds} seconds (Ctrl+C to stop)`);

  const runLoop = async () => {
    try {
      await executeCheck(url);
    } catch (err) {
      console.error(`💥 Execution error: ${err.message}`);
    }
  };

  await runLoop();
  setInterval(runLoop, intervalSeconds * 1000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
