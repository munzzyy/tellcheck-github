// Background script tests. Run: node --test test/background.test.mjs
// The stub /score enforces the worker's request caps and daily meter, not the detector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const SRC = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), "utf8");
const CONFIG = SRC("config.js");
const BACKGROUND = SRC("background.js");

const WORKER_MAX_TEXTS = 25;
const WORKER_MAX_WORDS_PER_TEXT = 1500;
const WORKER_MAX_WORDS_PER_REQUEST = 2000;
const DAILY_LIMIT = 100;

function words(n, word = "word") {
  return Array.from({ length: n }, () => word).join(" ");
}

function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(JSON.stringify(body)),
  };
}

function harness({ used = 0, prs = [], github = null, refuse = null } = {}) {
  const store = {};
  const scoreCalls = [];
  const githubCalls = [];
  const violations = [];
  const meter = { used };
  let listener = null;

  function score(body) {
    scoreCalls.push(body);
    const refused = refuse && refuse(scoreCalls.length);
    if (refused) return refused;
    if (body.texts.length > WORKER_MAX_TEXTS) {
      violations.push(`${body.texts.length} texts in one request`);
      return reply(400, { ok: false, error: "too_many_texts" });
    }
    let budget = 0;
    const results = [];
    for (const t of body.texts) {
      const w = Math.min(t.text.split(/\s+/).length, WORKER_MAX_WORDS_PER_TEXT);
      if (budget + w > WORKER_MAX_WORDS_PER_REQUEST) {
        violations.push(`text ${t.id} past the word budget`);
        results.push({ id: t.id, p: null, flagged: false, abstained: true, reason: "budget", words: 0 });
        continue;
      }
      budget += w;
      results.push({ id: t.id, p: 0.12, flagged: false, abstained: false, verdict: "no detection", words: w });
    }
    const count = results.filter((r) => r.reason !== "budget").length;
    if (meter.used + count > DAILY_LIMIT) {
      return reply(429, {
        ok: false,
        error: "quota",
        quota: { allowed: false, meter: "ok", used: meter.used, limit: DAILY_LIMIT, reason: "daily limit reached" },
      });
    }
    meter.used += count;
    return reply(200, { ok: true, results, quota: { allowed: true, meter: "ok", used: meter.used, limit: DAILY_LIMIT }, dropped: 0 });
  }

  const browser = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
      },
    },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  };

  async function fetch(url, init = {}) {
    if (url.endsWith("/score")) return score(JSON.parse(init.body));
    if (url.startsWith("https://api.github.com/")) {
      githubCalls.push(url);
      return github ? github(url) : reply(200, prs);
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  const ctx = vm.createContext({ browser, fetch, crypto: webcrypto, console });
  vm.runInContext(CONFIG, ctx, { filename: "config.js" });
  vm.runInContext(BACKGROUND, ctx, { filename: "background.js" });
  assert.ok(listener, "background.js registered no message listener");
  const send = async (msg) => JSON.parse(JSON.stringify(await listener(msg)));
  return { send, scoreCalls, githubCalls, violations, meter, store };
}

function pr(number, body, title = `PR ${number}`) {
  return { number, title, body, user: { login: "someone" }, html_url: `https://github.com/o/r/pull/${number}` };
}

test("a long thread is split so every block gets scored", async () => {
  const h = harness();
  const texts = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, text: words(120), kind: i ? "comment" : "pr" }));
  const resp = await h.send({ type: "scan", texts });
  assert.equal(resp.ok, true);
  assert.deepEqual(h.violations, []);
  const byId = new Map(resp.results.map((r) => [r.id, r]));
  for (const t of texts) {
    assert.ok(byId.has(t.id), `${t.id} missing`);
    assert.notEqual(byId.get(t.id).reason, "budget", `${t.id} refused for budget`);
  }
  assert.ok(h.scoreCalls.length > 1);
  for (const call of h.scoreCalls) {
    assert.ok(call.texts.length <= WORKER_MAX_TEXTS);
    const sum = call.texts.reduce((n, t) => n + Math.min(t.text.split(/\s+/).length, WORKER_MAX_WORDS_PER_TEXT), 0);
    assert.ok(sum <= WORKER_MAX_WORDS_PER_REQUEST, `request carried ${sum} words`);
  }
  assert.deepEqual(h.scoreCalls.flatMap((c) => c.texts.map((t) => t.kind)), texts.map((t) => t.kind));
});

test("a batch of 25 long PR bodies scores every row", async () => {
  const prs = Array.from({ length: 25 }, (_, i) => pr(i + 1, words(300)));
  const h = harness({ prs });
  const resp = await h.send({ type: "batch", owner: "o", repo: "r", numbers: prs.map((p) => p.number) });
  assert.equal(resp.ok, true);
  assert.deepEqual(h.violations, []);
  assert.equal(resp.rows.length, 25);
  for (const row of resp.rows) {
    assert.ok(row.result, `#${row.number} has no result`);
    assert.notEqual(row.result.reason, "budget", `#${row.number} refused for budget`);
  }
});

test("near the daily cap the scan scores what fits and marks the rest", async () => {
  const h = harness({ used: 96 });
  const texts = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, text: words(40), kind: "comment" }));
  const resp = await h.send({ type: "scan", texts });
  assert.equal(resp.ok, true);
  assert.equal(resp.results.length, 10);
  const scored = resp.results.filter((r) => !r.reason);
  const capped = resp.results.filter((r) => r.reason === "quota");
  assert.deepEqual(scored.map((r) => r.id), ["b0", "b1", "b2", "b3"]);
  assert.deepEqual(capped.map((r) => r.id), ["b4", "b5", "b6", "b7", "b8", "b9"]);
  for (const r of capped) assert.equal(r.flagged, false);
  assert.equal(h.meter.used, DAILY_LIMIT);
  assert.equal(resp.quota.used, DAILY_LIMIT);
});

