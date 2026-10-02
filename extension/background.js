// Tellcheck for GitHub background (Firefox MV3 event page).
//
// All network traffic happens here: scoring calls to Tellcheck for GitHub's
// worker and the optional batch fetch from GitHub's public API. Content scripts only
// read the page and draw badges. Page text leaves the browser ONLY when the
// user clicks scan (or turns auto-scan on in options).
//
/* global TELLCHECK */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

// The meter id rotates at UTC midnight, matching the daily quota exactly.
// Nothing about an install is trackable across days.
async function getMeterId() {
  const day = new Date().toISOString().slice(0, 10);
  const got = await api.storage.local.get("meterId");
  if (got.meterId && got.meterId.day === day) return got.meterId.id;
  const id = crypto.randomUUID();
  await api.storage.local.set({ meterId: { day, id } });
  return id;
}

async function getSettings() {
  const got = await api.storage.local.get(["apiUrl", "githubPat", "autoScan"]);
  return {
    apiUrl: (got.apiUrl || TELLCHECK.API_URL).replace(/\/+$/, ""),
    githubPat: got.githubPat || "",
    autoScan: !!got.autoScan,
  };
}

// The worker's per-request caps; past them it refuses texts unscored.
const MAX_TEXTS = 25;
const MAX_WORDS_PER_TEXT = 1500;
const MAX_WORDS_PER_REQUEST = 2000;

