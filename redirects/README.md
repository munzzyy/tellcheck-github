# Cutover from slopscreen to Tellcheck for GitHub

Run this after the new `tellcheck-github` worker and Pages project are deployed and
confirmed working. Both commands below deploy INTO the OLD Cloudflare resources (same
names as before the rename), replacing their content with a redirect.

## 1. Redirect the old worker
```
cd redirects/worker
npx --yes wrangler@latest deploy
```
`worker/wrangler.toml` has `name = "slopscreen-api"`, the same name the original worker
was deployed under, so this overwrites that worker in place with the 301 stub in
`worker/index.js`. Any old extension build still calling
`https://slopscreen-api.<account>.workers.dev` gets a 301 to the same path on
`tellcheck-github.munzzyy.workers.dev`.

## 2. Redirect the old Pages site
```
cd redirects
npx --yes wrangler@latest pages deploy pages --project-name=slopscreen --branch=main
```
Deploys the `redirects/pages/` folder (just a `_redirects` file) as the entire site for
the old `slopscreen` Pages project. It 301s every path to the matching path on
`https://tellcheck-github.pages.dev`.

## Verify
```
curl -sI https://slopscreen-api.<account>.workers.dev/health
curl -sI https://slopscreen.pages.dev/
```
Both should return `301` with a `location` header pointing at the new host.

## Note on the extension itself
The Firefox add-on was never submitted to AMO under the old name (no listing exists to
redirect), so there is no AMO-side cutover step. Submit the rebuilt
`dist/tellcheck-github-*.zip` under the new name directly.
