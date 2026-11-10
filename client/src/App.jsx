import { useState, useEffect } from "react";
import "./App.css";

const initialRecentRuns = [];

const initialReport = {
  title: "Invent Care Staging · Test Report",
  ranAgo: "Ready",
  cases: [
    {
      name: "Page loads & HTTP 200",
      input: "https://inventcarepm-landing-staging.azurewebsites.net",
      expected: "HTTP 200-399",
      actual: "HTTP 200",
      status: "PASS",
    },
    {
      name: "Document Title & Branding",
      input: "Document <title>",
      expected: 'Title contains "Invent Care"',
      actual: 'Title: "Invent Care"',
      status: "PASS",
    },
    {
      name: "Header Navigation & Anchor Links",
      input: "Click '#covered' / '#access'",
      expected: "Smooth scroll to target anchor section",
      actual: "Anchor elements #covered and #access attached in DOM",
      status: "PASS",
    },
    {
      name: "No Uncaught Console Errors",
      input: "Browser console listener",
      expected: "0 runtime exceptions",
      actual: "No console errors detected",
      status: "PASS",
    },
    {
      name: "Links Health Check",
      input: "All anchor hrefs",
      expected: "All discovered links return < 400",
      actual: "Checked 3 link(s), all working",
      status: "PASS",
    },
  ],
};

function StatusBadge({ status }) {
  return <span className={`badge ${status === "PASS" ? "badge-pass" : "badge-fail"}`}>{status}</span>;
}

