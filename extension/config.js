// One place for deploy-specific values. Loaded before background.js.
//
// API_URL: set to the real workers.dev URL after the first `wrangler deploy`
// (the exact URL is printed by the deploy). EXTPAY_ID: the extension id from
// extensionpay.com once registered; empty string keeps every paid gate open
// and hides upgrade buttons, so the extension works fully without payments.
const TELLCHECK = {
  API_URL: "https://tellcheck-github.munzzyy.workers.dev",
  EXTPAY_ID: "",
  FREE_DAILY: 30,
};
