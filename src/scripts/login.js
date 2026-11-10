require('dotenv').config({ quiet: true });

const { saveLogin } = require('../services/auth');

saveLogin()
  .then((file) => {
    console.log('Login saved.');
    console.log(`Session file: ${file}`);
    console.log('Browser checks and generated tests will reuse this session.');
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
