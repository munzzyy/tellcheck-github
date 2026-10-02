# AMO listing copy (paste at submission)

## Name
Tellcheck for GitHub

## Summary (250 chars max)
Flags likely AI-generated pull requests and issues on GitHub. One click scores every
comment and shows which signals fired. Tuned to miss a bot before it accuses a person,
and it abstains on short text. A signal for maintainers, not a verdict.

## Description
Your issue tracker is filling with AI slop. Codeberg, Godot, OpenJDK, Rust, and Ghostty
all restricted AI-generated contributions this year. Whichever way a project lands,
enforcing it means a human still has to read every submission.

Tellcheck for GitHub does the first read. On any GitHub pull request or issue, click
scan. The description and comments get badges saying whether the text statistically
reads as AI-generated. Each badge opens a breakdown of the exact signals that fired:
buzzword density, stock phrases, uniform sentence rhythm, chat-UI artifacts, and more.
On a repo's pull request list, scan up to 25 open PRs in one click. Anything past a
scan's limit is labeled "not scored", never silently skipped.

Honest about what it is. It surfaces tells for a human to weigh and never returns a
verdict. Nobody can prove AI authorship after the fact, this tool included. Every result
is a signal at a stated false-positive rate. On a held-out set of 4,300 real
non-native-English essays that rate is 7.8%, not zero. That is the honest ceiling on
trusting any single flag. It is why the advice never changes: judge the contribution,
not the author. The full measurement page with the held-out numbers and the named
failure modes is linked from the site.

Private by design. Nothing leaves your browser until you click scan (auto-scan exists,
ships off). Scanned text is scored over HTTPS and discarded, never stored. No accounts,
no tracking. Optional GitHub token for batch scans stays on your device.

Free, with a cap of 100 scored texts a day per install. No account, no paid tier,
nothing for sale.

## Categories (AMO consumer list; pick up to 3)
Web Development (primary), Privacy & Security

## Screenshots to upload (in site/shots/)
1. detail-light.png  - a scanned PR: flagged description with the signal panel open, clean human comment
2. detail-dark.png   - same, dark theme
3. list-light.png    - batch mode scoring a repo's open PR list
4. demo.gif          - the scan in motion (AMO accepts animated screenshots)
Lead with detail-light.png; it shows the whole value in one frame.

## Privacy policy URL
https://tellcheck.munzzyy.dev/privacy

## Support email
Munzzyy1@proton.me

## Reviewer notes (paste into "Notes to Reviewer")
The extension sends the text of the currently viewed GitHub PR/issue to our scoring API
(a Cloudflare Worker) when the user clicks scan; the API returns a statistical score and
the matched signals, and does not store the text. No code is loaded remotely; no
analytics; no payment code. The data_collection_permissions key declares
websiteContent (the scanned text) and, as optional, technicalAndInteraction (a random
meter id sent with scans for the daily free-scan counter; it rotates every UTC day, so
nothing is trackable across days).

Thanks for reviewing it.
