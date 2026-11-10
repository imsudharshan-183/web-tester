const mongoose = require('mongoose');

// One website the tester knows about.
const siteSchema = new mongoose.Schema({
  url: { type: String, required: true, trim: true },
  name: { type: String, default: '', trim: true },
  summary: { type: String, default: '', trim: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Site', siteSchema);
