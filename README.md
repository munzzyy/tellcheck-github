# SlopScreen

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
  lib/ExtPay.js     unmodified ExtensionPay client (AGPLv3), vendored
worker/             the scoring API
  src/index.js      POST /score with per-install daily metering (KV)
  src/detector-core.js   PRIVATE, gitignored; synced from ~/Projects/noslop
site/               landing page + privacy policy (deploy as a Pages project)
tools/              sync_detector.py, gen_icons.py, package.sh
test/               worker test suite (node --test)
```

## Development

```
python3 tools/sync_detector.py        # pull the private detector into the worker
node --test test/worker.test.mjs      # 11 tests, no network needed
bash tools/package.sh                 # lint + build dist/slopscreen-x.y.z.zip
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

## Monetization

ExtensionPay (5% + Stripe fees, pays into the connected Stripe account). Payments stay
OFF until EXTPAY_ID in extension/config.js is set to a registered extension id from
extensionpay.com. With it unset, every feature is free and no upgrade UI shows.
ExtensionPay has no server-side validation API, so paid status is client-asserted; the
worker bounds abuse with a hard daily ceiling per install. The private detector never
ships to clients either way.

## The one rule

Every surfaced score says "signal, not proof". The classifier abstains under 20 words
and is calibrated to a 5% false-positive operating point. Do not weaken that framing in
any UI copy; false accusations are the product's biggest risk.
