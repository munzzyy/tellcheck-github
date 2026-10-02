// Worker tests that do not depend on the detector: the daily meter, the
// request caps and input validation. CI runs them against a stub detector:
//   node --import ./test/stub-detector.mjs --test test/worker-meter.test.mjs
// Locally, with the real detector synced in, plain node --test runs them too.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { MeterDO } from "../worker/src/index.js";
import { mockKV, req, HUMAN_TEXT } from "./worker-helpers.mjs";

test("daily limit enforced at the default 100", async () => {
  const env = { QUOTA: mockKV() };
  const texts = Array.from({ length: 10 }, (_, i) => ({ id: i, text: HUMAN_TEXT }));
  for (let i = 0; i < 10; i++) {
    const r = await worker.fetch(req({ install: "cap-test", texts }), env);
    assert.equal((await r.json()).ok, true, `batch ${i} should pass`);
  }
  const over = await worker.fetch(req({ install: "cap-test", texts }), env);
  assert.equal(over.status, 429);
  const d = await over.json();
  assert.equal(d.error, "quota");
  assert.match(d.quota.reason, /daily limit/);
});

test("unknown client fields cannot raise the limit", async () => {
  // Guards the invariant behind the privacy policy: nothing a client asserts
  // about itself (here a leftover paid:true from old builds) changes metering.
  const env = { QUOTA: mockKV(), FREE_DAILY: "10" };
  const texts = Array.from({ length: 10 }, (_, i) => ({ id: i, text: HUMAN_TEXT }));
  const r1 = await worker.fetch(req({ install: "paid-test", texts, paid: true }), env);
  assert.equal((await r1.json()).ok, true, "first batch of 10 should pass at the 10 limit");
  const r2 = await worker.fetch(req({ install: "paid-test", texts, paid: true }), env);
  assert.equal(r2.status, 429, "an unknown field must not lift the daily limit");
});

test("a rotated install id still hits the per-IP cap", async () => {
  const env = { QUOTA: mockKV(), FREE_DAILY: "5", IP_DAILY: "12" };
  const texts = Array.from({ length: 5 }, (_, i) => ({ id: i, text: HUMAN_TEXT }));
  const withIp = (install) =>
    new Request("https://tellcheck-github.example/score", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ install, texts }),
    });
  for (let i = 0; i < 2; i++) {
    const r = await worker.fetch(withIp(`install-${i}`), env);
    assert.equal((await r.json()).ok, true, `install ${i} should pass under the IP cap`);
  }
  // Third distinct install id, same IP: each install is under its own 5-scan
  // free limit but the shared IP has now seen 10 scans, one more tips it over.
  const r3 = await worker.fetch(withIp("install-2"), env);
  assert.equal(r3.status, 429, "the IP cap should stop a rotated install id");
  const d = await r3.json();
  assert.match(d.quota.reason, /network daily cap/);
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

