// SlopScreen scoring API. Runs on Cloudflare Workers.
//
// The detector (Cole's noslop engine) lives server-side only; the extension is
// a thin client. One route does the work:
//
//   POST /score   { install: "uuid", texts: [{ id, text }] }
//     -> { ok, results: [{ id, p, verdict, flagged, words, truncated,
//                          score_per_1k, signals }], quota }
//
// Free quota is metered per install id per UTC day in KV. If KV is missing or
// over its own limits the meter degrades OPEN on purpose: scoring keeps
// working and the response says meter:"degraded" instead of silently lying
// about enforcement. A paywall outage should cost pennies, not break users.
//
// CPU budget: the detector costs ~1ms per 200 words. Texts are truncated at
// MAX_WORDS_PER_TEXT and each request is capped at MAX_WORDS_PER_REQUEST so a
// request stays inside the free plan's CPU allowance.
import Noslop from "./detector-core.js";

const MAX_TEXTS = 25;
const MAX_WORDS_PER_TEXT = 1500;
const MAX_WORDS_PER_REQUEST = 2000;
const MAX_BODY_BYTES = 512 * 1024;

const DEFAULTS = {
  FREE_DAILY: 30,      // scored texts per install per day
  PAID_DAILY: 2000,    // ExtensionPay has no server-side validation API, so a
  CEILING_DAILY: 2000, // paid claim is client-asserted; the ceiling bounds abuse.
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
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return [text, false];
  return [words.slice(0, maxWords).join(" "), true];
}

// Top human-readable signals out of a detector report, for the badge panel.
export function topSignals(r) {
  const out = [];
  if (r.ai_artifacts && r.ai_artifacts.length) {
    out.push(`chat-UI artifact: ${r.ai_artifacts[0].key || r.ai_artifacts[0]}`);
  }
  const counted = (rows, label) => {
    if (!rows || !rows.length) return;
    const total = rows.reduce((n, row) => n + (row.count || row.n || 1), 0);
    const tops = rows.slice(0, 3).map((row) => row.key || row.word || row.text || "").filter(Boolean);
    out.push(`${total} ${label}${tops.length ? ` (${tops.join(", ")})` : ""}`);
  };
  counted(r.buzzwords, "buzzword hits");
  counted(r.phrases, "stock AI phrases");
  if (r.em_dash_excess) out.push(`heavy em-dash use (${r.em_dashes} in ${r.words} words)`);
  if (r.bold_label_bullets && r.bold_label_bullets.length) out.push("bold-label bullet formatting");
  if (r.connective_excess) out.push("connective-opener overuse (moreover/furthermore/additionally)");
  if (r.sentence_uniformity_cv !== null && r.sentence_uniformity_cv !== undefined && r.sentence_uniformity_cv < 0.35) {
    out.push("unusually uniform sentence rhythm");
  }
  if (r.hedge_excess) out.push("hedging boilerplate");
  return out.slice(0, 5);
}

export function scoreText(text) {
  const [clipped, truncated] = truncateWords(text, MAX_WORDS_PER_TEXT);
  const r = Noslop.analyze(clipped, { markdown: true });
  const p = r.detect_p; // null = abstained (short text / non-English)
  const flagged = typeof r.detect_verdict === "string" && r.detect_verdict.startsWith("flags as AI");
  const artifact = !!(r.ai_artifacts && r.ai_artifacts.length);
  return {
    p: p,
    verdict: r.detect_verdict || "n/a",
    flagged: flagged || artifact,
    abstained: p === null || p === undefined,
    words: r.words,
    truncated,
    language: r.language,
    score_per_1k: r.score_per_1k,
    signals: topSignals(r),
  };
}

async function meter(env, install, count, paidClaim) {
  const limitFree = Number(env.FREE_DAILY) || DEFAULTS.FREE_DAILY;
  const limitPaid = Number(env.PAID_DAILY) || DEFAULTS.PAID_DAILY;
  const ceiling = Number(env.CEILING_DAILY) || DEFAULTS.CEILING_DAILY;
  const limit = paidClaim ? limitPaid : limitFree;
  if (!env.QUOTA) {
    return { allowed: true, meter: "degraded", used: null, limit };
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `q:${install}:${day}`;
  try {
    const used = Number(await env.QUOTA.get(key)) || 0;
    if (used >= ceiling) {
      return { allowed: false, meter: "ok", used, limit: ceiling, reason: "daily ceiling reached" };
    }
    if (used + count > limit) {
      const reason = paidClaim ? "daily limit reached" : "free daily limit reached";
      return { allowed: false, meter: "ok", used, limit, reason };
    }
    // Expire counters after two days; midnight UTC resets the key anyway.
    await env.QUOTA.put(key, String(used + count), { expirationTtl: 60 * 60 * 48 });
    return { allowed: true, meter: "ok", used: used + count, limit };
  } catch (err) {
    // KV over quota or unavailable: degrade open, visibly.
    return { allowed: true, meter: "degraded", used: null, limit };
  }
}

async function handleScore(request, env) {
  if ((request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return json({ ok: false, error: "body_too_large" }, 413);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  const install = typeof body.install === "string" ? body.install.slice(0, 64) : "";
  if (!install) return json({ ok: false, error: "missing_install" }, 400);
  const texts = Array.isArray(body.texts) ? body.texts.slice(0, MAX_TEXTS) : [];
  if (!texts.length) return json({ ok: false, error: "no_texts" }, 400);

  // Request-level word budget: trim the text list until it fits.
  let budget = MAX_WORDS_PER_REQUEST;
  const jobs = [];
  for (const t of texts) {
    if (budget <= 0) break;
    const text = typeof t.text === "string" ? t.text : "";
    if (!text.trim()) continue;
    const words = text.split(/\s+/).length;
    const take = Math.min(words, budget, MAX_WORDS_PER_TEXT);
    budget -= take;
    jobs.push({ id: String(t.id ?? jobs.length), text });
  }
  if (!jobs.length) return json({ ok: false, error: "no_texts" }, 400);

  const q = await meter(env, install, jobs.length, body.paid === true);
  if (!q.allowed) {
    return json({ ok: false, error: "quota", quota: q }, 429);
  }

  const results = jobs.map((j) => ({ id: j.id, ...scoreText(j.text) }));
  return json({ ok: true, results, quota: q, dropped: texts.length - jobs.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") {
      return json({ ok: true, service: "slopscreen", detector: !!Noslop });
    }
    if (url.pathname === "/score" && request.method === "POST") {
      return handleScore(request, env);
    }
    return json({ ok: false, error: "not_found" }, 404);
  },
};
