// Stands in for the private detector in CI. It never flags, so only metering and request-cap tests use it.
export default {
  analyze(text) {
    const trimmed = text.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const p = words >= 20 ? 0.1 : null;
    return {
      detect_p: p,
      detect_verdict: p === null ? "abstains" : "no detection",
      words,
      language: "en",
      score_per_1k: 0,
      ai_artifacts: [],
      buzzwords: [],
      phrases: [],
      sentence_uniformity_cv: null,
    };
  },
};
