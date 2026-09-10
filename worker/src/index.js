// Tellcheck for GitHub scoring API. Runs on Cloudflare Workers.
//
// The detector (Cole's noslop engine) lives server-side only; the extension is
// a thin client. One route does the work:
//
//   POST /score   { install: "uuid", texts: [{ id, text }] }
//     -> { ok, results: [{ id, p, verdict, flagged, words, truncated,
//                          score_per_1k, signals }], quota }
//
// The daily quota is metered per install id AND per source IP per UTC day,
// counted in a Durable Object so the check and the increment are atomic (KV is
// not: see the note above meter()). The install id alone is trivial to rotate,
// so a coarse IP cap sits behind it as a backstop; either ceiling being hit
// blocks the request. If the counter is missing or unavailable the meter
// degrades OPEN on purpose: scoring keeps working and the response says
// meter:"degraded" instead of silently lying about enforcement. A metering
// outage should cost pennies, not break users.
//
// There are no tiers. Everyone gets the same cap, and the worker ignores any
// extra fields in the request body; nothing a client asserts about itself can
// change its limit.
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
  FREE_DAILY: 100,  // scored texts per install per day
  IP_DAILY: 500,    // coarser backstop per source IP; blunts install-id rotation
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
      (r.words < 60 ? " (measured on longer text; short comments run less certain)" : "");
  } else {
    verdict = "no detection at the 5% false-positive operating point" +
      (r.words < 60 ? " (short text, lower confidence)" : "");
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

// Ask one Durable Object instance to count. The instance is addressed by the
// counter key, is single-threaded, and Cloudflare input-gates deliveries while
// a storage op is in flight, so its own get/check/put is atomic for that key.
async function bump(ns, key, count, limit, day, refund = false) {
  const stub = ns.get(ns.idFromName(key));
  const res = await stub.fetch("https://meter/bump", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count, limit, day, refund }),
  });
  return res.json();
}

// Counting has to be atomic or the cap is theatre. KV cannot do it: get-then-put
// from concurrent isolates all read the same pre-increment value, so a burst of
// parallel requests every one of them passes the check and the stored counter
// moves by one. That was live (12 parallel scans cost 1 unit of quota), which
// made both the per-install and per-IP ceilings bypassable from a single
// connection without rotating anything. The Durable Object path below is exact.
//
// meterKV stays as the fallback for an environment without the binding: it still
// stops sequential abuse, and a metering outage must never stop scoring.
async function meter(env, install, ip, count) {
  const limit = Number(env.FREE_DAILY) || DEFAULTS.FREE_DAILY;
  const ipLimit = Number(env.IP_DAILY) || DEFAULTS.IP_DAILY;
  if (!env.METER) return meterKV(env, install, ip, count);

  const day = new Date().toISOString().slice(0, 10);
  try {
    const inst = await bump(env.METER, `q:${install}:${day}`, count, limit, day);
    if (!inst.allowed) {
      return { allowed: false, meter: "ok", used: inst.used, limit, reason: "daily limit reached" };
    }
    const net = await bump(env.METER, `qip:${ip}:${day}`, count, ipLimit, day);
    if (!net.allowed) {
      // The install counter already consumed this request. Hand it back so a
      // user behind a busy shared IP does not also lose their own allowance.
      // Report the counter the refund actually landed on, not arithmetic on a
      // number that another concurrent request may already have moved.
      const back = await bump(env.METER, `q:${install}:${day}`, count, limit, day, true).catch(() => null);
      const used = back ? back.used : Math.max(0, inst.used - count);
      return { allowed: false, meter: "ok", used, limit: ipLimit, reason: "network daily cap reached" };
    }
    return { allowed: true, meter: "ok", used: inst.used, limit };
  } catch (err) {
    // Durable Object unavailable: degrade open, visibly, same as KV.
    return { allowed: true, meter: "degraded", used: null, limit };
  }
}

async function meterKV(env, install, ip, count) {
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
      return { allowed: false, meter: "ok", used, limit, reason: "daily limit reached" };
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
  // A text the leftover budget cannot cover to at least 20 words (or in full,
  // if shorter) is refused outright: scoring a tiny prefix of a long comment
  // would report "under 20 words" about a text that is not short.
  let budget = MAX_WORDS_PER_REQUEST;
  const jobs = [];
  for (const t of texts) {
    const text = typeof t.text === "string" ? t.text : "";
    if (!text.trim()) continue;
    const id = String(t.id ?? jobs.length);
    const words = text.split(/\s+/).length;
    const take = Math.min(words, budget, MAX_WORDS_PER_TEXT);
    if (take < Math.min(words, 20)) {
      jobs.push({ id, outOfBudget: true });
      continue;
    }
    budget -= take;
    jobs.push({ id, text, take });
  }
  if (!jobs.length) return json({ ok: false, error: "no_texts" }, 400);

  const scoring = jobs.filter((j) => !j.outOfBudget);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const q = await meter(env, install, ip, scoring.length);
  if (!q.allowed) {
    return json({ ok: false, error: "quota", quota: q }, 429);
  }

  const results = jobs.map((j) => j.outOfBudget
    ? {
        id: j.id,
        p: null,
        verdict: "not scored: the scan's word budget ran out before this text",
        flagged: false,
        abstained: true,
        reason: "budget",
        words: 0,
        truncated: false,
        language: null,
        score_per_1k: null,
        signals: [],
      }
    : { id: j.id, ...scoreText(j.text, j.take) });
  return json({ ok: true, results, quota: q, dropped: texts.length - jobs.length });
}

// One instance per counter key (install-day, ip-day). Single-threaded, so the
// read/check/write below cannot interleave with another request for the key.
export class MeterDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { count, limit, day, refund } = await request.json();
    const rec = (await this.state.storage.get("rec")) || { day, used: 0 };
    if (rec.day !== day) { rec.day = day; rec.used = 0; }

    if (refund) {
      rec.used = Math.max(0, rec.used - count);
      await this.state.storage.put("rec", rec);
      return Response.json({ allowed: true, used: rec.used });
    }
    if (rec.used + count > limit) {
      return Response.json({ allowed: false, used: rec.used });
    }
    const first = rec.used === 0;
    rec.used += count;
    await this.state.storage.put("rec", rec);
    // Counters are day-scoped and the key carries the day, so an instance is
    // dead weight once its day passes. Schedule its own cleanup on the first
    // write only: checking getAlarm() on every request would spend a storage
    // read per scan, and the free plan meters those. alarm() below wipes the
    // record, and on a compatibility_date at or after 2026-02-24 (ours is
    // 2026-08-01) deleteAll() clears the alarm with it, so nothing is left
    // scheduled against an empty object.
    if (first) {
      await this.state.storage.setAlarm(Date.now() + 48 * 60 * 60 * 1000);
    }
    return Response.json({ allowed: true, used: rec.used });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
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