export default function App() {
  const [targetUrl, setTargetUrl] = useState("https://invent-ui.vercel.app/admin/login");
  const [prompt, setPrompt] = useState(
    "Log in with the test credentials, navigate to the admin dashboard, and confirm the dashboard metrics and team sections load."
  );
  const [mode, setMode] = useState("agentic"); // "agentic" | "one-shot"
  const [files, setFiles] = useState([]);
  const [recentRuns, setRecentRuns] = useState(initialRecentRuns);
  const [report, setReport] = useState(initialReport);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeNav, setActiveNav] = useState("Dashboard");
  const [showProjectsModal, setShowProjectsModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Load real test runs from backend on mount
  useEffect(() => {
    fetchRecentRuns();
  }, []);

  const fetchRecentRuns = async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const formatted = data.map((r, i) => {
          const totalChecks = r.checks?.length || r.cases?.length || 0;
          const passedChecks = r.checks
            ? r.checks.filter((c) => c.passed).length
            : r.cases?.filter((c) => c.status === "PASS").length || 0;
          const failedChecks = totalChecks - passedChecks;

          let displayName = r.url;
          try {
            const parsed = new URL(r.url);
            displayName = parsed.pathname !== "/" ? `${parsed.hostname}${parsed.pathname}` : parsed.hostname;
          } catch {}

          return {
            id: r._id || i,
            raw: r,
            name: displayName,
            when: new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            checks: totalChecks,
            passed: passedChecks,
            failed: failedChecks,
          };
        });
        setRecentRuns(formatted);
      }
    } catch (e) {
      console.warn("Could not load backend runs:", e.message);
    }
  };

  const handleFileChange = (e) => {
    setFiles(Array.from(e.target.files));
  };

  const handleRunTests = async () => {
    setErrorMessage("");
    if (!targetUrl.trim() || !prompt.trim()) {
      setErrorMessage("Please fill in both the target URL and the test description.");
      return;
    }

    setIsRunning(true);
    try {
      const formData = new FormData();
      formData.append("url", targetUrl);
      formData.append("prompt", prompt);
      formData.append("mode", mode);
      files.forEach((f) => formData.append("files", f));

      const res = await fetch("/api/run-test", {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `Server responded with HTTP ${res.status}`);
      }

      if (data && data.cases) {
        setReport(data);
      }
      await fetchRecentRuns();

      // Scroll to report on complete
      const reportElem = document.getElementById("report-h");
      if (reportElem) {
        reportElem.scrollIntoView({ behavior: "smooth" });
      }
    } catch (err) {
      console.error("Test run failed:", err);
      setErrorMessage(err.message || "Could not complete the test run. Check the server logs.");
    } finally {
      setIsRunning(false);
    }
  };

  const selectPreset = (url, desc) => {
    setTargetUrl(url);
    if (desc) setPrompt(desc);
    setErrorMessage("");
  };

  const handleSelectRun = (run) => {
    if (!run.raw) return;

    let cases = [];
    if (Array.isArray(run.raw.cases) && run.raw.cases.length > 0) {
      cases = run.raw.cases;
    } else if (Array.isArray(run.raw.checks) && run.raw.checks.length > 0) {
      cases = run.raw.checks.map((c) => ({
        name: c.name,
        input: run.raw.url,
        expected: "Check passes criteria",
        actual: c.detail,
        status: c.passed ? "PASS" : "FAIL",
        reason: c.passed
          ? undefined
          : {
              expected: "Expected check to pass",
              actual: c.detail,
              cause: run.raw.errorMessage || "Validation failed on target page",
              next: "Inspect target element or review server logs",
            },
      }));
    }

    setReport({
      title: `${run.name} · Report`,
      ranAgo: run.when,
      cases,
      screenshotPath: run.raw.screenshotPath,
      mode: run.raw.mode,
    });
  };

  const handleNavClick = (tab) => {
    setActiveNav(tab);
    if (tab === "Dashboard") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (tab === "Reports") {
      const reportElem = document.getElementById("report-h");
      if (reportElem) reportElem.scrollIntoView({ behavior: "smooth" });
    } else if (tab === "Projects") {
      setShowProjectsModal(true);
    } else if (tab === "Settings") {
      setShowSettingsModal(true);
    }
  };

  const agentThoughts = report.cases.filter((c) => c.thought);

  return (
    <div className="app-shell">
      {/* ===== Top nav ===== */}
      <header className="topnav">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="20" height="20" rx="5" fill="#1C1B19" />
            <path
              d="M7 12.5L10 15.5L17 8.5"
              stroke="#F6F5F1"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="brand-name">Web Tester</span>
        </div>

        <nav aria-label="Primary" className="primary-nav">
          {["Dashboard", "Reports", "Projects", "Settings"].map((tab) => (
            <a
              key={tab}
              href={`#${tab.toLowerCase()}`}
              className={activeNav === tab ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                handleNavClick(tab);
              }}
            >
              {tab}
            </a>
          ))}
        </nav>

        <div className="nav-right">
          <span className="status-chip">
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
              <circle cx="4" cy="4" r="4" fill="#3F7D56" />
            </svg>
            Staging connected
          </span>
          <div className="avatar" aria-hidden="true" title="Invent Care Super Admin">
            IC
          </div>
        </div>
      </header>

      <main className="main">
        <h1 className="page-title">Run a new test</h1>
        <p className="page-subtitle">
          Point it at a target, tell it what to check in plain language, and let the autonomous Playwright engine test your web application.
        </p>

        <div className="grid">
          {/* Left: New test run */}
          <section className="card new-run-card" aria-labelledby="new-run-h">
            <h2 id="new-run-h" className="card-heading">
              New test run
            </h2>

            <div className="form-stack">
              <div className="field">
                <label htmlFor="target-url">Target URL</label>
                <input
                  id="target-url"
                  type="url"
                  placeholder="https://inventcarepm-landing-staging.azurewebsites.net"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                />
                <div className="target-presets">
                  <span className="hint" style={{ marginRight: 4 }}>
                    Quick targets:
                  </span>
                  <button
                    type="button"
                    className="preset-chip"
                    onClick={() =>
                      selectPreset(
                        "https://invent-ui.vercel.app/admin/login",
                        "Log in with the test credentials, navigate to the admin dashboard, and confirm the dashboard metrics and team sections load."
                      )
                    }
                  >
                    Admin Portal (Vercel)
                  </button>
                  <button
                    type="button"
                    className="preset-chip"
                    onClick={() =>
                      selectPreset(
                        "https://inventcarepm-landing-staging.azurewebsites.net",
                        "Verify landing page connectivity, title, header links, and early access form validation."
                      )
                    }
                  >
                    Invent Care Landing
                  </button>
                </div>
              </div>

              {/* Execution Engine Mode Selector */}
              <div className="field">
                <label>Execution Engine</label>
                <div className="mode-options">
                  <button
                    type="button"
                    className={`mode-btn ${mode === "agentic" ? "active" : ""}`}
                    onClick={() => setMode("agentic")}
                  >
                    <span className="mode-title">
                      🤖 Autonomous Loop (Agentic)
                    </span>
                    <span className="mode-desc">
                      Dynamic Observe-Decide-Act loop. Adapts to page changes in real-time up to 20 actions.
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`mode-btn ${mode === "one-shot" ? "active" : ""}`}
                    onClick={() => setMode("one-shot")}
                  >
                    <span className="mode-title">
                      ⚡ One-Shot Planner (Fast)
                    </span>
                    <span className="mode-desc">
                      Generates fixed atomic step sequence upfront. Faster and cheaper for simple checks.
                    </span>
                  </button>
                </div>
              </div>

              <div className="field">
                <label htmlFor="ai-prompt">What should Playwright check?</label>
                <textarea
                  id="ai-prompt"
                  rows={4}
                  placeholder="e.g. Log in with the test credentials, confirm the dashboard loads, then verify the team members table is visible."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <p className="hint">
                  {mode === "agentic"
                    ? "In Agentic mode, specify an open-ended goal. The agent will inspect the screen at each step and decide its actions."
                    : "In One-Shot mode, the planner converts your description into a fixed sequence of steps."}
                </p>
              </div>

              <div className="field">
                <label htmlFor="file-upload">Project files (optional)</label>
                <div className="dropzone">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 16V4M12 4L7 9M12 4L17 9"
                      stroke="#938E82"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M4 16V18C4 19.1 4.9 20 6 20H18C19.1 20 20 19.1 20 18V16"
                      stroke="#938E82"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Drag files here, or</span>
                  <label htmlFor="file-upload" className="browse-btn">
                    Browse files
                    <input id="file-upload" type="file" multiple onChange={handleFileChange} hidden />
                  </label>
                  <span className="dropzone-note">.env.example, specs, READMEs — max 5MB, max 5 files</span>
                </div>

                {files.length > 0 && (
                  <div className="chip-row">
                    {files.map((f) => (
                      <span key={f.name} className="file-chip">
                        {f.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {errorMessage && (
                <div className="error-banner" role="alert">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="button-row">
                <button type="button" className="btn-primary" onClick={handleRunTests} disabled={isRunning}>
                  {isRunning
                    ? mode === "agentic"
                      ? "Agent exploring & testing…"
                      : "Running test steps…"
                    : `Run tests (${mode === "agentic" ? "Agentic" : "One-shot"})`}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setTargetUrl("");
                    setPrompt("");
                    setFiles([]);
                    setErrorMessage("");
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          </section>

          {/* Right: Recent runs */}
          <aside className="card recent-card" aria-labelledby="recent-h">
            <h2 id="recent-h" className="card-heading">
              Recent runs
            </h2>
            <ul className="run-list">
              {recentRuns.length === 0 && (
                <li className="hint" style={{ padding: "10px 4px" }}>
                  No recent runs recorded yet.
                </li>
              )}
              {recentRuns.map((run) => (
                <li key={run.id}>
                  <div
                    className="run-row"
                    onClick={() => handleSelectRun(run)}
                    role="button"
                    tabIndex={0}
                  >
                    <span>
                      <span className="run-name">{run.name}</span>
                      <span className="run-meta">
                        {run.when} · {run.checks} checks
                      </span>
                    </span>
                    <span className={`run-badge ${run.failed > 0 ? "run-badge-fail" : "run-badge-pass"}`}>
                      {run.failed > 0 ? `${run.failed} fail` : `${run.passed} pass`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <a
              href="#"
              className="view-all"
              onClick={(e) => {
                e.preventDefault();
                fetchRecentRuns();
              }}
            >
              Refresh runs ↺
            </a>
          </aside>
        </div>

        {/* ===== Report ===== */}
        <section className="card report-card" aria-labelledby="report-h">
          <div className="report-header">
            <div>
              <h2 id="report-h" className="card-heading">
                {report.title}
              </h2>
              <span className="report-meta">
                {report.cases.length} test cases · {report.cases.filter((c) => c.status === "PASS").length} passed ·{" "}
                {report.cases.filter((c) => c.status === "FAIL").length} failed · ran {report.ranAgo}
                {report.mode && ` · Mode: ${report.mode}`}
              </span>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `test-report-${Date.now()}.json`;
                a.click();
              }}
            >
              Download JSON report
            </button>
          </div>

          {isRunning && (
            <div className="loading-box" role="status">
              <div className="spinner"></div>
              <span>
                {mode === "agentic"
                  ? `Agent dynamically observing and interacting with ${targetUrl}...`
                  : `Running automated Playwright test suite against ${targetUrl}...`}
              </span>
            </div>
          )}

          {!isRunning && (
            <>
              {/* Agent Decision & Reasoning Log (when in agentic mode) */}
              {agentThoughts.length > 0 && (
                <div className="agent-log-section">
                  <div className="agent-log-header">
                    <span className="agent-log-title">
                      🤖 Autonomous Agent Decision Log ({agentThoughts.length} decisions)
                    </span>
                    <span className="agent-log-pill">Observe-Decide-Act Timeline</span>
                  </div>
                  {agentThoughts.map((c, idx) => (
                    <div className="thought-card" key={idx}>
                      <div className="thought-card-top">
                        <span className="thought-step-num">Step {idx + 1}: {c.name}</span>
                        <StatusBadge status={c.status} />
                      </div>
                      <div className="thought-text">"{c.thought}"</div>
                      <div className="thought-details">
                        <span>Target: <code>{c.input}</code></span>
                        <span>Result: {c.actual}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="table-wrap" style={{ marginTop: 18 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Test case</th>
                      <th>Input / Target</th>
                      <th>Expected</th>
                      <th>Actual</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.cases.map((c, idx) => (
                      <tr key={idx} className={c.status === "FAIL" ? "row-fail" : ""}>
                        <td>
                          <strong>{c.name}</strong>
                        </td>
                        <td className="mono">{c.input}</td>
                        <td className="muted">{c.expected}</td>
                        <td className={c.status === "FAIL" ? "text-fail" : "muted"}>{c.actual}</td>
                        <td>
                          <StatusBadge status={c.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {report.screenshotPath && (
                <div className="screenshot-preview">
                  <a href={report.screenshotPath} target="_blank" rel="noopener noreferrer">
                    <img src={report.screenshotPath} alt="Test Run Screenshot" />
                  </a>
                </div>
              )}

              <div className="failure-details">
                {report.cases
                  .filter((c) => c.reason)
                  .map((c, idx) => (
                    <div className="failure-box" key={idx}>
                      <h3>Why it failed — {c.name}</h3>
                      <div className="failure-grid">
                        <span className="label">Expected</span>
                        <span>{c.reason.expected}</span>
                        <span className="label">Actual</span>
                        <span>{c.reason.actual}</span>
                        <span className="label">Likely cause</span>
                        <span>{c.reason.cause}</span>
                        <span className="label">Next step</span>
                        <span>{c.reason.next}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </section>
      </main>

      {/* Projects Modal */}
      {showProjectsModal && (
        <div className="modal-overlay" onClick={() => setShowProjectsModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Target Projects & Environments</h3>
              <button className="modal-close" onClick={() => setShowProjectsModal(false)}>✕</button>
            </div>
            <div className="project-card-item">
              <h4>Admin Portal (Vercel)</h4>
              <div className="project-url">https://invent-ui.vercel.app/admin/login</div>
              <p className="hint" style={{ marginTop: 6 }}>
                Protected Super Admin management console with user management, permissions, and client records.
              </p>
              <button
                type="button"
                className="btn-secondary"
                style={{ marginTop: 8 }}
                onClick={() => {
                  selectPreset(
                    "https://invent-ui.vercel.app/admin/login",
                    "Log in with the test credentials, navigate to the admin dashboard, and confirm the dashboard metrics and team sections load."
                  );
                  setShowProjectsModal(false);
                }}
              >
                Load into Runner
              </button>
            </div>
            <div className="project-card-item">
              <h4>Invent Care Landing (Azure Staging)</h4>
              <div className="project-url">https://inventcarepm-landing-staging.azurewebsites.net</div>
              <p className="hint" style={{ marginTop: 6 }}>
                Public landing page showcasing property management features, 3D interactive assets, and early access form.
              </p>
              <button
                type="button"
                className="btn-secondary"
                style={{ marginTop: 8 }}
                onClick={() => {
                  selectPreset(
                    "https://inventcarepm-landing-staging.azurewebsites.net",
                    "Verify landing page connectivity, title, header links, and early access form validation."
                  );
                  setShowProjectsModal(false);
                }}
              >
                Load into Runner
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>System Settings & Environment</h3>
              <button className="modal-close" onClick={() => setShowSettingsModal(false)}>✕</button>
            </div>
            <div className="failure-grid" style={{ gridTemplateColumns: "140px 1fr" }}>
              <span className="label">Gemini Model</span>
              <span className="mono">gemini-3.5-flash-lite (Active)</span>

              <span className="label">Agent Hard Cap</span>
              <span>20 actions per autonomous test run</span>

              <span className="label">Database</span>
              <span>MongoDB Atlas (with local JSON fallback)</span>

              <span className="label">Browser Runner</span>
              <span>Playwright Chromium (Headless)</span>

              <span className="label">Upload Limits</span>
              <span>Max 5MB per file · Max 5 files (.txt, .md, .json, .env, .js, .ts)</span>

              <span className="label">SSRF Protection</span>
              <span>Private IPv4, IPv6, localhost, and loopback blocked</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
