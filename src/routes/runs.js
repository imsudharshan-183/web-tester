const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const mongoose = require('mongoose');
const { TestRun } = require('../models/dbAdapter');
const { runChecks } = require('../services/checker');
const { validateUrl } = require('../services/urlSafety');
const { getLatestAccountForRun, runCleanupStandalone } = require('../services/cleanup');

const router = express.Router();
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts');

// GET /api/runs - all runs, newest first.
router.get('/', async (req, res, next) => {
  try {
    const runs = await TestRun.find().sort({ createdAt: -1 });
    res.json(runs);
  } catch (err) {
    next(err);
  }
});

// GET /api/runs/:id - one run.
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid run id.' });
    }

    const run = await TestRun.findById(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found.' });
    }

    res.json(run);
  } catch (err) {
    next(err);
  }
});

// POST /api/runs/:id/cleanup - best-effort delete/deactivate of the record the
// run created. Hard-capped at 30s so it can never hang the request.
router.post('/:id/cleanup', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid run id.' });
    }

    const run = await TestRun.findById(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found.' });
    }

    const account = getLatestAccountForRun(req.params.id);
    if (!account) {
      return res
        .status(404)
        .json({ error: 'No created test account is recorded for this run.' });
    }

    const cleanup = await runCleanupStandalone({ runId: req.params.id, account });
    res.json({ runId: req.params.id, cleanup });
  } catch (err) {
    next(err);
  }
});

// POST /api/runs - start a test run in the background.
router.post('/', async (req, res, next) => {
  try {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const validation = await validateUrl(rawUrl);

    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const run = await TestRun.create({ url: validation.url, status: 'running' });

    // Reply right away. The browser work continues after the response is sent.
    res.status(202).json(run);

    runChecks(run.url, run.id)
      .then(async (result) => {
        const passed =
          !result.errorMessage &&
          result.checks.length > 0 &&
          result.checks.every((check) => check.passed);

        const updated = await TestRun.findByIdAndUpdate(run.id, {
          checks: result.checks,
          status: passed ? 'passed' : 'failed',
          screenshotPath: result.screenshotPath,
          errorMessage: result.errorMessage,
          finishedAt: new Date(),
        });

        // If the run was deleted while the browser was working, remove its screenshot.
        if (!updated && result.screenshotPath) {
          console.log(`Run ${run.id} was deleted; removing its screenshot.`);
          const filePath = path.join(ARTIFACT_DIR, path.basename(result.screenshotPath));
          await fs.unlink(filePath).catch((err) => {
            console.error(`Could not remove screenshot: ${err.message}`);
          });
        }

        return updated;
      })
      .catch((err) => {
        console.error(`Run ${run.id} failed unexpectedly:`, err);
        return TestRun.findByIdAndUpdate(run.id, {
          status: 'failed',
          errorMessage: err.message,
          finishedAt: new Date(),
        }).catch(() => {});
      });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/runs/:id - remove the run and its screenshot.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid run id.' });
    }

    const run = await TestRun.findByIdAndDelete(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found.' });
    }

    if (run.screenshotPath) {
      // Keep just the filename so a bad path can never delete something else.
      const filePath = path.join(ARTIFACT_DIR, path.basename(run.screenshotPath));
      await fs.unlink(filePath).catch(() => {});
    }

    res.json({ message: 'Run deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