test("at the daily cap the refusal comes back as before", async () => {
  const h = harness({ used: DAILY_LIMIT });
  const texts = Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, text: words(40), kind: "comment" }));
  const resp = await h.send({ type: "scan", texts });
  assert.equal(resp.ok, false);
  assert.equal(resp.error, "quota");
  assert.equal(resp.quota.reason, "daily limit reached");
  assert.equal(h.scoreCalls.length, 1);
});

test("batch strips template comments and code before anything is sent", async () => {
  const body = [
    "<!--",
    "Thanks for the PR! Fill in TEMPLATE-MARKER below.",
    "```",
    "this fence sits inside the comment",
    "```",
    "-->",
    "Fixes the crash when the config is empty.",
    "",
    "```js",
    "const x = 'CODE-MARKER-1';",
    "```",
    "",
    "~~~",
    "CODE-MARKER-2 <!-- not a comment in here",
    "~~~",
    "",
    "Run `CODE-MARKER-3` to check it, then the parser keeps going.",
  ].join("\n");
  const h = harness({
    prs: [
      pr(1, body),
      pr(2, "<!-- only the TEMPLATE-MARKER template, never filled in -->", "Speed up the lexer"),
      pr(3, "Real words here.\n<!-- unterminated TEMPLATE-MARKER comment\nrest of the template"),
    ],
  });
  const resp = await h.send({ type: "batch", owner: "o", repo: "r", numbers: [1, 2, 3] });
  assert.equal(resp.ok, true);
  const posted = JSON.stringify(h.scoreCalls);
  for (const marker of ["TEMPLATE-MARKER", "CODE-MARKER-1", "CODE-MARKER-2", "CODE-MARKER-3"]) {
    assert.ok(!posted.includes(marker), `${marker} reached /score`);
  }
  const sent = new Map(h.scoreCalls.flatMap((c) => c.texts).map((t) => [t.id, t.text]));
  assert.ok(sent.get("1").includes("Fixes the crash when the config is empty."));
  assert.ok(sent.get("1").includes("then the parser keeps going."));
  assert.equal(sent.get("2"), "Speed up the lexer");
  assert.equal(sent.get("3"), "PR 3\n\nReal words here.");
});

test("batch scores only the PRs on the page and reports the ones GitHub did not list", async () => {
  const prs = Array.from({ length: 40 }, (_, i) => pr(i + 1, words(30)));
  const h = harness({ prs });
  const resp = await h.send({ type: "batch", owner: "o", repo: "r", numbers: [12, 3, 3, 30, 77] });
  assert.equal(resp.ok, true);
  const sentIds = h.scoreCalls.flatMap((c) => c.texts.map((t) => t.id));
  assert.deepEqual(sentIds, ["12", "3", "30"]);
  assert.deepEqual(resp.rows.map((r) => r.number), [12, 3, 30]);
  assert.deepEqual(resp.notFound, [77]);
  assert.match(h.githubCalls[0], /state=open&per_page=100$/);
});

test("batch with no listed PR among the open ones scores nothing", async () => {
  const h = harness({ prs: [pr(1, words(30))] });
  const resp = await h.send({ type: "batch", owner: "o", repo: "r", numbers: [500] });
  assert.equal(resp.ok, false);
  assert.equal(resp.error, "not_found");
  assert.equal(h.scoreCalls.length, 0);
});

for (const [status, headers] of [[429, {}], [403, { "x-ratelimit-remaining": "0" }]]) {
  test(`GitHub ${status} ${JSON.stringify(headers)} reads as the rate limit`, async () => {
    const h = harness({ github: () => reply(status, { message: "API rate limit exceeded" }, headers) });
    const resp = await h.send({ type: "batch", owner: "o", repo: "r", numbers: [1] });
    assert.equal(resp.ok, false);
    assert.equal(resp.error, "github");
    assert.match(resp.detail, /rate limit/);
    assert.match(resp.detail, /token/);
    assert.equal(h.scoreCalls.length, 0);
  });
}

test("GitHub 404 points at a token for private repos", async () => {
  const h = harness({ github: () => reply(404, { message: "Not Found" }) });
  const resp = await h.send({ type: "batch", owner: "o", repo: "private-one", numbers: [1] });
  assert.equal(resp.ok, false);
  assert.match(resp.detail, /private/);
  assert.match(resp.detail, /token/);
});

test("a network-cap refusal mid-scan keeps what landed and says which limit ran out", async () => {
  const network = reply(429, {
    ok: false,
    error: "quota",
    quota: { allowed: false, meter: "ok", used: 10, limit: 500, reason: "network daily cap reached" },
  });
  const h = harness({ refuse: (n) => (n === 2 ? network : null) });
  const texts = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, text: words(40), kind: "comment" }));
  const resp = await h.send({ type: "scan", texts });
  assert.equal(resp.ok, true);
  assert.equal(h.scoreCalls.length, 2, "a network-cap refusal must not be retried smaller");
  assert.equal(resp.results.filter((r) => !r.reason).length, 25);
  const capped = resp.results.filter((r) => r.reason === "quota");
  assert.equal(capped.length, 5);
  for (const r of capped) assert.match(r.verdict, /network/);
});
