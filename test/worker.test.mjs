// Worker tests that need the real detector. Run: node --test test/worker.test.mjs
// Metering, request caps and input checks live in worker-meter.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { scoreText } from "../worker/src/index.js";
import Noslop from "../worker/src/detector-core.js";
import { commentTells } from "../worker/src/comment-tells.js";
import { ALL } from "./comment-fixtures.mjs";
import { mockKV, req, AI_TEXT, HUMAN_TEXT } from "./worker-helpers.mjs";

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

test("scoring a two-text batch works and meters", async () => {
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

test("short texts carry the lower-confidence qualifier both ways", () => {
  const shortClean = scoreText(HUMAN_TEXT, 30);
  assert.equal(shortClean.flagged, false);
  assert.equal(shortClean.abstained, false);
  assert.match(shortClean.verdict, /lower confidence/);
  const shortFlag = scoreText(AI_TEXT, 40);
  assert.equal(shortFlag.flagged, true);
  assert.match(shortFlag.verdict, /measured on longer text/);
  assert.match(shortFlag.verdict, /less certain/);
  // Full-length verdicts stay unqualified.
  assert.ok(!/less certain|lower confidence/.test(scoreText(AI_TEXT).verdict));
  assert.ok(!/less certain|lower confidence/.test(scoreText((HUMAN_TEXT + " ").repeat(2)).verdict));
});

test("flagged is pinned to the engine's exact verdict wording", () => {
  // scoreText derives `flagged` from detect_verdict.startsWith("flags as AI").
  // If the engine ever rewords its verdict, every text would silently read
  // clean; this fails loud instead.
  const r = Noslop.analyze(AI_TEXT, { markdown: true });
  assert.equal(typeof r.detect_verdict, "string", "engine must return a string verdict");
  assert.ok(r.detect_verdict.startsWith("flags as AI"),
    `engine verdict prefix changed, flagged wire-up is broken: "${r.detect_verdict}"`);
  assert.equal(scoreText(AI_TEXT).flagged, true);
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

test("signal rows render as readable strings", () => {
  const s = scoreText(AI_TEXT);
  for (const sig of s.signals) {
    assert.equal(typeof sig, "string");
    assert.ok(!sig.includes("[object"), `unrendered object in signal: ${sig}`);
    assert.ok(!/undefined/.test(sig), `undefined leaked into signal: ${sig}`);
  }
});


// ---------- comment-style layer wiring ----------
// Pure-function parity with Python is pinned in comment-tells.test.mjs; these
// prove the worker carries the signal as a separate field, keyed by the
// per-text kind, and never folds it into p/flagged.

// Synthetic set always, plus the full corpus-derived set when it exists
// locally (see comment-fixtures.mjs); both suffice for the wiring checks.
const STYLE_FIXTURES = ALL;

// A fixture that flags as a comment but not as a PR body: the length band
// and the asks-nothing check apply to comments only.
function kindSensitiveFixture() {
  const f = STYLE_FIXTURES.find((x) =>
    commentTells(x.text, "comment").points > 7 &&
    commentTells(x.text, "pr").points <= 7 &&
    x.text.length < 11000);
  assert.ok(f, "no fixture separates kind comment from kind pr across the threshold");
  return f;
}

test("scoreText flags on kind comment and not on kind pr for a length-band text", () => {
  const f = kindSensitiveFixture();
  const asComment = scoreText(f.text, 1500, "comment");
  const asPr = scoreText(f.text, 1500, "pr");
  assert.equal(asComment.style_flag, true,
    `expected a style flag at ${asComment.style_points} points`);
  assert.ok(asComment.style_points > 7);
  assert.ok(asComment.style_reasons.length > 0, "a flag must carry reasons");
  assert.equal(asPr.style_flag, false,
    `kind pr must relax the comment bands, got ${asPr.style_points} points`);
  assert.ok(asPr.style_points <= 7);
  // The style layer must not touch the detector's own outputs.
  assert.equal(asComment.p, asPr.p);
  assert.equal(asComment.flagged, asPr.flagged);
  assert.equal(asComment.verdict, asPr.verdict);
});

test("the style flag threshold is strictly greater than 7", () => {
  const at7 = STYLE_FIXTURES.find((f) => commentTells(f.text, f.kind).points === 7);
  if (at7) {
    const r = scoreText(at7.text, 1500, at7.kind);
    assert.equal(r.style_flag, false, "exactly 7 points must not flag");
  }
  const above = STYLE_FIXTURES.find((f) => commentTells(f.text, "comment").points > 7);
  assert.equal(scoreText(above.text, 1500, "comment").style_flag, true);
});

test("worker carries kind per text and defaults a missing kind to pr", async () => {
  const f = kindSensitiveFixture();
  const env = { QUOTA: mockKV() };
  const r = await worker.fetch(req({
    install: "style-wire",
    texts: [
      { id: "as-comment", text: f.text, kind: "comment" },
      { id: "as-pr", text: f.text, kind: "pr" },
      { id: "no-kind", text: f.text },
      { id: "junk-kind", text: f.text, kind: "banana" },
    ],
  }), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  const byId = new Map(d.results.map((x) => [x.id, x]));
  assert.equal(byId.get("as-comment").style_flag, true);
  assert.equal(byId.get("as-pr").style_flag, false);
  // Unknown or missing kind fails safe on catch rate, never on FPR.
  assert.equal(byId.get("no-kind").style_flag, false);
  assert.equal(byId.get("no-kind").style_points, byId.get("as-pr").style_points);
  assert.equal(byId.get("junk-kind").style_flag, false);
  // Same text, same detector result regardless of kind: the signals stay separate.
  for (const id of ["as-pr", "no-kind", "junk-kind"]) {
    assert.equal(byId.get(id).p, byId.get("as-comment").p);
    assert.equal(byId.get(id).flagged, byId.get("as-comment").flagged);
  }
});

test("a style flag never sets flagged and a budget refusal never sets style_flag", async () => {
  const f = kindSensitiveFixture();
  const asComment = scoreText(f.text, 1500, "comment");
  // style_flag is true here; flagged must still be the detector's own call.
  const detectorSaysFlagged = typeof asComment.p === "number" && asComment.flagged;
  if (!detectorSaysFlagged) {
    assert.equal(asComment.flagged, false,
      "a style-only hit must not read as a detector flag");
  }
  const env = { QUOTA: mockKV() };
  // Two fillers drain the 2000-word request budget: the first takes the full
  // 1500-word per-text cap, the second is clipped to the remaining 500.
  const filler = "plain filler words to eat the request budget ".repeat(188);
  const r = await worker.fetch(req({
    install: "style-budget",
    texts: [
      { id: "eat1", text: filler },
      { id: "eat2", text: filler },
      { id: "tail", text: f.text, kind: "comment" },
    ],
  }), env);
  const d = await r.json();
  const tail = d.results.find((x) => x.id === "tail");
  assert.equal(tail.reason, "budget");
  assert.equal(tail.style_flag, false, "an unscored text must not carry a style flag");
  assert.equal(tail.style_points, null);
});
