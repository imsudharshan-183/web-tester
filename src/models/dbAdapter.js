const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const TestRunModel = require('./TestRun');
const SiteModel = require('./Site');

const LOCAL_DB_PATH = path.join(__dirname, '..', '..', 'test-artifacts', 'local-db.json');

function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

function loadLocalData() {
  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error reading local-db.json:', e.message);
  }
  return { runs: [], sites: [] };
}

function saveLocalData(data) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_DB_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing local-db.json:', e.message);
  }
}

const TestRun = {
  find() {
    if (isMongoConnected()) {
      return TestRunModel.find();
    }
    return {
      sort(criteria) {
        const data = loadLocalData();
        const runs = [...data.runs];
        if (criteria?.createdAt === -1) {
          runs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }
        return Promise.resolve(runs);
      },
    };
  },

  async findById(id) {
    if (isMongoConnected()) {
      return TestRunModel.findById(id);
    }
    const data = loadLocalData();
    return data.runs.find((r) => String(r._id) === String(id)) || null;
  },

  async create(payload) {
    if (isMongoConnected()) {
      return TestRunModel.create(payload);
    }
    const data = loadLocalData();
    const newRun = {
      _id: crypto.randomBytes(12).toString('hex'),
      url: payload.url,
      title: payload.title || null,
      prompt: payload.prompt || null,
      cases: payload.cases || [],
      status: payload.status || 'running',
      checks: payload.checks || [],
      screenshotPath: payload.screenshotPath || null,
      errorMessage: payload.errorMessage || null,
      createdAt: new Date().toISOString(),
      finishedAt: payload.finishedAt || null,
      ...payload,
    };
    newRun._id = newRun._id || crypto.randomBytes(12).toString('hex');
    newRun.id = newRun._id;
    data.runs.unshift(newRun);
    saveLocalData(data);
    return newRun;
  },

  async findByIdAndUpdate(id, updates) {
    if (isMongoConnected()) {
      return TestRunModel.findByIdAndUpdate(id, updates, { returnDocument: 'after' });
    }
    const data = loadLocalData();
    const index = data.runs.findIndex((r) => String(r._id) === String(id));
    if (index === -1) return null;

    data.runs[index] = {
      ...data.runs[index],
      ...updates,
      finishedAt: updates.finishedAt || data.runs[index].finishedAt,
    };
    saveLocalData(data);
    return data.runs[index];
  },

  async findByIdAndDelete(id) {
    if (isMongoConnected()) {
      return TestRunModel.findByIdAndDelete(id);
    }
    const data = loadLocalData();
    const index = data.runs.findIndex((r) => String(r._id) === String(id));
    if (index === -1) return null;

    const [deleted] = data.runs.splice(index, 1);
    saveLocalData(data);
    return deleted;
  },
};

const Site = {
  find() {
    if (isMongoConnected()) {
      return SiteModel.find();
    }
    return {
      sort(criteria) {
        const data = loadLocalData();
        const sites = [...data.sites];
        if (criteria?.createdAt === -1) {
          sites.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }
        return Promise.resolve(sites);
      },
    };
  },

  async create(payload) {
    if (isMongoConnected()) {
      return SiteModel.create(payload);
    }
    const data = loadLocalData();
    const newSite = {
      _id: crypto.randomBytes(12).toString('hex'),
      url: payload.url,
      name: payload.name || '',
      summary: payload.summary || '',
      createdAt: new Date().toISOString(),
    };
    newSite.id = newSite._id;
    data.sites.unshift(newSite);
    saveLocalData(data);
    return newSite;
  },
};

module.exports = {
  TestRun,
  Site,
  isMongoConnected,
};
