// Comment-genre tells, ported line for line from noslop.py comment_tells().
// Parity with the Python original is pinned by test/fixtures/
// comment_tells_fixtures.synthetic.json (always) plus the full corpus set
// when present locally (test/comment-fixtures.mjs); drift is a failing test.
//
// This is a SEPARATE signal from the statistical detector. On short GitHub
// comments the main score is no better than chance (AUC 0.4925 on the
// realworld corpus), so this layer scores the genre itself: length, comma
// density, contractions, whether the text points at anything, and a few
// pattern tells. It answers "does this read like an assistant-drafted
// comment", not "was this written by a model".
//
// Word boundaries are Unicode lookarounds, not \b: JS \b is ASCII-only, so
// on accented text the social, contraction, and self-tally patterns would
// silently diverge from Python's Unicode-aware \b. Same idiom as
// needleRegex() in detector-core.js.

const SOCIAL = /(?<![\p{L}\p{N}_])(?:thanks|thank you|sorry|please)(?![\p{L}\p{N}_])/giu;
const REFS = /https?:\/\/|#\p{Nd}+|@[\p{L}\p{N}_]+/gu;
const CONTRACTION = /(?<![\p{L}\p{N}_])[\p{L}\p{N}_]+'(?:s|t|re|ve|ll|d|m)(?![\p{L}\p{N}_])/giu;

const ECHO_OPEN = /^\s*(?:confirmed|can confirm|confirming|verified|acknowledged|noted)(?![\p{L}\p{N}_])[,.:]?\s/iu;

const SELF_TALLY = new RegExp(
  "(?<![\\p{L}\\p{N}_])that\\s+(?:clears|closes|covers|resolves|handles)\\s+(?:all|both)(?![\\p{L}\\p{N}_])" +
  "|(?<![\\p{L}\\p{N}_])(?:all|both)\\s+(?:the\\s+)?(?:[\\p{L}\\p{N}_]+\\s+){0,2}" +
  "(?:issues?|links?|bugs?|findings?|problems?|fixes|items?|reports?)(?![\\p{L}\\p{N}_])" +
  "[^.]{0,40}(?<![\\p{L}\\p{N}_])I\\s+(?:found|reported|flagged|raised|fixed)(?![\\p{L}\\p{N}_])" +
  "|(?<![\\p{L}\\p{N}_])my\\s+(?:[\\p{L}\\p{N}_]+\\s+){0,2}(?:fixes|patches|findings|reports|PRs)(?![\\p{L}\\p{N}_])",
  "iu",
);

const EM_DASH = "—";

// Python's "%.0f": round the double to the nearest integer, ties to even.
// toFixed(0) rounds ties up instead (62.5 -> "63" where Python says "62"),
// which would break label parity with the fixtures.
function fmt0(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return String(f + 1);
  if (d < 0.5) return String(f);
  return String(f % 2 === 0 ? f : f + 1);
}

function countMatches(re, s) {
  const m = s.match(re);
  return m ? m.length : 0;
}

function countChar(s, ch) {
  let n = 0;
  for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

// Returns { points, rows } with rows as [label, hint] pairs, exactly the
// tuple Python returns. kind="pr" relaxes the two checks that are specific
// to comments (length, the expectation of a question): a PR description
// legitimately runs long and asserts rather than asks. Everything about
// voice rather than length applies to both kinds.
export function commentTells(text, kind = "comment") {
  let prose = text.replace(/```[\s\S]*?```/g, " ");
  prose = prose.replace(/`[^`]*`/g, " ");
  const words = prose.match(/[A-Za-z']+/g) || [];
  const wc = Math.max(1, words.length);
  const per1k = (n) => (1000.0 * n) / wc;

  const commas = per1k(countChar(prose, ","));
  const contractions = per1k(countMatches(CONTRACTION, prose));
  const social = countMatches(SOCIAL, prose);
  const refs = countMatches(REFS, text);
  const questions = countChar(prose, "?");
  const emdash = countChar(prose, EM_DASH);

  let points = 0.0;
  const rows = [];
  if (kind === "comment") {
    if (wc > 120) {
      points += 2;
      rows.push([`${wc} words`, "median real comment is 47; cut it hard"]);
    } else if (wc > 80) {
      points += 1;
      rows.push([`${wc} words`, "running long for a comment (median 47)"]);
    }
  }
  if (commas > 40) {
    points += 1.5;
    rows.push([`${fmt0(commas)} commas/1k`,
      "median 32 - split the subordinate clauses into sentences"]);
  }
  if (contractions > 15) {
    points += 1.5;
    rows.push([`${fmt0(contractions)} contractions/1k`,
      "median real comment has none; this genre is not chatty"]);
  }
  if (social === 0) {
    points += 1;
    rows.push(["no thanks/please/sorry", "real reviewers open or close with one"]);
  }
  if (refs === 0) {
    points += 1;
    rows.push(["no #issue, @name or link", "real comments point at something"]);
  }
  if (questions === 0 && kind === "comment") {
    points += 0.5;
    rows.push(["asks nothing", "real reviewers ask; drafts assert"]);
  }
  if (ECHO_OPEN.test(prose.replace(/^\s+/u, ""))) {
    points += 1.5;
    rows.push(["opens by confirming what they already said",
      "they know; open with what is new instead"]);
  }
  if (SELF_TALLY.test(prose)) {
    points += 1.5;
    rows.push(["tallies your own contribution",
      "scorekeeping - state the fact and move on"]);
  }
  if (emdash) {
    points += Math.min(2, emdash) * 1.5;
    rows.push([`${emdash} em dash${emdash > 1 ? "es" : ""}`,
      "banned outright in house style"]);
  }
  return { points, rows };
}

export default commentTells;
