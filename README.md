# Web Tester

A small personal tool for running basic checks on a website you own or have
permission to test. Paste a URL, click **Run test**, and Playwright loads the page
in headless Chromium. The results are saved in MongoDB and shown on the page.

## Important

Only test sites you own or have explicit permission to test. The server rejects
`localhost`, `127.0.0.1`, and private network addresses (`10.x`, `172.16-31.x`,
`192.168.x`, and similar local ranges), plus anything that is not `http` or
`https`.

## What it checks

- **Page loads** - the HTTP status is 200-399.
- **Has a title** - the document title is not empty.
- **No console errors** - fails if the page logs any errors.
- **Page has visible content** - the body contains visible text.
- **Links work** - up to 10 links are checked; any status 400+ or network error
  counts as broken.

A full-page screenshot is saved for each run in `test-artifacts/`. If the browser
crashes or times out, the run is marked failed with the error message.

## Saved login

If your staging app requires a login, save the session once and reuse it:

1. Add these values to `.env`:

   ```
   STAGING_LOGIN_URL=https://staging.example.com/login
   STAGING_POST_LOGIN_PATTERN=dashboard
   TEST_USERNAME=you@example.com
   TEST_PASSWORD=your-password
   ```

   `STAGING_POST_LOGIN_PATTERN` is a JavaScript regular expression matched against
   the URL after login. Use `dashboard`, not `/dashboard/`.

2. Run:

   ```powershell
   npm run login
   ```

This logs in with headless Chromium, waits for the post-login URL, and saves
`test-artifacts/auth-state.json`. The URL checks and saved tests reuse that
session automatically. Run `npm run login` again when the session expires, or
delete the state file to test logged out. The file holds cookies/localStorage and
is ignored by git.

## Generate a test once, replay it without AI

Gemini turns a plain-English goal into a saved JSON recipe. Replaying that recipe
uses Playwright only. **No Gemini call happens on a normal run.**

1. Add your Gemini settings to `.env`:

   ```
   GEMINI_API_KEY=your-api-key
   GEMINI_MODEL=gemini-2.5-flash
   ```

2. Run `npm run login` first if the page is behind a login.

3. Generate a recipe:

   ```powershell
   npm run generate -- --url "https://staging.example.com/properties" --goal "Search for Sunset Apartments and confirm the results list appears" --name "property-search"
   ```

   The command opens the page with the saved session, sends the goal and an
   accessibility snapshot (not a screenshot) to Gemini, checks the returned
   actions, and saves a recipe under `test-artifacts/generated-tests/`.

4. Review the printed steps, then replay them:

   ```powershell
   npm run test:recipe -- --file "test-artifacts/generated-tests/property-search-1234567890.json"
   ```

How the safety split works:

- Credentials are never sent to Gemini. The model is told to use `<USERNAME>`,
  `<EMAIL>`, and `<PASSWORD>` placeholders; your code swaps in the real values
  from `.env` only when the test runs.
- Generated recipes are JSON actions, not executable JavaScript. Only `fill`,
  `click`, `expectText`, `expectUrl`, and `press` are allowed.
- The accessibility snapshot can contain page text, so only use this on pages
  whose content you are comfortable sending to Google.
- Rerun `npm run generate` when a flow changes. Generation costs one Gemini
  request; replays are free.

## Tech

- Node.js + Express
- MongoDB + Mongoose
- Playwright with Chromium
- dotenv
- Plain HTML, CSS, and vanilla JavaScript (no build step)

## Requirements

- Node.js 18 or newer
- A MongoDB database (a free MongoDB Atlas cluster works)
- About 350 MB of disk space for the Chromium browser
- A Gemini API key (only needed to generate new test recipes)

## Setup

1. Open a terminal in this folder:

   ```powershell
   cd C:\web-tester
   ```

2. Install the Node packages:

   ```powershell
   npm install
   ```

3. Download the Chromium browser that Playwright uses:

   ```powershell
   npm run install:browser
   ```

4. Create your `.env` file:

   ```powershell
   copy .env.example .env
   ```

5. Open `.env` and replace the placeholders with your real MongoDB connection
   string:

   ```
   PORT=3000
   MONGODB_URI=mongodb+srv://youruser:yourpassword@yourhost/web_tester?retryWrites=true&w=majority
   ```

   If using MongoDB Atlas, create a database user and allow your IP address in
   Atlas. The login and Gemini values are optional until you use those features.

6. Start the app:

   ```powershell
   npm start
   ```

7. Open <http://localhost:3000>.

For auto-restart while editing, use `npm run dev`.

## Scripts

| Command                  | What it does                              |
| ------------------------ | ----------------------------------------- |
| `npm start`              | Starts the server.                        |
| `npm run dev`            | Starts the server and restarts on changes.|
| `npm run install:browser`| Downloads Chromium for Playwright.        |
| `npm run login`          | Logs in and saves `auth-state.json`.      |
| `npm run generate -- --url ... --goal ... [--name ...]` | Asks Gemini for a saved test recipe. |
| `npm run test:recipe -- --file ...` | Replays a saved recipe (no Gemini call). |

## API

| Method   | Path             | What it does                                            |
| -------- | ---------------- | ------------------------------------------------------- |
| `POST`   | `/api/runs`      | Starts a run. Body: `{ "url": "https://..." }`. Returns 202 with the run while checks continue in the background. |
| `GET`    | `/api/runs`      | Returns all runs, newest first.                          |
| `GET`    | `/api/runs/:id`  | Returns one run.                                         |
| `DELETE` | `/api/runs/:id`  | Deletes a run and its screenshot file.                   |

Screenshots are served at `/artifacts/<run-id>.png`.

## Project structure

```
web-tester/
  package.json
  .env.example
  .gitignore
  README.md
  src/
    server.js             # loads .env, connects to MongoDB, starts Express
    models/TestRun.js     # Mongoose schema for a test run
    routes/runs.js        # API routes and URL safety checks
    services/
      checker.js          # Playwright URL checks
      auth.js             # saved login session
      aiAgent.js          # Gemini recipe generation
      testRunner.js       # replays saved recipes
    scripts/
      login.js            # npm run login
      generate-test.js    # npm run generate
      run-test.js         # npm run test:recipe
  public/
    index.html            # page markup
    styles.css            # warm, minimal styling
    app.js                # API calls, list rendering, polling
  test-artifacts/
    auth-state.json       # saved login (gitignored)
    generated-tests/      # saved JSON recipes (gitignored)
    *.png                 # screenshots (gitignored)
```

## Notes for extending it

- Add a check in `src/services/checker.js` by pushing another `{ name, passed, detail }`
  object into the `checks` array.
- Playwright can test forms, links, and accessibility. Add those steps where the
  existing checks run.
- Screenshots are referenced by the public path `/artifacts/...`, while the file
  itself lives in `test-artifacts/`.
- Runs left as "running" after a server restart are not resumed automatically.
  Delete them and start a new test if needed.
- Add an allowed action in both `aiAgent.js` (validation) and `testRunner.js`
  (execution) if you want generated tests to do more.
- Generated recipes are ordinary JSON, so you can copy, edit, and reuse them
  without spending another Gemini request.
