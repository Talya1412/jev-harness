"use strict";
// jev playground — zero dependencies. Talks to /v1/systemone directly; falls
// back to a deterministic mock when no API key is present, so the UI is fully
// demoable without a backend (browser CORS may require a proxy for real calls).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  questions: [
    { id: "destructive", type: "noul", instructions: "Running this exact tool call would destroy or irreversibly change data, history, or system state (recursive/bulk deletion, overwriting existing files without backup, force-push, dropping tables, killing processes, spending money, or sending secrets to an external endpoint). Reading, searching, listing, creating a brand-new file, or editing a file in place with a normal edit tool is NOT destructive." },
  ],
  answers: null,
  thresholds: {}, // id -> current threshold for the gate slider
};

// --------------------------- questions editor ---------------------------

function renderQuestions() {
  const box = $("#questions");
  box.innerHTML = "";
  state.questions.forEach((q, i) => {
    const card = document.createElement("div");
    card.className = "q";
    card.innerHTML = `
      <div class="qhead">
        <input class="qid" value="${esc(q.id)}" data-i="${i}" data-f="id" />
        <select data-i="${i}" data-f="type">
          <option value="noul"${q.type === "noul" ? " selected" : ""}>noul</option>
          <option value="choice"${q.type === "choice" ? " selected" : ""}>choice</option>
          <option value="score"${q.type === "score" ? " selected" : ""}>score</option>
        </select>
        <button class="mini" data-i="${i}" data-act="del">×</button>
      </div>
      <textarea class="qinstr" data-i="${i}" data-f="instructions" placeholder="instructions…">${esc(q.instructions)}</textarea>
      <div class="crit" data-i="${i}"></div>`;
    box.appendChild(card);
    renderCriteria(i);
  });
  wireQuestions();
}

function renderCriteria(i) {
  const q = state.questions[i];
  const wrap = document.querySelector(`.crit[data-i="${i}"]`);
  if (!wrap) return;
  if (q.type === "choice") {
    q.criteria = q.criteria && q.criteria.length ? q.criteria : [{ key: "yes", desc: "" }, { key: "no", desc: "" }];
    wrap.innerHTML = `<div class="crit-label">criteria (key → description, ≥ 2)</div>` +
      q.criteria.map((c, j) => `
        <div class="bar-row">
          <input class="label" data-i="${i}" data-j="${j}" data-f="ckey" value="${esc(c.key)}" />
          <input style="flex:2" data-i="${i}" data-j="${j}" data-f="cdesc" value="${esc(c.desc)}" placeholder="description" />
          <button class="mini" data-i="${i}" data-j="${j}" data-act="cdel">×</button>
        </div>`).join("") +
      `<button class="ghost" data-i="${i}" data-act="cadd" style="margin-top:6px">+ option</button>`;
  } else if (q.type === "score") {
    q.criteria = Array.isArray(q.criteria) && q.criteria.length ? q.criteria : ["Low", "Medium", "High", "Critical"];
    wrap.innerHTML = `<div class="crit-label">ordered levels (lowest first, ≥ 2, one per line)</div>
      <textarea data-i="${i}" data-f="slevels">${esc(q.criteria.join("\n"))}</textarea>`;
  } else {
    wrap.innerHTML = "";
  }
}

function wireQuestions() {
  $$("#questions [data-f]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const i = +e.target.dataset.i;
      const f = e.target.dataset.f;
      const q = state.questions[i];
      if (f === "type") { q.type = e.target.value; renderCriteria(i); }
      else if (f === "id") q.id = e.target.value;
      else if (f === "instructions") q.instructions = e.target.value;
      else if (f === "slevels") q.criteria = e.target.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
      else if (f === "ckey") q.criteria[+e.target.dataset.j].key = e.target.value;
      else if (f === "cdesc") q.criteria[+e.target.dataset.j].desc = e.target.value;
    });
  });
  $$("#questions [data-act]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const i = +e.target.dataset.i;
      const act = e.target.dataset.act;
      const q = state.questions[i];
      if (act === "del") { state.questions.splice(i, 1); renderQuestions(); }
      else if (act === "cadd") { q.criteria.push({ key: "opt", desc: "" }); renderCriteria(i); wireQuestions(); }
      else if (act === "cdel") { if (q.criteria.length > 1) { q.criteria.splice(+e.target.dataset.j, 1); renderCriteria(i); wireQuestions(); } }
    });
  });
}

$("#addQ").addEventListener("click", () => {
  state.questions.push({ id: "q" + (state.questions.length + 1), type: "noul", instructions: "" });
  renderQuestions();
});

