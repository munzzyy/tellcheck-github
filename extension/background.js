// SlopScreen background (Firefox MV3 event page).
//
// All network traffic happens here: scoring calls to the SlopScreen API and
// the optional batch fetch from GitHub's public API. Content scripts only
// read the page and draw badges. Page text leaves the browser ONLY when the
// user clicks scan (or turns auto-scan on in options).
/* global ExtPay, SLOPSCREEN */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

// ExtensionPay: no-op until an id is configured. Per its docs the object must
// be created at the top level of the background script.
let extpay = null;
if (SLOPSCREEN.EXTPAY_ID) {
  extpay = ExtPay(SLOPSCREEN.EXTPAY_ID);
  extpay.startBackground();
}

async function getInstallId() {
  const got = await api.storage.local.get("installId");
  if (got.installId) return got.installId;
  const id = crypto.randomUUID();
  await api.storage.local.set({ installId: id });
  return id;
}

async function getSettings() {
  const got = await api.storage.local.get(["apiUrl", "githubPat", "autoScan"]);
  return {
    apiUrl: (got.apiUrl || SLOPSCREEN.API_URL).replace(/\/+$/, ""),
    githubPat: got.githubPat || "",
    autoScan: !!got.autoScan,
  };
}

// Paid status. With no EXTPAY_ID configured everything is treated as free
// tier and upgrade UI stays hidden. Re-instantiate ExtPay inside the callback
// per its README (the top-level object is unreliable in event pages).
async function paidStatus() {
  if (!SLOPSCREEN.EXTPAY_ID) return { configured: false, paid: false };
  try {
    const user = await ExtPay(SLOPSCREEN.EXTPAY_ID).getUser();
    return { configured: true, paid: !!user.paid };
  } catch {
    return { configured: true, paid: false, error: "extpay_unreachable" };
  }
}

async function scoreTexts(texts) {
  const [install, settings, paid] = await Promise.all([
    getInstallId(), getSettings(), paidStatus(),
  ]);
  const resp = await fetch(`${settings.apiUrl}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ install, texts, paid: paid.paid }),
  });
  const data = await resp.json().catch(() => ({ ok: false, error: "bad_response" }));
  data.httpStatus = resp.status;
  data.paidStatus = paid;
  // Remember the quota line so the popup can show it without a network call.
  if (data.quota) await api.storage.local.set({ lastQuota: data.quota, lastQuotaAt: Date.now() });
  return data;
}

// Batch: list open PRs of a repo (their bodies come back in the same call)
// and score title+body per PR. One GitHub request, one scoring request.
async function batchScan(owner, repo) {
  const settings = await getSettings();
  const headers = { accept: "application/vnd.github+json" };
  if (settings.githubPat) headers.authorization = `Bearer ${settings.githubPat}`;
  const gh = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20`,
    { headers },
  );
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
  return { ok: true, rows, quota: scored.quota };
}

api.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "scan":
      return scoreTexts(msg.texts);
    case "batch":
      return batchScan(msg.owner, msg.repo);
    case "paid-status":
      return paidStatus();
    case "settings":
      return getSettings();
    case "open-payment":
      if (SLOPSCREEN.EXTPAY_ID) ExtPay(SLOPSCREEN.EXTPAY_ID).openPaymentPage();
      return Promise.resolve({ ok: true });
    default:
      return undefined;
  }
});
