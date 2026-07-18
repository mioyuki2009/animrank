import assert from "node:assert/strict";
import test from "node:test";
import { calculateScore, normalizeRating } from "../scripts/lib/score.mjs";

const config = {
  minimumSources: 1,
  prior: { mean: 6.5, weight: 0.05 },
  targetDistribution: {
    median: 6.5,
    spread: 1.25,
    minimumCalibrationSample: 300,
  },
  sources: {
    a: {
      baseWeight: { anime: 0.4, manga: 0.4 },
      voteHalfLife: { anime: 100, manga: 100 },
      calibration: {
        anime: { mode: "identity-fallback", median: 6.5, spread: 1.25, sampleSize: 0 },
        manga: { mode: "identity-fallback", median: 6.5, spread: 1.25, sampleSize: 0 },
      },
    },
    b: {
      baseWeight: { anime: 0.3, manga: 0.3 },
      voteHalfLife: { anime: 100, manga: 100 },
      calibration: {
        anime: { mode: "identity-fallback", median: 6.5, spread: 1.25, sampleSize: 0 },
        manga: { mode: "identity-fallback", median: 6.5, spread: 1.25, sampleSize: 0 },
      },
    },
    c: {
      baseWeight: { anime: 0.3, manga: 0.3 },
      voteHalfLife: { anime: 100, manga: 100 },
      calibration: {
        anime: { mode: "identity-fallback", median: 6.5, spread: 1.25, sampleSize: 0 },
        manga: { mode: "identity-fallback", median: 6.5, spread: 1.25, sampleSize: 0 },
      },
    },
  },
};

const rating = (raw, scale = 10, votes = 10_000) => ({
  raw,
  scale,
  votes,
  url: "https://example.com",
  fetchedAt: "2026-07-17T00:00:00.000Z",
  via: "fixture",
  stale: false,
});

test("85/100 and 8.5/10 normalize to the same score", () => {
  const tenPoint = normalizeRating(rating(8.5), "a", "anime", config);
  const hundredPoint = normalizeRating(rating(85, 100), "a", "anime", config);
  assert.equal(tenPoint.normalized, hundredPoint.normalized);
});

test("missing sources are omitted from the average", () => {
  const result = calculateScore({ a: rating(9), b: null, c: null }, "anime", config);
  assert.equal(result.score.status, "ranked");
  assert.equal(result.score.sourceCount, 1);
  assert.ok(result.score.value > 8 && result.score.value < 9);
});

test("two mature sources produce a bounded final score", () => {
  const result = calculateScore(
    { a: rating(9), b: rating(8), c: null },
    "anime",
    config,
  );
  assert.equal(result.score.status, "ranked");
  assert.equal(result.score.sourceCount, 2);
  assert.ok(result.score.value > 8 && result.score.value < 9);
  assert.equal(result.score.coverage, 0.7);
});

test("more votes increase confidence without exceeding one", () => {
  const low = normalizeRating(rating(8, 10, 10), "a", "anime", config);
  const high = normalizeRating(rating(8, 10, 10_000), "a", "anime", config);
  assert.ok(low.voteConfidence < high.voteConfidence);
  assert.ok(high.voteConfidence < 1);
});

test("robust calibration is monotonic and clamped", () => {
  const calibrated = structuredClone(config);
  calibrated.sources.a.calibration.anime = {
    mode: "robust-z",
    median: 6,
    spread: 0.8,
    sampleSize: 1000,
  };
  const low = normalizeRating(rating(5), "a", "anime", calibrated);
  const high = normalizeRating(rating(9.8), "a", "anime", calibrated);
  assert.ok(low.normalized < high.normalized);
  assert.ok(low.normalized >= 0);
  assert.ok(high.normalized <= 10);
});
