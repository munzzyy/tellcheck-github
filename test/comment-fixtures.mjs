// Loads the comment-style parity fixtures for the test suites.
//
// SYNTHETIC ships in this repo and is always present: constructed edge-case
// texts only, generated against the Python original. The full corpus-derived
// set is larger and stays out of this repo; when it is available locally the
// suites run it too. It is looked for at $COMMENT_TELLS_FIXTURES, then at
// ../noslop/eval/fixtures/comment_tells_fixtures.json next to this checkout.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SYNTHETIC = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/comment_tells_fixtures.synthetic.json", import.meta.url)),
  "utf8"));

export const FULL_PATH = process.env.COMMENT_TELLS_FIXTURES ||
  fileURLToPath(new URL("../../noslop/eval/fixtures/comment_tells_fixtures.json", import.meta.url));

export const FULL = existsSync(FULL_PATH)
  ? JSON.parse(readFileSync(FULL_PATH, "utf8"))
  : null;

// Everything we can get our hands on; the full set contains the synthetic
// cases too, and running a case twice is harmless.
export const ALL = FULL ? SYNTHETIC.concat(FULL) : SYNTHETIC;
