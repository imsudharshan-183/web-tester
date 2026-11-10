// Load values from .env into process.env.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const runsRouter = require('./routes/runs');
const sitesRouter = require('./routes/sites');
const runTestRouter = require('./routes/runTest');

const app = express();
const PORT = process.env.PORT || 3000;
const ARTIFACT_DIR = path.join(__dirname, '..', 'test-artifacts');

// Make sure the screenshot folder exists before anything tries to save there.
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/artifacts', express.static(ARTIFACT_DIR));
app.use('/api/runs', runsRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/run-test', runTestRouter);

// Always answer with JSON, even when the request body is malformed.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  const isPlaceholder = !mongoUri || mongoUri.includes('PASTE_ATLAS_PASSWORD_HERE') || mongoUri.includes('PASTE_');

  if (isPlaceholder) {
    console.warn('⚠️  MONGODB_URI contains placeholder credentials.');
    console.log('📦 Using local file storage fallback (test-artifacts/local-db.json).');
  } else {
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
      console.log('✅ Connected to MongoDB.');
    } catch (err) {
      console.warn(`⚠️  Could not connect to MongoDB (${err.message}).`);
      console.log('📦 Using local file storage fallback (test-artifacts/local-db.json).');
    }
  }

  return app.listen(PORT, () => {
    console.log(`Web Tester is running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
