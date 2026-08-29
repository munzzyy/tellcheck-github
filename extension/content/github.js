// Tellcheck for GitHub content script for github.com.
//
// Draws the scan button on PR/issue pages and badges each scored block. No
// text leaves the page until the user clicks scan (unless auto-scan was
// turned on in options). GitHub ships two DOM generations (classic + React),
// so every selector below is a list of fallbacks.
"use strict";

(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const NS = "tellcheck";

  // ---------- routing ----------

  function route() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
    if (m) return { kind: "detail", owner: m[1], repo: m[2] };
    const l = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pulls\/?$/);
    if (l) return { kind: "list", owner: l[1], repo: l[2] };
    return { kind: "other" };
  }

  // ---------- text extraction ----------

  const BLOCK_SELECTORS = [
    ".timeline-comment .comment-body",          // classic PR/issue timeline
    "[data-testid='comment-body']",             // React issue viewer
    "[data-testid='markdown-body']",
    ".js-comment-container .markdown-body",
  ];

  const TITLE_SELECTORS = [
    "h1 .js-issue-title",
    "[data-testid='issue-title']",
    "bdi.js-issue-title",
    ".gh-header-title .js-issue-title",
  ];

  function findBlocks() {
    const seen = new Set();
    const blocks = [];
    for (const sel of BLOCK_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        // Skip an element nested inside one we already have.
        let dup = false;
        for (const kept of seen) {
          if (kept.contains(el) || el.contains(kept)) { dup = true; break; }
        }
        if (dup || seen.has(el)) continue;
        seen.add(el);
        blocks.push(el);
      }
    }
    return blocks;
  }

  // Rendered text minus code: the detector judges prose, so drop code blocks
  // the way the server drops fenced code from raw markdown.
  function proseOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("pre, code, .highlight, .blob-wrapper").forEach((n) => n.remove());
    return (clone.innerText || "").trim();
  }

  function collectTexts() {
    const items = [];
    const titleEl = TITLE_SELECTORS.map((s) => document.querySelector(s)).find(Boolean);
    const blocks = findBlocks();
    // Title rides with the first (description) block so short titles are not
    // scored alone, which would always abstain.
    blocks.forEach((el, i) => {
      let text = proseOf(el);
      if (i === 0 && titleEl) text = `${titleEl.textContent.trim()}\n\n${text}`;
      if (text) items.push({ id: `b${i}`, text, el });
    });
    return items.slice(0, 25); // worker caps at 25 texts per request
  }

  // ---------- UI ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fab() {
    let b = document.getElementById(`${NS}-fab`);
    if (b) return b;
    b = el("button", `${NS}-fab`);
    b.id = `${NS}-fab`;
    b.type = "button";
    document.body.appendChild(b);
    return b;
  }

  function clearBadges() {
    document.querySelectorAll(`.${NS}-chip, .${NS}-panel`).forEach((n) => n.remove());
  }

  function chipFor(result) {
    let cls, label;
    if (result.flagged) {
      // An artifact hit can be flagged and p-less; the flag wins the chip.
      cls = "flag";
      label = result.p === null || result.p === undefined
        ? "Tellcheck: flags as AI (chat artifact)"
        : `Tellcheck: flags as AI (p ${result.p})`;
    } else if (result.abstained) {
      cls = "abstain";
      label = result.language && result.language !== "en"
        ? "Tellcheck: not scored (English only)"
        : "Tellcheck: too short to judge";
    } else {
      cls = "clean";
      label = "Tellcheck: no AI detection";
    }
    const chip = el("button", `${NS}-chip ${NS}-${cls}`, label);
    chip.type = "button";
    return chip;
  }

  function notScoredChip() {
    const chip = el("span", `${NS}-chip ${NS}-abstain`, "Tellcheck: not scored (scan limit)");
    chip.title = "This block was over the per-scan limit. Scan again to cover the rest.";
    return chip;
  }

  function panelFor(result) {
    const panel = el("div", `${NS}-panel`);
    panel.appendChild(el("div", `${NS}-panel-verdict`, result.verdict));
    const meta = `${result.words} words scored` +
      (result.truncated ? " (long text, first 1500 words)" : "") +
      (result.language && result.language !== "en" ? ` | language: ${result.language}` : "");
    panel.appendChild(el("div", `${NS}-panel-meta`, meta));
    if (result.signals && result.signals.length) {
      const ul = el("ul", `${NS}-signals`);
      for (const s of result.signals) ul.appendChild(el("li", null, s));
      panel.appendChild(ul);
    }
    panel.appendChild(el("div", `${NS}-panel-foot`,
      "A statistical signal at a 5% false-positive operating point, not proof. " +
      "Judge the contribution, not the author."));
    return panel;
  }

  function attachBadge(block, result) {
    const chip = chipFor(result);
    const panel = panelFor(result);
    panel.hidden = true;
    chip.addEventListener("click", () => { panel.hidden = !panel.hidden; });
    block.el.insertAdjacentElement("beforebegin", chip);
    chip.insertAdjacentElement("afterend", panel);
  }

  // ---------- scan flows ----------

  let busy = false;

  async function scanDetail() {
    if (busy) return;
    busy = true;
    const b = fab();
    b.textContent = "Scanning...";
    clearBadges();
    try {
      const texts = collectTexts();
      if (!texts.length) { b.textContent = "Nothing to scan here"; return; }
      const resp = await api.runtime.sendMessage({
        type: "scan",
        texts: texts.map(({ id, text }) => ({ id, text })),
      }).catch(() => null);
      if (!resp || !resp.ok) {
        b.textContent = resp && resp.error === "quota"
          ? "Daily free scans used up"
          : "Scan failed (API unreachable?)";
        return;
      }
      const byId = new Map(resp.results.map((r) => [r.id, r]));
      let flagged = 0, scored = 0, missed = 0;
      for (const t of texts) {
        const r = byId.get(t.id);
        if (!r) {
          // Over the per-request cap: say so instead of silently skipping.
          t.el.insertAdjacentElement("beforebegin", notScoredChip());
          missed++;
          continue;
        }
        attachBadge(t, r);
        if (!r.abstained) scored++;
        if (r.flagged) flagged++;
      }
      const tail = missed ? `, ${missed} over the scan limit` : "";
      b.textContent = flagged
        ? `${flagged} of ${scored} flagged${tail}. Rescan`
        : `No flags in ${scored} scored${tail}. Rescan`;
    } catch {
      b.textContent = "Scan failed (API unreachable?)";
    } finally {
      busy = false;
    }
  }

  async function scanList(owner, repo) {
    if (busy) return;
    busy = true;
    const b = fab();
    b.textContent = "Scanning open PRs...";
    try {
      const resp = await api.runtime.sendMessage({ type: "batch", owner, repo }).catch(() => null);
      if (!resp || !resp.ok) {
        b.textContent =
          resp && (resp.error === "github" || resp.error === "network") ? (resp.detail || "Network failed") :
          resp && resp.error === "quota" ? "Daily free scans used up" :
          resp && resp.error === "no_open_prs" ? "No open PRs" :
          "Batch scan failed";
        return;
      }
      let flagged = 0, missed = 0;
      for (const row of resp.rows) {
        const link = document.querySelector(`a[href$='/pull/${row.number}']`);
        if (!link) { if (!row.result) missed++; continue; }
        const old = link.parentElement.querySelector(`.${NS}-mini`);
        if (old) old.remove();
        const r = row.result;
        const mini = r
          ? el("span",
              `${NS}-mini ${NS}-${r.abstained ? "abstain" : r.flagged ? "flag" : "clean"}`,
              r.abstained ? "n/a" : r.flagged ? `AI? p ${r.p}` : "ok")
          : el("span", `${NS}-mini ${NS}-abstain`, "not scored");
        mini.title = r ? r.verdict : "over the per-scan limit; scan again to cover the rest";
        link.insertAdjacentElement("afterend", mini);
        if (r && r.flagged) flagged++;
        if (!r) missed++;
      }
      const tail = missed ? ` (${missed} over the scan limit)` : "";
      b.textContent = `${flagged} flagged of ${resp.rows.length}${tail}. Rescan`;
    } catch {
      b.textContent = "Batch scan failed";
    } finally {
      busy = false;
    }
  }

  // ---------- boot + SPA navigation ----------

  async function init() {
    const r = route();
    const b = fab();
    if (r.kind === "detail") {
      b.hidden = false;
      b.textContent = "Scan for AI slop";
      b.onclick = scanDetail;
      const settings = await api.runtime.sendMessage({ type: "settings" }).catch(() => null);
      if (settings && settings.autoScan) scanDetail();
    } else if (r.kind === "list") {
      b.hidden = false;
      b.textContent = "Scan open PRs";
      b.onclick = () => scanList(r.owner, r.repo);
    } else {
      b.hidden = true;
      clearBadges();
    }
  }

  // The popup's "Scan this page" button lands here.
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "scan-now") {
      const r = route();
      if (r.kind === "detail") scanDetail();
      else if (r.kind === "list") scanList(r.owner, r.repo);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  // GitHub navigates without full reloads; several generations of events.
  for (const ev of ["turbo:load", "turbo:render", "pjax:end", "soft-nav:success"]) {
    document.addEventListener(ev, () => setTimeout(init, 300));
  }
  window.addEventListener("popstate", () => setTimeout(init, 300));
  init();
})();
