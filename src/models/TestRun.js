const mongoose = require('mongoose');

// One individual check, such as "Has a title".
const checkSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    passed: { type: Boolean, required: true },
    detail: { type: String, default: '' },
  },
  { _id: false }
);

// One test run of one URL.
const testRunSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    title: { type: String, default: null },
    prompt: { type: String, default: null },
    status: {
      type: String,
      enum: ['running', 'passed', 'failed'],
      default: 'running',
    },
    checks: { type: [checkSchema], default: [] },
    cases: { type: mongoose.Schema.Types.Mixed, default: [] },
    screenshotPath: { type: String, default: null },
    errorMessage: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
  },
  { strict: false }
);

module.exports = mongoose.model('TestRun', testRunSchema);
