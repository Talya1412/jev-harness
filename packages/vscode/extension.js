"use strict";
/**
 * jev-harness VS Code extension.
 *
 * Two commands:
 *   jev-harness.review   — run a destructive-change gate over the active
 *                          editor's content (or git diff). Shows P(destructive)
 *                          and a BLOCKED/ALLOW verdict in a webview, with a
 *                          threshold slider (default 0.5, the one true veto).
 *   jev-harness.verify   — treat the selection as a claim and the file body as
 *                          the source; run the RAG verification gate.
 *
 * Configuration: jev-harness.apiKey, .baseUrl, .model, .threshold.
 * Fail-open: with no key, the commands surface a clear message and never
 * throw — advisory, never blocking.
 */
const vscode = require("vscode");
const {
  JevError,
  judgeDestructive,
  verifyClaim,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
} = require("./jev");

/** @type {import("./jev").JevConfig} */
function cfg() {
  const c = vscode.workspace.getConfiguration("jev-harness");
  return {
    apiKey: c.get("apiKey") || process.env.TYPESAFE_API_KEY || "",
    baseUrl: c.get("baseUrl") || DEFAULT_BASE_URL,
    model: c.get("model") || DEFAULT_MODEL,
    threshold: c.get("threshold") ?? 0.5,
  };
}

function activate(context) {
  const review = vscode.commands.registerCommand("jev-harness.review", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("jev: open a file to review.");
      return;
    }
    const doc = editor.document;
    const config = cfg();
    const content = doc.getText().slice(0, 8000);
    const call = { tool: doc.fileName, input: { content } };
    if (!config.apiKey) {
      showWebview(context, "jev: review", reviewHtmlNoKey());
      return;
    }
    try {
      const r = await judgeDestructive(config, call, { threshold: config.threshold });
      showWebview(context, "jev: review", reviewHtml(r, config.threshold, doc.fileName));
    } catch (e) {
      showWebview(context, "jev: review", errorHtml(e));
    }
  });

  const verify = vscode.commands.registerCommand("jev-harness.verify", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("jev: open a file and select a claim.");
      return;
    }
    const config = cfg();
    const sel = editor.selection;
    const claim = sel.isEmpty ? "" : editor.document.getText(sel);
    if (!claim) {
      vscode.window.showInformationMessage("jev: select a claim to verify.");
      return;
    }
    const source = editor.document.getText().slice(0, 8000);
    if (!config.apiKey) {
      showWebview(context, "jev: verify", reviewHtmlNoKey("verify"));
      return;
    }
    try {
      const r = await verifyClaim(config, { claim, source });
      showWebview(context, "jev: verify", verifyHtml(r));
    } catch (e) {
      showWebview(context, "jev: verify", errorHtml(e));
    }
  });

  context.subscriptions.push(review, verify);
}

function deactivate() {}

// --- webview html ---

function showWebview(context, title, html) {
  const panel = vscode.window.createWebviewPanel("jev-harness", title, vscode.ViewColumn.Beside, {
    enableScripts: true,
  });
  panel.webview.html = html;
}

const S = `
  body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:#1e1e1e;color:#e6edf3;padding:16px;font-size:13px}
  .p{font-family:ui-monospace,monospace} .big{font-size:42px;font-weight:700}
  .block{color:#f85149} .allow{color:#3fb950} .muted{color:#8b949e}
  .bar{height:14px;background:#333;border-radius:7px;overflow:hidden;margin:8px 0}
  .fill{height:100%;background:#d29922;border-radius:7px}
  .fill.block{background:#f85149} .fill.allow{background:#3fb950}
  input[type=range]{width:100%}
`;

function reviewHtml(r, threshold, file) {
  const blocked = r.blocked;
  const cls = blocked ? "block" : "allow";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${S}</style></head><body>
    <div class="muted">destructive-change gate · ${esc(file)}</div>
    <div class="big ${cls}">${blocked ? "BLOCKED" : "ALLOW"}</div>
    <div class="p">P(destructive) = ${r.destructive.toFixed(3)}  ·  threshold ${threshold.toFixed(2)}</div>
    <div class="bar"><div class="fill ${cls}" style="width:${(r.destructive * 100).toFixed(1)}%"></div></div>
    <div class="muted">advisory only. fail-open by design — this never hard-stops your editor.</div>
  </body></html>`;
}

function verifyHtml(r) {
  const bad = r.unsupported;
  const cls = bad ? "block" : "allow";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${S}</style></head><body>
    <div class="muted">RAG verification gate</div>
    <div class="big ${cls}">${bad ? "UNSUPPORTED" : "SUPPORTED"}</div>
    <div class="p">P(supported) = ${r.supported.toFixed(3)}</div>
    <div class="bar"><div class="fill ${cls}" style="width:${(r.supported * 100).toFixed(1)}%"></div></div>
    <div class="muted">claim not entailed by the source — revise or drop it.</div>
  </body></html>`;
}

function reviewHtmlNoKey(which = "review") {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${S}</style></head><body>
    <div class="big muted">no API key</div>
    <div>Set <code class="p">jev-harness.apiKey</code> (or <code class="p">TYPESAFE_API_KEY</code>) to run the ${which} gate. Fail-open: nothing is blocked.</div>
  </body></html>`;
}

function errorHtml(e) {
  const isJev = e instanceof JevError;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${S}</style></head><body>
    <div class="big block">ERROR</div>
    <div class="p">${esc(e.message)}</div>
    <div class="muted">${isJev ? `jev error · retryable=${e.retryable}${e.status ? " · status=" + e.status : ""}` : e.name}</div>
    <div class="muted">fail-open: the gate did not block.</div>
  </body></html>`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

module.exports = { activate, deactivate, cfg };