test("a whitespace-free blob is capped by raw length, not word count", async () => {
  // A 300KB blob with no spaces tokenizes as one "word" and would sail past
  // every word-count budget (S2); the raw character cap must still clip it.
  const blob = "a".repeat(300_000);
  const env = { QUOTA: mockKV() };
  const r = await worker.fetch(req({ install: "blob-test", texts: [{ id: 0, text: blob }] }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.results[0].truncated, true, "an untokenizable blob must still be clipped");
  assert.ok(d.results[0].words < 5, "clipped blob should read as ~1 word to the detector");
});

test("oversized body is rejected even with no content-length header (S3)", async () => {
  const env = { QUOTA: mockKV() };
  const bigText = "word ".repeat(200_000); // well over the 512KB body cap
  const bad = new Request("https://tellcheck-github.example/score", {
    method: "POST",
    // Deliberately no content-type/content-length: simulates a chunked body
    // where the declared-length gate has nothing to check.
    body: JSON.stringify({ install: "big", texts: [{ id: 0, text: bigText }] }),
  });
  const r = await worker.fetch(bad, env);
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, "body_too_large");
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

test("a drained budget refuses tail texts instead of calling them short", async () => {
  // Three texts eat 1500+469+31 of the 2000-word budget (the third is a
  // 52-word comment clipped to the last 31). The fourth is another 52-word
  // comment with zero budget left: it must come back with the budget reason,
  // never scored on a tiny prefix and never labeled "under 20 words".
  const env = { QUOTA: mockKV() };
  const r = await worker.fetch(req({
    install: "budget-tail",
    texts: [
      { id: "a", text: (HUMAN_TEXT + " ").repeat(29) },
      { id: "b", text: (HUMAN_TEXT + " ").repeat(9) },
      { id: "c", text: HUMAN_TEXT },
      { id: "d", text: HUMAN_TEXT },
      { id: "e", text: "lgtm, merging" },
    ],
  }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  const byId = new Map(d.results.map((x) => [x.id, x]));
  assert.equal(byId.get("a").abstained, false, "first text should score in full");
  assert.equal(byId.get("b").abstained, false, "second text should score in full");
  assert.equal(byId.get("c").abstained, false, "31 words of budget still cover a scorable prefix");
  assert.equal(byId.get("c").truncated, true);
  for (const id of ["d", "e"]) {
    const x = byId.get(id);
    assert.equal(x.abstained, true, `${id} has no budget left`);
    assert.equal(x.flagged, false);
    assert.equal(x.reason, "budget", `${id} should carry the budget reason`);
    assert.match(x.verdict, /budget/);
    assert.ok(!/under 20 words/.test(x.verdict),
      `${id} must not be called too short: ${x.verdict}`);
  }
  const total = d.results.reduce((n, x) => n + x.words, 0);
  assert.ok(total <= 2000, `scored ${total} words, budget is 2000`);
  assert.equal(d.quota.used, 3, "refused texts must not spend quota");
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

// ---------- atomic meter ----------
// A Durable Object instance is single-threaded and input-gated: Cloudflare does
// not deliver a second request to an instance while the first is awaiting a
// storage op. This mock reproduces that by chaining requests per instance, so
// the test measures the counter logic under the semantics production has.
function mockDO() {
  const instances = new Map();
  const seen = instances;
  return {
    instances: seen,
    idFromName(name) { return name; },
    get(name) {
      let inst = instances.get(name);
      if (!inst) {
        const store = new Map();
        const calls = { setAlarm: 0, get: 0, put: 0 };
        const storage = {
          async get(k) { calls.get++; return store.get(k); },
          async put(k, v) { calls.put++; store.set(k, v); },
          async getAlarm() { return store.get("__alarm") ?? null; },
          async setAlarm(t) { calls.setAlarm++; store.set("__alarm", t); },
          async deleteAll() { store.clear(); },
        };
        inst = { calls };
        inst.obj = new MeterDO({ storage });
        inst.queue = Promise.resolve();
        instances.set(name, inst);
      }
      return {
        fetch(url, init) {
          const run = inst.queue.then(() => inst.obj.fetch(new Request(url, init)));
          inst.queue = run.then(() => {}, () => {});
          return run;
        },
      };
    },
  };
}

function scoreReq(install, text = HUMAN_TEXT) {
  return new Request("https://tellcheck-github.example/score", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ install, texts: [{ id: "a", text }] }),
  });
}

test("durable-object meter holds the cap exactly under a concurrent burst", async () => {
  const env = { METER: mockDO(), FREE_DAILY: "5", IP_DAILY: "300" };
  const rs = await Promise.all(
    Array.from({ length: 12 }, () => worker.fetch(scoreReq("burst-install"), env))
  );
  const served = rs.filter((r) => r.status === 200).length;
  const blocked = rs.filter((r) => r.status === 429).length;
  assert.equal(served, 5, `cap is 5, got ${served} served`);
  assert.equal(blocked, 7);
});

test("kv meter over-serves the same burst (why the durable object exists)", async () => {
  // Negative control. This is the live bug: 12 parallel scans all read the same
  // pre-increment counter and all pass. If this ever asserts 5, the KV path was
  // fixed some other way and the test above stopped proving anything.
  const env = { QUOTA: mockKV(), FREE_DAILY: "5", IP_DAILY: "300" };
  const rs = await Promise.all(
    Array.from({ length: 12 }, () => worker.fetch(scoreReq("burst-kv"), env))
  );
  const served = rs.filter((r) => r.status === 200).length;
  assert.ok(served > 5, `expected the KV path to over-serve, got ${served}`);
});

test("durable-object meter counts down a day and blocks after the cap", async () => {
  const env = { METER: mockDO(), FREE_DAILY: "3", IP_DAILY: "300" };
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const r = await worker.fetch(scoreReq("serial-install"), env);
    seen.push(r.status);
  }
  assert.deepEqual(seen, [200, 200, 200, 429]);
});

test("ip cap blocks without eating the user's own allowance", async () => {
  const env = { METER: mockDO(), FREE_DAILY: "50", IP_DAILY: "2" };
  await worker.fetch(scoreReq("user-a"), env);
  await worker.fetch(scoreReq("user-a"), env);
  const blocked = await worker.fetch(scoreReq("user-b"), env);
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.quota.reason, "network daily cap reached");
  // Reported straight off the refunded counter, not inferred by arithmetic.
  assert.equal(body.quota.used, 0, "a refunded request should report zero used");
  // user-b was refunded, so their own counter is still at zero.
  const envRoomy = { METER: env.METER, FREE_DAILY: "50", IP_DAILY: "99" };
  const after = await worker.fetch(scoreReq("user-b"), envRoomy);
  assert.equal(after.status, 200);
  assert.equal((await after.json()).quota.used, 1, "refund should have returned the unit");
});

test("meter degrades open when the durable object throws", async () => {
  const env = {
    METER: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("do down"); } }) },
    FREE_DAILY: "5",
  };
  const r = await worker.fetch(scoreReq("degrade"), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).quota.meter, "degraded");
});


test("cleanup alarm is armed once per instance, not once per scan", async () => {
  // Checking getAlarm() on every request costs a storage read per scan and the
  // free plan meters reads, so the alarm is set on the first write only.
  const ns = mockDO();
  const env = { METER: ns, FREE_DAILY: "50", IP_DAILY: "500" };
  for (let i = 0; i < 3; i++) await worker.fetch(scoreReq("alarm-install"), env);
  const inst = ns.instances.get("q:alarm-install:" + new Date().toISOString().slice(0, 10));
  assert.ok(inst, "expected a durable object instance for the install counter");
  assert.equal(inst.calls.setAlarm, 1, `alarm should be armed once, was ${inst.calls.setAlarm}`);
});