// --------------------------- run ---------------------------

async function runJev() {
  const baseUrl = $("#baseUrl").value.trim().replace(/\/+$/, "");
  const apiKey = $("#apiKey").value.trim();
  const model = $("#model").value.trim() || "jev-latest";
  const useMock = $("#mock").checked && !apiKey;

  let stateObj;
  try { stateObj = JSON.parse($("#state").value); }
  catch (e) { return setStatus("invalid state JSON: " + e.message, true); }

  if (!state.questions.length) return setStatus("add at least one question", true);
  const questions = {};
  for (const q of state.questions) {
    if (!q.id || !q.instructions) return setStatus(`question "${q.id || "?"}" needs id + instructions`, true);
    const entry = { type: q.type, instructions: q.instructions };
    if (q.type === "choice") {
      const obj = {};
      for (const c of q.criteria) if (c.key) obj[c.key] = c.desc || c.key;
      if (Object.keys(obj).length < 2) return setStatus(`choice "${q.id}" needs ≥ 2 criteria`, true);
      entry.criteria = obj;
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) return setStatus(`score "${q.id}" needs ≥ 2 levels`, true);
      entry.criteria = q.criteria;
    }
    questions[q.id] = entry;
  }

  setStatus(useMock ? "mock…" : "calling jev…");
  let res;
  try {
    if (useMock) {
      res = mockResponse(stateObj, questions);
      await new Promise((r) => setTimeout(r, 250)); // feel real
    } else {
      res = await callJev(baseUrl, apiKey, model, stateObj, questions);
    }
  } catch (e) {
    return setStatus("request failed: " + e.message + " — tip: browsers block cross-origin calls; use the mock or a proxy.", true);
  }
  if (!res || !res.answers) return setStatus("response missing `answers`", true);
  state.answers = res.answers;
  state.thresholds = {};
  for (const id of Object.keys(res.answers)) {
    // sensible default thresholds per pattern
    const a = res.answers[id];
    state.thresholds[id] = a.type === "noul" ? 0.75 : 0.5;
  }
  setStatus((useMock ? "mock · " : "") + "ok · model=" + (res.model || "?"), false);
  renderAnswers();
  $("#raw").textContent = JSON.stringify(res, null, 2);
}

async function callJev(baseUrl, apiKey, model, stateObj, questions) {
  const r = await fetch(baseUrl + "/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model, state: stateObj, questions }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
  return JSON.parse(text);
}

// Deterministic mock so the UI is demoable without a key. Produces plausible
// probabilities from the state content; not a real model.
function mockResponse(stateObj, questions) {
  const blob = JSON.stringify(stateObj).toLowerCase();
  const danger = /rm -rf|drop|delete|force|prod|destroy|wipe|truncate/.test(blob);
  const dangerP = danger ? 0.92 : 0.08;
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      const looksDestructive = /destructive|risky|injection|regression|unsupported|should/i.test(q.instructions);
      const p = looksDestructive ? dangerP : 0.4 + Math.random() * 0.2;
      answers[id] = { type: "noul", noul: round(p) };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const pick = danger ? keys[0] : keys[Math.min(1, keys.length - 1)];
      const probs = {};
      const hot = Math.max(0.3, 0.6 + (danger ? 0.25 : 0) - Math.random() * 0.15);
      let rest = 1 - hot;
      keys.forEach((k, idx) => {
        if (k === pick) probs[k] = round(hot);
        else { const v = idx === keys.length - 1 ? rest : rest / 2; probs[k] = round(v); rest -= v; }
      });
      answers[id] = { type: "choice", choice: pick, probabilities: probs, confidence: round(hot) };
    } else if (q.type === "score") {
      const max = (q.criteria || []).length - 1;
      const score = danger ? max : Math.max(0, max - 2);
      answers[id] = { type: "score", score, probabilities: {}, confidence: round(0.55 + Math.random() * 0.2) };
    }
  }
  return { model: "jev-mock", answers };
}

const round = (x) => Math.round(x * 1000) / 1000;

// --------------------------- render answers ---------------------------

function renderAnswers() {
  const box = $("#answers");
  box.innerHTML = "";
  for (const [id, a] of Object.entries(state.answers)) {
    const card = document.createElement("div");
    card.className = "answer";
    if (a.type === "noul") card.appendChild(renderNoul(id, a));
    else if (a.type === "choice") card.appendChild(renderChoice(id, a));
    else if (a.type === "score") card.appendChild(renderScore(id, a));
    box.appendChild(card);
  }
  wireThresholds();
}

