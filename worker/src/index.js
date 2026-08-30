// Tellcheck for GitHub scoring API. Runs on Cloudflare Workers.
//
// The detector (Cole's noslop engine) lives server-side only; the extension is
// a thin client. One route does the work:
//
//   POST /score   { install: "uuid", texts: [{ id, text }] }
//     -> { ok, results: [{ id, p, verdict, flagged, words, truncated,
//                          score_per_1k, signals }], quota }
//
// Free quota is metered per install id AND per source IP per UTC day in KV.
// The install id alone is trivial to rotate, so a coarse IP cap sits behind
// it as a backstop; either ceiling being hit blocks the request. If KV is
// missing or over its own limits the meter degrades OPEN on purpose: scoring
// keeps working and the response says meter:"degraded" instead of silently
// lying about enforcement. A metering outage should cost pennies, not break
// users.
//
// There is no paid tier wired up (no server can verify an ExtensionPay
// claim without a paid API we don't have), so the worker does not read or
// trust any client-asserted paid flag. Everyone gets the same free cap.
//
// CPU budget: the detector costs ~1ms per 200 words. Texts are truncated at
// MAX_WORDS_PER_TEXT and each request is capped at MAX_WORDS_PER_REQUEST so a
// request stays inside the free plan's CPU allowance. A whitespace-free blob
// tokenizes as ~1 "word", so MAX_CHARS_PER_TEXT bounds raw length too, ahead
// of any word-count math.
import Noslop from "./detector-core.js";

const MAX_TEXTS = 25;
const MAX_WORDS_PER_TEXT = 1500;
const MAX_WORDS_PER_REQUEST = 2000;
const MAX_CHARS_PER_TEXT = 12000; // ~1500 words at a generous 8 chars/word
const MAX_BODY_BYTES = 512 * 1024;

const DEFAULTS = {
  FREE_DAILY: 30,   // scored texts per install per day
  IP_DAILY: 300,    // coarser backstop per source IP; blunts install-id rotation
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}

function truncateWords(text, maxWords) {
  // Hard character cap first: a huge blob with no whitespace splits into a
  // single "word" and would otherwise sail past every word-count budget.
  let clipped = text;
  let truncated = false;
  if (clipped.length > MAX_CHARS_PER_TEXT) {
    clipped = clipped.slice(0, MAX_CHARS_PER_TEXT);
    truncated = true;
  }
  const words = clipped.split(/\s+/);
  if (words.length > maxWords) {
    clipped = words.slice(0, maxWords).join(" ");
    truncated = true;
  }
  return [clipped, truncated];
}

// Top human-readable signals out of a detector report, for the badge panel.
// noslop returns hit rows as [word, count, positions] arrays (sometimes objects).
function rowWord(row) { return Array.isArray(row) ? row[0] : (row && (row.key || row.word || row.text)) || ""; }
function rowCount(row) { return Array.isArray(row) ? (row[1] || 1) : (row && (row.count || row.n)) || 1; }
export function topSignals(r) {
  const out = [];
  if (r.ai_artifacts && r.ai_artifacts.length) {
    out.push(`chat-UI artifact: ${rowWord(r.ai_artifacts[0]) || "present"}`);
  }
  const counted = (rows, one, many) => {
    if (!rows || !rows.length) return;
    const total = rows.reduce((n, row) => n + rowCount(row), 0);
    const tops = rows.slice(0, 3).map(rowWord).filter(Boolean);
    out.push(`${total} ${total === 1 ? one : many}${tops.length ? ` (${tops.join(", ")})` : ""}`);
  };
  counted(r.buzzwords, "buzzword hit", "buzzword hits");
  counted(r.phrases, "stock AI phrase", "stock AI phrases");
  if (r.em_dash_excess) out.push(`heavy em-dash use (${r.em_dashes} in ${r.words} words)`);
  if (r.bold_label_bullets && r.bold_label_bullets.length) out.push("bold-label bullet formatting");
  if (r.connective_excess) out.push("connective-opener overuse (moreover/furthermore/additionally)");
  if (r.sentence_uniformity_cv !== null && r.sentence_uniformity_cv !== undefined && r.sentence_uniformity_cv < 0.35) {
    out.push("unusually uniform sentence rhythm");
  }
  if (r.hedge_excess) out.push("hedging boilerplate");
  return out.slice(0, 5);
}