// Same word count the worker budgets with, in request order.
function chunk(texts) {
  const out = [];
  let cur = [];
  let words = 0;
  for (const t of texts) {
    const w = Math.min(String(t.text || "").split(/\s+/).length, MAX_WORDS_PER_TEXT);
    if (cur.length && (cur.length === MAX_TEXTS || words + w > MAX_WORDS_PER_REQUEST)) {
      out.push(cur);
      cur = [];
      words = 0;
    }
    cur.push(t);
    words += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

function notScored(id, stop) {
  const quota = stop.error === "quota";
  const network = quota && stop.quota && stop.quota.reason === "network daily cap reached";
  return {
    id: String(id),
    p: null,
    verdict: network ? "not scored: this network's shared daily limit ran out before this text"
      : quota ? "not scored: the daily scan limit ran out before this text"
      : "not scored: the scoring server did not answer",
    flagged: false,
    abstained: true,
    reason: network ? "network" : quota ? "quota" : "error",
    words: 0,
    truncated: false,
    language: null,
    signals: [],
    style_flag: false,
    style_points: null,
    style_reasons: [],
  };
}

// A network-cap refusal pairs the install's count with the network's limit.
function roomLeft(refusal) {
  const q = refusal.quota;
  if (refusal.error !== "quota" || !q || q.reason !== "daily limit reached") return 0;
  if (typeof q.used !== "number" || typeof q.limit !== "number") return 0;
  return Math.max(0, q.limit - q.used);
}

async function postScore(apiUrl, install, texts) {
  let resp;
  try {
    resp = await fetch(`${apiUrl}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ install, texts }),
    });
  } catch {
    return { ok: false, error: "network", detail: "scoring server unreachable" };
  }
  const data = await resp.json().catch(() => ({ ok: false, error: "bad_response" }));
  data.httpStatus = resp.status;
  // Remember the quota line so the popup can show it without a network call.
  if (data.quota) await api.storage.local.set({ lastQuota: data.quota, lastQuotaAt: Date.now() });
  return data;
}

async function scoreTexts(texts) {
  const [install, settings] = await Promise.all([getMeterId(), getSettings()]);
  const results = [];
  let quota = null;
  let dropped = 0;
  let answered = false;
  let stop = null;
  for (const part of chunk(texts)) {
    let send = stop ? [] : part;
    const sent = new Set();
    while (send.length) {
      const data = await postScore(settings.apiUrl, install, send);
      if (data.ok) {
        results.push(...data.results);
        for (const t of send) sent.add(String(t.id));
        quota = data.quota;
        dropped += data.dropped || 0;
        answered = true;
        break;
      }
      stop = data;
      // A refusal at the install cap is all-or-nothing, so send what still fits.
      const room = roomLeft(data);
      send = room > 0 && room < send.length ? send.slice(0, room) : [];
    }
    for (const t of part) if (!sent.has(String(t.id))) results.push(notScored(t.id, stop));
  }
  if (!answered) return stop || { ok: false, error: "no_texts" };
  return { ok: true, results, quota, dropped };
}

// One left-to-right pass, so whichever of a comment or a fence opens first wins; unclosed ones run to the end.
const NOT_PROSE = new RegExp([
  /<!--[\s\S]*?(?:-->|(?![\s\S]))/.source,
  /^ {0,3}(`{3,})[^`\n]*(?:\n[\s\S]*?(?:^ {0,3}\1`*[ \t]*$|(?![\s\S]))|(?![\s\S]))/.source,
  /^ {0,3}(~{3,})[^\n]*(?:\n[\s\S]*?(?:^ {0,3}\2~*[ \t]*$|(?![\s\S]))|(?![\s\S]))/.source,
  /(?<!`)(`+)(?!`)[^\n]*?[^`\n]\3(?!`)/.source,
].join("|"), "gm");

function proseOf(markdown) {
  return String(markdown || "").replace(NOT_PROSE, "").trim();
}

function githubTrouble(gh, hasToken) {
  const limited = gh.status === 429 ||
    (gh.status === 403 && (gh.headers.get("x-ratelimit-remaining") === "0" || gh.headers.get("retry-after")));
  if (limited) return hasToken ? "GitHub rate limit hit, try again later" : "GitHub rate limit hit (add a token in options)";
  if (gh.status === 401) return "GitHub turned down the token in options";
  if (gh.status === 403) return "GitHub refused access to this repo";
  if (gh.status === 404) return "Repo not found (private repos need a GitHub token in options)";
  return `GitHub answered ${gh.status}`;
}

// Only PRs listed on the page get scored; one GitHub call returns up to 100 open ones with bodies.
async function batchScan(owner, repo, numbers) {
  const wanted = Array.isArray(numbers) ? [...new Set(numbers.map(Number).filter(Number.isInteger))] : [];
  if (!wanted.length) return { ok: false, error: "no_open_prs" };
  const settings = await getSettings();
  const headers = { accept: "application/vnd.github+json" };
  if (settings.githubPat) headers.authorization = `Bearer ${settings.githubPat}`;
  const safe = (s) => encodeURIComponent(String(s));
  let gh;
  try {
    gh = await fetch(
      `https://api.github.com/repos/${safe(owner)}/${safe(repo)}/pulls?state=open&per_page=100`,
      { headers },
    );
  } catch {
    return { ok: false, error: "network", detail: "GitHub unreachable" };
  }
  if (!gh.ok) return { ok: false, error: "github", detail: githubTrouble(gh, !!settings.githubPat) };
  const prs = await gh.json().catch(() => null);
  if (!Array.isArray(prs) || !prs.length) return { ok: false, error: "no_open_prs" };

  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const onPage = wanted.filter((n) => byNumber.has(n)).map((n) => byNumber.get(n));
  const notFound = wanted.filter((n) => !byNumber.has(n));
  if (!onPage.length) return { ok: false, error: "not_found", notFound };

  const texts = onPage.map((pr) => ({
    id: String(pr.number),
    text: proseOf(`${pr.title || ""}\n\n${pr.body || ""}`),
    kind: "pr",
  })).filter((t) => t.text);
  const scored = await scoreTexts(texts);
  if (!scored.ok) return scored;

  const byId = new Map(scored.results.map((r) => [r.id, r]));
  const rows = onPage.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user && pr.user.login,
    url: pr.html_url,
    result: byId.get(String(pr.number)) || null,
  }));
  await api.storage.local.set({
    lastBatch: { owner, repo, at: new Date().toISOString(), rows },
  });
  return { ok: true, rows, notFound, quota: scored.quota, dropped: scored.dropped || 0 };
}

api.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "scan":
      return scoreTexts(msg.texts).catch(() => ({ ok: false, error: "internal" }));
    case "batch":
      return batchScan(msg.owner, msg.repo, msg.numbers).catch(() => ({ ok: false, error: "internal" }));
    case "settings":
      return getSettings();
    default:
      return undefined;
  }
});