function answerHead(id, type, extra) {
  const head = document.createElement("div");
  head.className = "aid";
  head.innerHTML = `${esc(id)}<span class="type-pill">${type}</span>`;
  return head;
}

function renderNoul(id, a) {
  const wrap = document.createElement("div");
  wrap.appendChild(answerHead(id, "noul · P(yes)"));
  const t = state.thresholds[id] ?? 0.5;
  wrap.appendChild(probBar("yes", a.noul));
  const gate = document.createElement("div");
  gate.className = "threshold";
  gate.innerHTML = `<div class="t-label"><span>threshold</span><span id="tv-${cssEsc(id)}">${t.toFixed(2)}</span></div>
    <input type="range" min="0" max="1" step="0.01" value="${t}" data-id="${esc(id)}" data-kind="noul" />`;
  wrap.appendChild(gate);
  const verdict = document.createElement("div");
  verdict.id = "gate-" + cssEsc(id);
  wrap.appendChild(verdict);
  updateNoulGate(id, a.noul);
  return wrap;
}

function renderChoice(id, a) {
  const wrap = document.createElement("div");
  wrap.appendChild(answerHead(id, "choice · picked"));
  const probs = a.probabilities || {};
  const entries = Object.entries(probs).sort((x, y) => y[1] - x[1]);
  for (const [k, v] of entries) wrap.appendChild(probBar(k, v, k === a.choice));
  const conf = document.createElement("div");
  conf.className = "confidence";
  conf.innerHTML = `picked <b>${esc(a.choice)}</b> · confidence <b>${(a.confidence ?? 0).toFixed(3)}</b>`;
  wrap.appendChild(conf);
  return wrap;
}

function renderScore(id, a) {
  const wrap = document.createElement("div");
  wrap.appendChild(answerHead(id, "score"));
  const pos = document.createElement("div");
  pos.className = "score-pos";
  const rubric = document.createElement("div");
  rubric.className = "score-rubric";
  // we don't know the rubric here, but score is an index; show the numeric pos
  rubric.innerHTML = `<div class="lvl">low</div><div class="lvl">med</div><div class="lvl">high</div><div class="lvl">crit</div>`;
  // highlight nearest
  const cells = rubric.children;
  const idx = Math.max(0, Math.min(cells.length - 1, Math.round(a.score)));
  if (cells[idx]) cells[idx].classList.add("active");
  pos.appendChild(rubric);
  const val = document.createElement("div");
  val.className = "score-val";
  val.textContent = a.score.toFixed(2);
  pos.appendChild(val);
  wrap.appendChild(pos);
  const conf = document.createElement("div");
  conf.className = "confidence";
  conf.innerHTML = `confidence <b>${(a.confidence ?? 0).toFixed(3)}</b>`;
  wrap.appendChild(conf);
  return wrap;
}

function probBar(label, value, isPick) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const cls = value >= 0.66 ? "high" : value >= 0.34 ? "mid" : "low";
  row.innerHTML = `
    <div class="label" title="${esc(label)}">${isPick ? "▸ " : ""}${esc(label)}</div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${(value * 100).toFixed(1)}%"></div></div>
    <div class="bar-val">${value.toFixed(3)}</div>`;
  return row;
}

function wireThresholds() {
  $$('input[type="range"][data-kind="noul"]').forEach((el) => {
    el.addEventListener("input", (e) => {
      const id = e.target.dataset.id;
      state.thresholds[id] = +e.target.value;
      const tv = document.getElementById("tv-" + cssEsc(id));
      if (tv) tv.textContent = (+e.target.value).toFixed(2);
      const a = state.answers[id];
      if (a) updateNoulGate(id, a.noul);
    });
  });
}

function updateNoulGate(id, p) {
  const t = state.thresholds[id] ?? 0.5;
  const el = document.getElementById("gate-" + cssEsc(id));
  if (!el) return;
  const blocked = p >= t;
  el.innerHTML = `<span class="gate ${blocked ? "block" : "allow"}">${blocked ? "BLOCKED" : "ALLOW"} · P ${p.toFixed(3)} ≥ t ${t.toFixed(2)}</span>`;
}

// --------------------------- utils ---------------------------

function setStatus(msg, isErr) {
  const el = $("#status");
  el.textContent = msg;
  el.className = "status " + (isErr ? "err" : msg.startsWith("ok") || msg.startsWith("mock") ? "ok" : "");
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function cssEsc(s) { return String(s).replace(/[^a-z0-9_-]/gi, "-"); }

$("#run").addEventListener("click", runJev);
renderQuestions();
setStatus("idle · mock is on — hit run");
