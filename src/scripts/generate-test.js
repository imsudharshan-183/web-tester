require('dotenv').config({ quiet: true });

const { generateTest } = require('../services/aiAgent');

// Read simple flags such as: --url https://... --goal "..." --name "rent list"
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const url = arg('url');
const goal = arg('goal');
const name = arg('name');

generateTest({ url, goal, name })
  .then(({ recipe, filePath }) => {
    console.log('Generated test steps:');
    console.log(JSON.stringify(recipe.steps, null, 2));
    console.log('');
    console.log(`Saved recipe: ${filePath}`);
    console.log('Review the steps, then run them with:');
    console.log(`npm run test:recipe -- --file "${filePath}"`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
