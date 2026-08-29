# Tellcheck for GitHub

Browser extension that flags likely AI-generated pull requests and issues on GitHub,
for maintainers enforcing no-AI or disclosure policies. The classifier (the noslop
engine) runs server-side on a Cloudflare Worker; the extension is a thin client that
sends text on demand and draws badges.

```
extension/          the MV3 extension (Firefox-first)
  manifest.json     includes the AMO-required data_collection_permissions key
  background.js     all network calls live here (scoring API, GitHub API, ExtPay)
  content/          scan button, badges, signal panels on github.com
  popup/ options/   quota display, CSV export, settings
worker/             the scoring API
  src/index.js      POST /score with per-install daily metering (KV)
  src/detector-core.js   PRIVATE, gitignored; synced from ~/Projects/noslop
site/               landing page + privacy policy (deploy as a Pages project)
vendor/ExtPay.js    unmodified ExtensionPay client (AGPLv3), staged for a paid version
tools/              sync_detector.py, gen_icons.py, package.sh
test/               worker test suite (node --test)
```

## Development

```
python3 tools/sync_detector.py        # pull the private detector into the worker
node --test test/worker.test.mjs      # 14 tests, no network needed
python3 test/content_smoke.py         # headless DOM smoke test (needs chromium)
bash tools/package.sh                 # lint + build dist/tellcheck-github-x.y.z.zip
```

Load the extension for manual testing: Firefox -> about:debugging -> This Firefox ->
Load Temporary Add-on -> pick extension/manifest.json.

## Deploy (the worker)

```
cd worker
wrangler kv namespace create QUOTA    # paste the printed id into wrangler.toml
wrangler deploy                       # prints the live URL
```

Put the live URL into extension/config.js API_URL if it differs from the default.

## Domain and cutover

Buy `tellcheck.dev` when ready (a subdomain of it, or a Pages custom domain, can replace
`tellcheck-github.pages.dev` with a one-line edit to `extension/config.js` and the site).
`redirects/` holds a stub worker and a `_redirects` file that 301 the old `slopscreen-api`
worker and `slopscreen.pages.dev` site to the new addresses; see `redirects/README.md`.

## Monetization

ExtensionPay (5% + Stripe fees, pays into the connected Stripe account). v0.1 ships
with payments fully OFF: vendor/ExtPay.js is NOT in the manifest or the zip, so the
extension carries no payment code, no extensionpay.com permission, and no upgrade UI.
To enable in a later version: register on extensionpay.com, set EXTPAY_ID in
extension/config.js, copy vendor/ExtPay.js back to extension/lib/, and restore the
manifest entries (background scripts list, extensionpay.com content script + host
permission). background.js already guards every ExtPay touchpoint on typeof, and falls
back to a 72h-cached paid status when extensionpay.com is unreachable.
ExtensionPay has no server-side validation API, so paid status is client-asserted; the
worker bounds abuse with a hard daily ceiling per install. The private detector never
ships to clients either way.

## The one rule

Every surfaced score says "signal, not proof". The classifier abstains under 20 words
and is calibrated to a 5% false-positive operating point. Do not weaken that framing in
any UI copy; false accusations are the product's biggest risk.