export function scoreText(text, maxWords = MAX_WORDS_PER_TEXT) {
  const [clipped, truncated] = truncateWords(text, Math.min(maxWords, MAX_WORDS_PER_TEXT));
  const r = Noslop.analyze(clipped, { markdown: true });
  const p = r.detect_p; // null = abstained (short text / non-English)
  const flagged = typeof r.detect_verdict === "string" && r.detect_verdict.startsWith("flags as AI");
  const artifact = !!(r.ai_artifacts && r.ai_artifacts.length);
  const abstained = (p === null || p === undefined) && !artifact;
  // Product wording only. The raw detector verdicts carry internal CLI advice
  // that means nothing to an extension user, so compose ours from the facts.
  let verdict;
  if (artifact) {
    verdict = "AI chat artifact present";
  } else if (abstained) {
    verdict = r.language && r.language !== "en"
      ? "not scored: the classifier is calibrated for English only"
      : "not scored: under 20 words";
  } else if (flagged) {
    verdict = "flags as AI at the 5% false-positive operating point" +
      (r.words < 60 ? " (short text, lower confidence)" : "");
  } else {
    verdict = "no detection at the 5% false-positive operating point";
  }
  return {
    p: p === undefined ? null : p,
    verdict,
    flagged: flagged || artifact,
    abstained,
    words: r.words,
    truncated,
    language: r.language,
    score_per_1k: r.score_per_1k,
    signals: topSignals(r),
  };
}

async function meter(env, install, ip, count) {
  const limit = Number(env.FREE_DAILY) || DEFAULTS.FREE_DAILY;
  const ipLimit = Number(env.IP_DAILY) || DEFAULTS.IP_DAILY;
  if (!env.QUOTA) {
    return { allowed: true, meter: "degraded", used: null, limit };
  }
  const day = new Date().toISOString().slice(0, 10);
  const instKey = `q:${install}:${day}`;
  const ipKey = `qip:${ip}:${day}`;
  try {
    const [used, ipUsed] = await Promise.all([
      env.QUOTA.get(instKey).then((v) => Number(v) || 0),
      env.QUOTA.get(ipKey).then((v) => Number(v) || 0),
    ]);
    if (used + count > limit) {
      return { allowed: false, meter: "ok", used, limit, reason: "free daily limit reached" };
    }
    if (ipUsed + count > ipLimit) {
      return { allowed: false, meter: "ok", used, limit: ipLimit, reason: "network daily cap reached" };
    }
    // Expire counters after two days; midnight UTC resets the key anyway.
    await Promise.all([
      env.QUOTA.put(instKey, String(used + count), { expirationTtl: 60 * 60 * 48 }),
      env.QUOTA.put(ipKey, String(ipUsed + count), { expirationTtl: 60 * 60 * 48 }),
    ]);
    return { allowed: true, meter: "ok", used: used + count, limit };
  } catch (err) {
    // KV over quota or unavailable: degrade open, visibly.
    return { allowed: true, meter: "degraded", used: null, limit };
  }
}

async function handleScore(request, env) {
  // Content-Length is client-supplied and absent on chunked/HTTP2 requests,
  // so it is only a cheap early rejection, never the real gate. Reject
  // early when it is present and already over budget, then re-check the
  // actual decoded byte length below regardless of what the header said.
  const declaredLen = Number(request.headers.get("content-length") || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return json({ ok: false, error: "body_too_large" }, 413);
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ ok: false, error: "body_too_large" }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  const install = typeof body.install === "string" ? body.install.slice(0, 64) : "";
  if (!install) return json({ ok: false, error: "missing_install" }, 400);
  const texts = Array.isArray(body.texts) ? body.texts.slice(0, MAX_TEXTS) : [];
  if (!texts.length) return json({ ok: false, error: "no_texts" }, 400);

  // Request-level word budget: each admitted text is clipped to its `take`
  // so the total scored words can never exceed the budget (the CPU cap).
  let budget = MAX_WORDS_PER_REQUEST;
  const jobs = [];
  for (const t of texts) {
    if (budget <= 0) break;
    const text = typeof t.text === "string" ? t.text : "";
    if (!text.trim()) continue;
    const words = text.split(/\s+/).length;
    const take = Math.min(words, budget, MAX_WORDS_PER_TEXT);
    budget -= take;
    jobs.push({ id: String(t.id ?? jobs.length), text, take });
  }
  if (!jobs.length) return json({ ok: false, error: "no_texts" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const q = await meter(env, install, ip, jobs.length);
  if (!q.allowed) {
    return json({ ok: false, error: "quota", quota: q }, 429);
  }

  const results = jobs.map((j) => ({ id: j.id, ...scoreText(j.text, j.take) }));
  return json({ ok: true, results, quota: q, dropped: texts.length - jobs.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") {
      return json({ ok: true, service: "tellcheck-github", detector: !!Noslop });
    }
    if (url.pathname === "/score" && request.method === "POST") {
      return handleScore(request, env);
    }
    return json({ ok: false, error: "not_found" }, 404);
  },
};
