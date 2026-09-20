"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { askJev, judgeDestructive, verifyClaim, triageUrgency, JevError, validateQuestions, noul, choice, score } = require("./jev");

// Fake transport mirroring the TS/Python test fakes.
function fakeTransport(handler) {
  return async (url, { method, headers, body }) => {
    const parsed = JSON.parse(body.toString());
    const answers = handler(parsed);
    return { status: 200, body: Buffer.from(JSON.stringify({ model: "jev-fake", answers })) };
  };
}

const config = { apiKey: "test-key", transport: fakeTransport(() => ({ destructive: { type: "noul", noul: 0.9 } })) };

test("validateQuestions rejects empty", () => assert.throws(() => validateQuestions({}), JevError));
test("validateQuestions rejects unknown type", () => assert.throws(() => validateQuestions({ q: { type: "bogus", instructions: "x" } }), JevError));
test("validateQuestions accepts good map", () => {
  validateQuestions({ a: { type: "noul", instructions: "x" }, b: { type: "choice", instructions: "y", criteria: { x: "1", y: "2" } }, c: { type: "score", instructions: "z", criteria: ["a", "b"] } });
});

test("askJev requires api key", async () => {
  await assert.rejects(() => askJev({ apiKey: "" }, { x: 1 }, { q: { type: "noul", instructions: "y" } }), JevError);
});

test("judgeDestructive blocks at 0.75", async () => {
  const r = await judgeDestructive(config, { tool: "bash", input: { cmd: "rm -rf dist" } });
  assert.strictEqual(r.destructive, 0.9);
  assert.strictEqual(r.blocked, true);
});

test("judgeDestructive allows below threshold", async () => {
  const c = { ...config, transport: fakeTransport(() => ({ destructive: { type: "noul", noul: 0.2 } })) };
  const r = await judgeDestructive(c, { tool: "read", input: {} });
  assert.strictEqual(r.blocked, false);
});

test("verifyClaim flags unsupported", async () => {
  const c = { ...config, transport: fakeTransport(() => ({ supported: { type: "noul", noul: 0.1 } })) };
  const r = await verifyClaim(c, { claim: "sky is green", source: "sky is blue" });
  assert.strictEqual(r.unsupported, true);
});

test("triageUrgency maps score to level", async () => {
  const c = { ...config, transport: fakeTransport(() => ({ urgency: { type: "score", score: 3, confidence: 0.9 } })) };
  const r = await triageUrgency(c, { title: "prod is down" });
  assert.strictEqual(r.level, "Critical");
  assert.strictEqual(r.urgency, 3);
});

test("askJev surfaces 500 as retryable", async () => {
  const c = { ...config, transport: async () => ({ status: 503, body: Buffer.from("overloaded") }) };
  await assert.rejects(() => askJev(c, { x: 1 }, { q: { type: "noul", instructions: "y" } }), (e) => e instanceof JevError && e.retryable && e.status === 503);
});

test("accessors raise on wrong type", () => {
  const resp = { model: "m", answers: { q: { type: "choice", choice: "a" } } };
  assert.throws(() => noul(resp, "q"), JevError);
});

test("choice accessor returns probabilities", () => {
  const resp = { model: "m", answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.8 } } };
  const r = choice(resp, "q");
  assert.strictEqual(r.choice, "a");
  assert.strictEqual(r.probabilities.a, 0.8);
});
