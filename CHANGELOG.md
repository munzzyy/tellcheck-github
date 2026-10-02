# Changelog

Versions are the extension versions uploaded to addons.mozilla.org. The
scoring worker deploys on its own schedule. Worker changes are listed under
the version they shipped next to and marked "(worker)".

## Unreleased

- Every comment on a long thread gets a badge. Scoring calls are split to fit
  the per-request limits of the worker. Comments past the 25th and the PRs in
  a busy batch scan are no longer left "not scored".
- When the daily limit runs out partway through a scan, what fits gets scored
  and the rest is marked "not scored (daily limit)".
- Quoted text is left out of the score. A reviewer who quote-replies to a
  drafted paragraph is scored on their own words, not the quote. A comment
  with only code or images reads "not scored (no prose)".
- The batch scan strips PR-template HTML comments and code from PR bodies
  before sending them. The privacy policy always said it did.
- The batch scan scores the PRs on the page you are looking at, so filtered
  and sorted lists and later pages work. List badges show two decimals. A
  style-only hit gets its own badge. Every badge carries its verdict as text
  for screen readers.
- Batch scan errors from GitHub name the cause: the rate limit, a private repo
  or the token.
- Flagged breakdowns link to a [wrong flag](.github/ISSUE_TEMPLATE/wrong-flag.md)
  issue template. The link carries nothing about the page.
- When the shared cap for a whole network is what stopped a scan, the popup and
  the page say so. The popup used to show your own count against the network
  limit.
- The reasons under a style badge describe the comment for the maintainer
  reading it. They used to give editing advice meant for the person drafting
  it (worker).
- Relicensed from MIT to GPL-3.0-or-later. Earlier versions stay under MIT.
- The site moved to tellcheck.munzzyy.dev.
- `tools/package.sh` refuses to build a zip when web-ext lint fails or is
  missing.

## 0.1.2 (2026-09-09)

- Free, with one tier. The daily caps went up to 100 scored texts per install
  and 500 per network. The payment code that never ran is gone.
- A second signal for review comments: an amber "reads assistant-drafted
  (style)" badge from a comment-style check. It never changes the score or the
  flag from the detector.
- A long comment that ran past the word budget of a request reads "not scored"
  instead of "under 20 words" (worker).
- Short comments carry a lower-confidence note on their verdict (worker).
- Batch scans ask GitHub for 25 open PRs, as the listing says, instead of 20.

## 0.1.1 (2026-09-02)

- The toolbar icon is the new one. The 0.1.0 build still had the old icon.
- Badges follow the "sync with system" theme on GitHub instead of going dark on
  light pages.
- Badges work as disclosure buttons with a caret, a focus ring and
  aria-expanded. The scan button announces its status.
- The popup is readable in dark mode and says when the daily scans are spent.
- A saturated score reads "p 1.00", not "p 1".
- PR titles are found again on current GitHub.
- The daily meter counts in a Durable Object. Parallel scans no longer slip
  past the cap (worker).

## 0.1.0 (2026-08-28)

- First version. A scan button and badges on GitHub pull requests and issues,
  a breakdown of the signals behind each badge, a batch scan of the open PRs in
  a repo with CSV export, and the scoring worker with daily caps per install
  and per network.
