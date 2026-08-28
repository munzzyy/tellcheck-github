"use strict";
const api = globalThis.browser ?? globalThis.chrome;

async function load() {
  const got = await api.storage.local.get(["autoScan", "githubPat", "apiUrl"]);
  document.getElementById("autoScan").checked = !!got.autoScan;
  document.getElementById("githubPat").value = got.githubPat || "";
  document.getElementById("apiUrl").value = got.apiUrl || "";
}

document.getElementById("save").onclick = async () => {
  await api.storage.local.set({
    autoScan: document.getElementById("autoScan").checked,
    githubPat: document.getElementById("githubPat").value.trim(),
    apiUrl: document.getElementById("apiUrl").value.trim(),
  });
  const s = document.getElementById("saved");
  s.style.visibility = "visible";
  setTimeout(() => { s.style.visibility = "hidden"; }, 1500);
};

load();
