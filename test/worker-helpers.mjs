// Shared by the worker suites: mock KV, a /score request builder and two reference texts.
export function mockKV(store = new Map()) {
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

export function req(body, path = "/score") {
  return new Request(`https://tellcheck-github.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const AI_TEXT =
  "This comprehensive pull request delves into the intricacies of the parser, " +
  "leveraging robust design patterns to seamlessly enhance maintainability and " +
  "foster a vibrant developer experience. Additionally, it underscores our " +
  "commitment to excellence. Furthermore, the meticulous implementation showcases " +
  "transformative improvements across the entire stack, empowering contributors " +
  "to unlock unprecedented capabilities. Moreover, this holistic approach ensures " +
  "seamless integration while navigating the ever-evolving landscape of modern " +
  "software development, and it is a testament to the power of collaboration.";

export const HUMAN_TEXT =
  "fixed the null deref in parse_config, it blew up when the ini had a section " +
  "with no keys. added a regression test. also killed two warnings gcc 15 " +
  "started throwing about the flexible array member. tested on arch and a " +
  "debian 13 container, both clean now as far as i can tell.";
