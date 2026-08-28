// Worker API tests. Run: node --test test/
// Exercises the fetch handler directly with mock Requests and a mock KV, so
// nothing needs wrangler or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { scoreText } from "../worker/src/index.js";

function mockKV(store = new Map()) {
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

function req(body, path = "/score") {
  return new Request(`https://slopscreen.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AI_TEXT =
  "This comprehensive pull request delves into the intricacies of the parser, " +
  "leveraging robust design patterns to seamlessly enhance maintainability and " +
  "foster a vibrant developer experience. Additionally, it underscores our " +
  "commitment to excellence. Furthermore, the meticulous implementation showcases " +
  "transformative improvements across the entire stack, empowering contributors " +
  "to unlock unprecedented capabilities. Moreover, this holistic approach ensures " +
  "seamless integration while navigating the ever-evolving landscape of modern " +
  "software development, and it is a testament to the power of collaboration.";

const HUMAN_TEXT =
  "fixed the null deref in parse_config, it blew up when the ini had a section " +
  "with no keys. added a regression test. also killed two warnings gcc 15 " +
  "started throwing about the flexible array member. tested on arch and a " +
  "debian 13 container, both clean now as far as i can tell.";

test("health endpoint answers", async () => {
  const r = await worker.fetch(new Request("https://x/health"), {});
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.detector, true);
});

test("AI-sounding text flags, human text does not", () => {
  const ai = scoreText(AI_TEXT);
  const human = scoreText(HUMAN_TEXT);
  assert.equal(ai.flagged, true, `expected AI text to flag: ${ai.verdict}`);
  assert.equal(human.flagged, false, `expected human text clean: ${human.verdict}`);
  assert.ok(ai.signals.length > 0, "flagged text should carry signals");
});

test("short text abstains rather than guesses", () => {
  const s = scoreText("lgtm, merging");
  assert.equal(s.abstained, true);
  assert.equal(s.flagged, false);
});

test("scoring a paid-size batch works and meters", async () => {
  const env = { QUOTA: mockKV() };
  const r = await worker.fetch(req({
    install: "test-install-1",
    texts: [{ id: "body", text: AI_TEXT }, { id: "c1", text: HUMAN_TEXT }],
  }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.results.length, 2);
  assert.equal(d.results[0].flagged, true);
  assert.equal(d.results[1].flagged, false);
  assert.equal(d.quota.used, 2);
  assert.equal(d.quota.meter, "ok");
});

test("free daily limit enforced at 30", async () => {
  const env = { QUOTA: mockKV() };
  const texts = Array.from({ length: 10 }, (_, i) => ({ id: i, text: HUMAN_TEXT }));
  for (let i = 0; i < 3; i++) {
    const r = await worker.fetch(req({ install: "cap-test", texts }), env);
    assert.equal((await r.json()).ok, true, `batch ${i} should pass`);
  }
  const r4 = await worker.fetch(req({ install: "cap-test", texts }), env);
  assert.equal(r4.status, 429);
  const d = await r4.json();
  assert.equal(d.error, "quota");
  assert.match(d.quota.reason, /free daily limit/);
});

test("paid claim raises the limit but hits the ceiling", async () => {
  const env = { QUOTA: mockKV(), PAID_DAILY: "40", CEILING_DAILY: "40" };
  const texts = Array.from({ length: 10 }, (_, i) => ({ id: i, text: HUMAN_TEXT }));
  for (let i = 0; i < 4; i++) {
    const r = await worker.fetch(req({ install: "paid-test", texts, paid: true }), env);
    assert.equal((await r.json()).ok, true, `paid batch ${i} should pass`);
  }
  const r5 = await worker.fetch(req({ install: "paid-test", texts, paid: true }), env);
  assert.equal(r5.status, 429);
});

test("missing KV degrades open and says so", async () => {
  const r = await worker.fetch(req({ install: "x", texts: [{ id: 0, text: HUMAN_TEXT }] }), {});
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.quota.meter, "degraded");
});

test("KV throwing degrades open", async () => {
  const env = { QUOTA: { async get() { throw new Error("kv down"); }, async put() {} } };
  const r = await worker.fetch(req({ install: "x", texts: [{ id: 0, text: HUMAN_TEXT }] }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.quota.meter, "degraded");
});

test("oversized text is truncated, not rejected", async () => {
  const long = (HUMAN_TEXT + " ").repeat(60); // ~3200 words
  const env = { QUOTA: mockKV() };
  const r = await worker.fetch(req({ install: "t", texts: [{ id: 0, text: long }] }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.results[0].truncated, true);
});

test("request word budget is actually enforced across texts", async () => {
  // Two 1500-word texts: 2000-word request budget admits the first in full
  // and clips the second to ~500 words. Total scored must stay <= 2000.
  const words1500 = (HUMAN_TEXT + " ").repeat(29); // ~1500 words
  const env = { QUOTA: mockKV() };
  const r = await worker.fetch(req({
    install: "budget",
    texts: [{ id: "a", text: words1500 }, { id: "b", text: words1500 }],
  }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  const total = d.results.reduce((n, x) => n + x.words, 0);
  assert.ok(total <= 2000, `scored ${total} words, budget is 2000`);
  assert.equal(d.results[1].truncated, true, "second text must be clipped");
});

test("no internal CLI advice leaks into verdicts", () => {
  for (const text of [AI_TEXT, HUMAN_TEXT, "lgtm, merging", AI_TEXT.slice(0, 200)]) {
    const s = scoreText(text);
    assert.ok(!s.verdict.includes("--house"), `CLI flag leaked: ${s.verdict}`);
    assert.ok(!s.verdict.includes("--"), `CLI-ish string leaked: ${s.verdict}`);
  }
});

test("non-English abstention says why", () => {
  const german = "Dieser Pull Request behebt einen Fehler in der Konfigurationsdatei. " +
    "Beim Einlesen einer leeren Sektion ist das Programm abgestuerzt, weil der Parser " +
    "keine Pruefung auf fehlende Schluessel hatte. Ich habe einen Regressionstest " +
    "hinzugefuegt und zwei Warnungen des Compilers beseitigt. Getestet unter Debian " +
    "und Arch, beide Systeme laufen sauber durch. Die Aenderung ist bewusst klein " +
    "gehalten, damit sie leicht zu pruefen ist und keine weiteren Abhaengigkeiten braucht.";
  const s = scoreText(german);
  assert.equal(s.abstained, true);
  assert.match(s.verdict, /English/);
  assert.ok(!/under 20 words/.test(s.verdict));
});

test("garbage input rejected cleanly", async () => {
  const env = { QUOTA: mockKV() };
  for (const body of [{}, { install: "x" }, { install: "x", texts: [] }, { install: "x", texts: [{ id: 0, text: "" }] }]) {
    const r = await worker.fetch(req(body), env);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const bad = new Request("https://x/score", { method: "POST", body: "not json" });
  assert.equal((await worker.fetch(bad, env)).status, 400);
});

test("signal rows render as readable strings", () => {
  const s = scoreText(AI_TEXT);
  for (const sig of s.signals) {
    assert.equal(typeof sig, "string");
    assert.ok(!sig.includes("[object"), `unrendered object in signal: ${sig}`);
    assert.ok(!/undefined/.test(sig), `undefined leaked into signal: ${sig}`);
  }
});
