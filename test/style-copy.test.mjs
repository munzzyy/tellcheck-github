// The style panel reasons address a maintainer, not the person drafting. Run: node --test test/style-copy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commentTells } from "../worker/src/comment-tells.js";
import { FOR_MAINTAINERS, styleReason } from "../worker/src/style-copy.js";
import { SYNTHETIC } from "./comment-fixtures.mjs";

const DRAFTING_ADVICE = /house style|cut it hard|split the|state the fact|open with what is new|they know/i;

test("no reason tells the maintainer how to edit the comment", () => {
  let rows = 0;
  for (const f of SYNTHETIC) {
    for (const kind of ["comment", "pr"]) {
      for (const row of commentTells(f.text, kind).rows) {
        const reason = styleReason(row);
        rows++;
        assert.ok(!DRAFTING_ADVICE.test(reason), `${f.id} (${kind}): ${reason}`);
        assert.ok(reason.startsWith(`${row[0]}: `), `${f.id} (${kind}) lost its label: ${reason}`);
      }
    }
  }
  assert.ok(rows > 50, `only ${rows} rows exercised`);
});

test("every hint in comment-tells.js has maintainer copy", () => {
  const src = readFileSync(new URL("../worker/src/comment-tells.js", import.meta.url), "utf8");
  const pushes = src.split("rows.push([").slice(1).map((c) => c.slice(0, c.indexOf("]);")));
  const hints = pushes.map((p) => (p.match(/"((?:[^"\\]|\\.)*)"\s*$/) || [])[1]);
  assert.ok(hints.length >= 10, `found ${hints.length} rows.push calls`);
  for (const [i, hint] of hints.entries()) {
    assert.ok(hint, `rows.push call ${i} has no string hint`);
    assert.ok(FOR_MAINTAINERS.has(hint), `no maintainer copy for "${hint}"`);
  }
});
