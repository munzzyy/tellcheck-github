// Stub worker for the old "slopscreen-api" name. 301s every path (and query
// string) to the same path on the new tellcheck-github worker. Deploy this in
// place of the real worker once tellcheck-github is live, so any extension
// build still pointed at the old URL keeps working while it migrates.
const NEW_HOST = "tellcheck-github.munzzyy.workers.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = NEW_HOST;
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  },
};
