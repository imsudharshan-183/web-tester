require('dotenv').config({ quiet: true });

const { runRecipe } = require('../services/testRunner');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const filePath = arg('file') || process.argv[2];

if (!filePath) {
  console.error('Usage: npm run test:recipe -- --file test-artifacts/generated-tests/<name>.json');
  process.exit(1);
}

runRecipe(filePath)
  .then((result) => {
    console.log(`Status: ${result.status}`);
    console.log('');

    for (const check of result.checks) {
      console.log(`${check.passed ? 'PASS' : 'FAIL'} - ${check.name}: ${check.detail}`);
    }

    if (result.errorMessage) {
      console.log(`Error: ${result.errorMessage}`);
    }
    if (result.screenshotPath) {
      console.log(`Screenshot: ${result.screenshotPath}`);
    }

    if (result.status !== 'passed') {
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
