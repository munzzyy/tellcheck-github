// comment-tells.js keeps the drafting advice of its Python original for parity; the panel speaks to the maintainer instead.
export const FOR_MAINTAINERS = new Map([
  ["median real comment is 47; cut it hard",
    "real review comments run 47 words at the median"],
  ["running long for a comment (median 47)",
    "longer than most review comments, which run 47 words at the median"],
  ["median 32 - split the subordinate clauses into sentences",
    "real review comments run 32 per 1k words at the median"],
  ["median real comment has none; this genre is not chatty",
    "the median real review comment has none"],
  ["real reviewers open or close with one",
    "real review comments often open or close with one"],
  ["real comments point at something",
    "real review comments usually point at an issue, a person or a link"],
  ["real reviewers ask; drafts assert",
    "real review comments often ask a question, drafted ones rarely do"],
  ["they know; open with what is new instead",
    "real replies usually lead with something new"],
  ["scorekeeping - state the fact and move on",
    "drafted replies often list what the author already did"],
  ["banned outright in house style",
    "a frequent mark of assistant-drafted text"],
]);

export function styleReason([label, hint]) {
  return `${label}: ${FOR_MAINTAINERS.get(hint) ?? hint}`;
}
