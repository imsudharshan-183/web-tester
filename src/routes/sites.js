const express = require('express');
const { Site } = require('../models/dbAdapter');
const { validateUrl } = require('../services/urlSafety');
const { inspectSite } = require('../services/siteInspector');

const router = express.Router();

// GET /api/sites - all known sites, newest first.
router.get('/', async (req, res, next) => {
  try {
    const sites = await Site.find().sort({ createdAt: -1 });
    res.json(sites);
  } catch (err) {
    next(err);
  }
});

// POST /api/sites - read a site's title and description, then save it.
router.post('/', async (req, res, next) => {
  try {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const validation = await validateUrl(rawUrl);

    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    let info;
    try {
      info = await inspectSite(validation.url);
    } catch (err) {
      return res.status(502).json({
        error: `Could not read that page: ${firstLine(err.message)}`,
      });
    }

    const site = await Site.create({
      url: validation.url,
      name: info.name,
      summary: info.summary,
    });

    res.status(201).json(site);
  } catch (err) {
    next(err);
  }
});

function firstLine(message) {
  return String(message || 'Unknown error').split('\n')[0].slice(0, 300);
}

module.exports = router;
