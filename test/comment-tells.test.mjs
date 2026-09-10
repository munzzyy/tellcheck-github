// Comment-style layer parity tests. Run: node --test test/comment-tells.test.mjs
//
// Every case asserts exact points AND exact hit labels against output
// recorded from the Python original, so any divergence in the JS port is a
// failing test, not a warning. Two fixture sets feed it:
//
//  - the synthetic set (test/fixtures/comment_tells_fixtures.synthetic.json)
//    ships in this repo and always runs, in CI too. It holds constructed
//    texts only, aimed at the ways a port silently diverges: JS's ASCII-only
//    \b vs Python's Unicode word boundaries, round-half-even per-1k labels,
//    the word-count band edges, and code-block stripping.
//  - the full corpus-derived set is larger and does not ship in this repo.
//    When it exists locally (see test/comment-fixtures.mjs for the env var
//    and the well-known path) the same parity assertion runs over all of it.
//
// The worker wiring tests live in worker.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentTells } from "../worker/src/comment-tells.js";
import { SYNTHETIC, FULL, FULL_PATH, ALL } from "./comment-fixtures.mjs";

function assertParity(fixtures) {
  const mismatches = [];
  for (const f of fixtures) {
    const r = commentTells(f.text, f.kind);
    const labels = r.rows.map((row) => row[0]);
    if (r.points !== f.points || JSON.stringify(labels) !== JSON.stringify(f.hits)) {
      mismatches.push(`${f.id}: points ${r.points} vs ${f.points}, ` +
        `hits ${JSON.stringify(labels)} vs ${JSON.stringify(f.hits)}`);
    }
  }
  assert.deepEqual(mismatches, [], `${mismatches.length} fixture(s) diverge from Python`);
}

test("synthetic fixture parity: JS port matches Python points and hits", () => {
  assert.ok(SYNTHETIC.length >= 25, `expected the synthetic set, got ${SYNTHETIC.length}`);
  assertParity(SYNTHETIC);
});

test("full fixture parity: JS port matches Python on the corpus-derived set",
  { skip: FULL ? false : `full set not found at ${FULL_PATH}` }, () => {
    assert.ok(FULL.length >= 200, `expected the full fixture set, got ${FULL.length}`);
    assertParity(FULL);
  });

test("fixture set exercises both kinds and both sides of the threshold", () => {
  const kinds = new Set(SYNTHETIC.map((f) => f.kind));
  assert.ok(kinds.has("comment") && kinds.has("pr"), `kinds seen: ${[...kinds]}`);
  assert.ok(SYNTHETIC.some((f) => f.points > 7), "no fixture above the flag threshold");
  assert.ok(SYNTHETIC.some((f) => f.points <= 7), "no fixture at or below the flag threshold");
});

test("kind pr relaxes the comment-only checks across the flag threshold", () => {
  // The length band and the asks-nothing check apply to comments only, so
  // texts must exist that flag as a comment and pass as a PR body; the
  // worker's default-to-pr fails safe on catch rate, never on FPR.
  const f = SYNTHETIC.find((x) =>
    commentTells(x.text, "comment").points > 7 &&
    commentTells(x.text, "pr").points <= 7);
  assert.ok(f, "no fixture separates kind comment from kind pr across the threshold");
  for (const x of ALL) {
    const asComment = commentTells(x.text, "comment").points;
    const asPr = commentTells(x.text, "pr").points;
    assert.ok(asPr <= asComment,
      `${x.id}: kind pr must never score above kind comment (${asPr} > ${asComment})`);
  }
});
