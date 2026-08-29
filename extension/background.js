// Tellcheck for GitHub background (Firefox MV3 event page).
//
// All network traffic happens here: scoring calls to Tellcheck for GitHub's
// worker and the optional batch fetch from GitHub's public API. Content scripts only
// read the page and draw badges. Page text leaves the browser ONLY when the
// user clicks scan (or turns auto-scan on in options).
//
// The v0.1 build ships with payments off: lib/ExtPay.js is not loaded by the
// manifest, so every ExtPay touchpoint is guarded on typeof. Enabling
// payments later = set EXTPAY_ID, re-add the lib + extensionpay.com entries
// to the manifest (see README).
/* global ExtPay, TELLCHECK */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const extpayAvailable = () => TELLCHECK.EXTPAY_ID && typeof ExtPay !== "undefined";

if (extpayAvailable()) {
  ExtPay(TELLCHECK.EXTPAY_ID).startBackground();
}

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

// Paid status. With payments unconfigured everything is free tier and no
// upgrade UI shows. When ExtPay is unreachable, fall back to the last known
// answer for three days so a paying user is not silently demoted offline.
async function paidStatus() {
  if (!extpayAvailable()) return { configured: false, paid: false };
  try {
    const user = await ExtPay(TELLCHECK.EXTPAY_ID).getUser();
    const paid = !!user.paid;
    await api.storage.local.set({ paidCache: { paid, at: Date.now() } });
    return { configured: true, paid };
  } catch {
    const { paidCache } = await api.storage.local.get("paidCache");
    const fresh = paidCache && Date.now() - paidCache.at < 72 * 3600 * 1000;
    return { configured: true, paid: fresh ? paidCache.paid : false, degraded: true };
  }
}

async function scoreTexts(texts) {
  const [install, settings, paid] = await Promise.all([
    getMeterId(), getSettings(), paidStatus(),
  ]);
  let resp;
  try {
    resp = await fetch(`${settings.apiUrl}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ install, texts, paid: paid.paid }),
    });
  } catch {
    return { ok: false, error: "network", detail: "scoring server unreachable" };
  }
  const data = await resp.json().catch(() => ({ ok: false, error: "bad_response" }));
  data.httpStatus = resp.status;
  data.paidStatus = paid;
  // Remember the quota line so the popup can show it without a network call.
  if (data.quota) await api.storage.local.set({ lastQuota: data.quota, lastQuotaAt: Date.now() });
  return data;
}

// Batch: list open PRs of a repo (their bodies come back in the same call)
// and score title+body per PR. One GitHub request, one scoring request.
// Covers the 20 most recently updated open PRs.
async function batchScan(owner, repo) {
  const settings = await getSettings();
  const headers = { accept: "application/vnd.github+json" };
  if (settings.githubPat) headers.authorization = `Bearer ${settings.githubPat}`;
  const safe = (s) => encodeURIComponent(String(s));
  let gh;
  try {
    gh = await fetch(
      `https://api.github.com/repos/${safe(owner)}/${safe(repo)}/pulls?state=open&per_page=20`,
      { headers },
    );
  } catch {
    return { ok: false, error: "network", detail: "GitHub unreachable" };
  }
  if (!gh.ok) {
    const detail = gh.status === 403 ? "GitHub rate limit hit (add a token in options)" : `GitHub answered ${gh.status}`;
    return { ok: false, error: "github", detail };
  }
  const prs = await gh.json();
  if (!Array.isArray(prs) || !prs.length) return { ok: false, error: "no_open_prs" };

  const texts = prs.map((pr) => ({
    id: String(pr.number),
    text: `${pr.title || ""}\n\n${pr.body || ""}`.trim(),
  })).filter((t) => t.text);
  const scored = await scoreTexts(texts);
  if (!scored.ok) return scored;

  const byId = new Map(scored.results.map((r) => [r.id, r]));
  const rows = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user && pr.user.login,
    url: pr.html_url,
    result: byId.get(String(pr.number)) || null,
  }));
  await api.storage.local.set({
    lastBatch: { owner, repo, at: new Date().toISOString(), rows },
  });
  return { ok: true, rows, quota: scored.quota, dropped: scored.dropped || 0 };
}

api.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "scan":
      return scoreTexts(msg.texts).catch(() => ({ ok: false, error: "internal" }));
    case "batch":
      return batchScan(msg.owner, msg.repo).catch(() => ({ ok: false, error: "internal" }));
    case "paid-status":
      return paidStatus();
    case "settings":
      return getSettings();
    case "open-payment":
      if (extpayAvailable()) ExtPay(TELLCHECK.EXTPAY_ID).openPaymentPage();
      return Promise.resolve({ ok: true });
    default:
      return undefined;
  }
});
