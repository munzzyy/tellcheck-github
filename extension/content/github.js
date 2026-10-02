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
    // Current GitHub, checked against live PR and issue pages 2026-09-02:
    // js-issue-title is gone from all of them. The React page header is the
    // one constant, on both the pages that still render classic timeline
    // comments and the fully React ones. Take the inner .markdown-title,
    // because the h1 also holds a screen-reader "- #15000" sibling.
    "h1[data-component='PH_Title'] .markdown-title",
    "[data-testid='issue-title']",
    // Older generations, kept as fallbacks.
    "h1 .js-issue-title",
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
      // Block 0 is the PR/issue description: longer-form genre, kind "pr".
      // Everything after it is a thread comment.
      if (text) items.push({ id: `b${i}`, text, el, kind: i === 0 ? "pr" : "comment" });
    });
    return items;
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
    // The button's own label is the status readout ("Scanning...", "3 flagged
    // of 12"), so a screen reader has to be told it updates in place.
    b.setAttribute("aria-live", "polite");
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
      // The worker returns a bare 1 for a saturated score, which rendered as
      // "(p 1)" next to siblings reading "(p 0.94)" and looked broken.
      label = result.p === null || result.p === undefined
        ? "Tellcheck: flags as AI (chat artifact)"
        : `Tellcheck: flags as AI (p ${Number(result.p).toFixed(2)})`;
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

  // Secondary chip for the comment-style layer. A separate signal from the
  // detector's p: it scores genre tells (length, comma density, contractions,
  // whether the text points at anything), never the statistical score, and
  // the two are never merged into one number.
  function styleChipFor() {
    const chip = el("button", `${NS}-chip ${NS}-style`, "Tellcheck: reads assistant-drafted (style)");
    chip.type = "button";
    return chip;
  }

  const NOT_SCORED = {
    budget: ["scan limit", "Refused as over the scoring server's per-request limit."],
    quota: ["daily limit", "The daily scan limit ran out before this one."],
    error: ["server error", "The scoring server did not answer."],
  };

  function notScoredReason(r) {
    if (!r) return "budget";
    return Object.hasOwn(NOT_SCORED, r.reason) ? r.reason : null;
  }

  function notScoredChip(reason) {
    const [label, title] = NOT_SCORED[reason];
    const chip = el("span", `${NS}-chip ${NS}-abstain`, `Tellcheck: not scored (${label})`);
    chip.title = title;
    return chip;
  }

  function missTail(miss) {
    return [
      miss.budget && `${miss.budget} over the scan limit`,
      miss.quota && `${miss.quota} past the daily limit`,
      miss.error && `${miss.error} not answered`,
    ].filter(Boolean).map((s) => `, ${s}`).join("");
  }

  function panelFor(result) {
    const panel = el("div", `${NS}-panel`);
    panel.appendChild(el("div", `${NS}-panel-verdict`, result.verdict));
    const meta = `${result.words} words scored` +
      (result.truncated ? ` (long text, first ${result.words} words)` : "") +
      (result.language && result.language !== "en" ? ` | language: ${result.language}` : "");
    panel.appendChild(el("div", `${NS}-panel-meta`, meta));
    if (result.signals && result.signals.length) {
      const ul = el("ul", `${NS}-signals`);
      for (const s of result.signals) ul.appendChild(el("li", null, s));
      panel.appendChild(ul);
    }
    if (result.style_flag) {
      panel.appendChild(el("div", `${NS}-panel-style`,
        "Separate signal: the comment style reads assistant-drafted " +
        `(${result.style_points} genre points, flags above 7). ` +
        "This scores the genre, not the author, and is measured against one " +
        "drafting pipeline; easy to evade, so absence means nothing."));
      const ul = el("ul", `${NS}-signals`);
      for (const s of result.style_reasons || []) ul.appendChild(el("li", null, s));
      panel.appendChild(ul);
    }
    panel.appendChild(el("div", `${NS}-panel-foot`,
      "A statistical signal, not proof. The 5% false-positive point is measured " +
      "on longer text; short comments run less certain. " +
      "Judge the contribution, not the author."));
    return panel;
  }

  let panelSeq = 0;

  function attachBadge(block, result) {
    const chips = [chipFor(result)];
    // Style-only hit: the detect chip stays primary and reads clean; the
    // style layer gets its own secondary chip. When both fire, the detect
    // chip alone carries the badge row and the panel shows both breakdowns.
    if (result.style_flag && !result.flagged) chips.push(styleChipFor());
    const panel = panelFor(result);
    panel.hidden = true;
    // The chips are disclosure buttons. Without these they announce as plain
    // buttons and never say whether the breakdown is open, which is the whole
    // "reasons shown" part of the product.
    panel.id = `${NS}-panel-${++panelSeq}`;
    for (const chip of chips) {
      chip.setAttribute("aria-controls", panel.id);
      chip.setAttribute("aria-expanded", "false");
      chip.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        for (const c of chips) c.setAttribute("aria-expanded", String(!panel.hidden));
      });
    }
    block.el.insertAdjacentElement("beforebegin", chips[0]);
    let last = chips[0];
    for (const chip of chips.slice(1)) {
      last.insertAdjacentElement("afterend", chip);
      last = chip;
    }
    last.insertAdjacentElement("afterend", panel);
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
        texts: texts.map(({ id, text, kind }) => ({ id, text, kind })),
      }).catch(() => null);
      if (!resp || !resp.ok) {
        b.textContent = resp && resp.error === "quota"
          ? "Daily scan limit reached"
          : "Scan failed (API unreachable?)";
        return;
      }
      const byId = new Map(resp.results.map((r) => [r.id, r]));
      let flagged = 0, scored = 0;
      const miss = { budget: 0, quota: 0, error: 0 };
      for (const t of texts) {
        const r = byId.get(t.id);
        // Missing from the response or refused: say so instead of silently skipping.
        const why = notScoredReason(r);
        if (why) {
          t.el.insertAdjacentElement("beforebegin", notScoredChip(why));
          miss[why]++;
          continue;
        }
        attachBadge(t, r);
        if (!r.abstained) scored++;
        if (r.flagged) flagged++;
      }
      const tail = missTail(miss);
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
          resp && resp.error === "quota" ? "Daily scan limit reached" :
          resp && resp.error === "no_open_prs" ? "No open PRs" :
          "Batch scan failed";
        return;
      }
      let flagged = 0, missed = 0;
      for (const row of resp.rows) {
        const why = notScoredReason(row.result);
        const r = why ? null : row.result;
        const link = document.querySelector(`a[href$='/pull/${row.number}']`);
        if (!link) { if (!r) missed++; continue; }
        const old = link.parentElement.querySelector(`.${NS}-mini`);
        if (old) old.remove();
        const mini = r
          ? el("span",
              `${NS}-mini ${NS}-${r.abstained ? "abstain" : r.flagged ? "flag" : "clean"}`,
              r.abstained ? "n/a" : r.flagged ? `AI? p ${r.p}` : "ok")
          : el("span", `${NS}-mini ${NS}-abstain`, "not scored");
        mini.title = r ? r.verdict : NOT_SCORED[why][1];
        link.insertAdjacentElement("afterend", mini);
        if (r && r.flagged) flagged++;
        if (!r) missed++;
      }
      const tail = missed ? ` (${missed} not scored)` : "";
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
