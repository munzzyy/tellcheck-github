# AMO listing copy (paste at submission)

## Name
SlopScreen

## Summary (250 chars max)
Flags likely AI-generated pull requests and issues on GitHub. One click scores every
comment and shows which signals fired. Calibrated to a 5% false-positive rate, abstains
on short text. A signal for maintainers, not a verdict.

## Description
Your issue tracker is filling with AI slop. Codeberg, Godot, OpenJDK, Rust, and Ghostty
all restricted AI-generated contributions this year. Enforcing a policy means a human
has to read every submission twice.

SlopScreen does the first read. On any GitHub pull request or issue, click scan. The
description and comments get badges saying whether the text statistically reads as
AI-generated. Each badge opens a breakdown of the exact signals that fired: buzzword
density, stock phrases, uniform sentence rhythm, chat-UI artifacts, and more. On a
repo's pull request list, scan the 20 most recent open PRs in one click. Anything over
a scan's limit is labeled "not scored", never silently skipped.

Honest by design. The classifier runs at a 5% false-positive operating point, abstains
on text too short to judge, and every result is labeled a signal rather than proof.
Flagging a real person's writing as AI is worse than missing one bot, and the tool is
built around that principle.

Private by design. Nothing leaves your browser until you click scan (auto-scan exists,
ships off). Scanned text is scored over HTTPS and discarded, never stored. No accounts,
no tracking. Optional GitHub token for batch scans stays on your device.

Free tier: 30 scored texts a day, enough for daily maintenance of a small project.

## Categories
Developer Tools

## Privacy policy URL
(the site's /privacy.html once deployed)

## Support email
Munzzyy1@proton.me

## Reviewer notes (paste into "Notes to Reviewer")
The extension sends the text of the currently viewed GitHub PR/issue to our scoring API
(a Cloudflare Worker) when the user clicks scan; the API returns a statistical score and
the matched signals, and does not store the text. No code is loaded remotely; no
analytics; no payment code in this version. The data_collection_permissions key declares
websiteContent (the scanned text) and, as optional, technicalAndInteraction (a random
meter id sent with scans for the daily free-scan counter; it rotates every UTC day, so
nothing is trackable across days).
