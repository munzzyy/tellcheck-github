"use strict";
const api = globalThis.browser ?? globalThis.chrome;

async function refreshQuota() {
  const { lastQuota, lastQuotaAt } = await api.storage.local.get(["lastQuota", "lastQuotaAt"]);
  const line = document.getElementById("quota-line");
  const bar = document.getElementById("quota-bar");
  if (!lastQuota || !lastQuotaAt) return;
  // Quota resets at UTC midnight; stale numbers from yesterday are noise.
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Date(lastQuotaAt).toISOString().slice(0, 10);
  if (seen !== today) return;
  if (lastQuota.meter === "degraded") {
    line.textContent = "Meter offline, scans unrestricted right now.";
    return;
  }
  if (typeof lastQuota.used === "number") {
    line.textContent = `${lastQuota.used} of ${lastQuota.limit} free scans used today.`;
    bar.style.width = `${Math.min(100, (lastQuota.used / lastQuota.limit) * 100)}%`;
  }
}

async function wirePaid() {
  const status = await api.runtime.sendMessage({ type: "paid-status" }).catch(() => null);
  const up = document.getElementById("upgrade");
  if (status && status.configured && !status.paid) {
    up.hidden = false;
    up.onclick = () => api.runtime.sendMessage({ type: "open-payment" });
  }
}

async function wireCsv() {
  const { lastBatch } = await api.storage.local.get("lastBatch");
  if (!lastBatch || !lastBatch.rows) return;
  const btn = document.getElementById("csv");
  btn.hidden = false;
  btn.onclick = () => {
    // Double quotes for CSV, and neutralize leading formula characters so a
    // hostile PR title cannot become an executing cell in a spreadsheet.
    const esc = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [["number", "title", "author", "url", "p", "verdict", "flagged"].join(",")];
    for (const row of lastBatch.rows) {
      const r = row.result || {};
      lines.push([row.number, esc(row.title), esc(row.author), esc(row.url),
        r.p ?? "", esc(r.verdict), r.flagged ? "yes" : "no"].join(","));
    }
    const a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(lines.join("\n"));
    a.download = `slopscreen-${lastBatch.owner}-${lastBatch.repo}.csv`;
    a.click();
  };
}

document.getElementById("scan").onclick = async () => {
  // Without the "tabs" permission tab.url is invisible, so just try to poke
  // the content script; on a non-GitHub tab there is none and this no-ops.
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) await api.tabs.sendMessage(tab.id, { type: "scan-now" }).catch(() => {});
  window.close();
};

document.getElementById("options").onclick = () => api.runtime.openOptionsPage();

refreshQuota();
wirePaid();
wireCsv();
