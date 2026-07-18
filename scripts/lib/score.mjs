const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const clamp = (value, minimum, maximum) =>
  Math.min(Math.max(value, minimum), maximum);

export function normalizeRating(rating, sourceKey, medium, config) {
  if (!rating || !Number.isFinite(rating.raw) || rating.raw < 0) return null;
  if (!Number.isFinite(rating.votes) || rating.votes <= 0) return null;

  const source = config.sources[sourceKey];
  if (!source) throw new Error(`Unknown source: ${sourceKey}`);

  const rawTen = (10 * rating.raw) / rating.scale;
  const calibration = source.calibration[medium];
  const target = config.targetDistribution;
  const calibrated =
    calibration.mode === "robust-z" &&
    calibration.sampleSize >= target.minimumCalibrationSample;

  let normalized = rawTen;
  let calibrationReliability = 0.6;

  if (calibrated) {
    const spread = Math.max(calibration.spread, 0.35);
    const z = clamp((rawTen - calibration.median) / spread, -2.8, 2.8);
    normalized = clamp(target.median + target.spread * z, 0, 10);
    calibrationReliability = 1;
  }

  const halfLife = source.voteHalfLife[medium];
  const voteConfidence = rating.votes / (rating.votes + halfLife);
  const effectiveWeight =
    source.baseWeight[medium] * calibrationReliability * voteConfidence;

  return {
    ...rating,
    normalized: round(normalized),
    voteConfidence: round(voteConfidence),
    effectiveWeight: round(effectiveWeight),
    calibrationMode: calibrated ? "robust-z" : "identity-fallback",
  };
}

export function calculateScore(ratings, medium, config) {
  const normalizedRatings = {};
  let weightedTotal = 0;
  let totalWeight = 0;
  let coveredBaseWeight = 0;
  let availableBaseWeight = 0;
  let sourceCount = 0;

  for (const [sourceKey, source] of Object.entries(config.sources)) {
    availableBaseWeight += source.baseWeight[medium] ?? 0;
    const normalized = normalizeRating(ratings[sourceKey], sourceKey, medium, config);
    normalizedRatings[sourceKey] = normalized;

    if (!normalized) continue;
    sourceCount += 1;
    coveredBaseWeight += source.baseWeight[medium];
    totalWeight += normalized.effectiveWeight;
    weightedTotal += normalized.effectiveWeight * normalized.normalized;
  }

  const coverage = availableBaseWeight
    ? coveredBaseWeight / availableBaseWeight
    : 0;
  const hasEnoughSources = sourceCount >= config.minimumSources;
  const value = hasEnoughSources && totalWeight > 0
    ? weightedTotal / totalWeight
    : null;

  return {
    ratings: normalizedRatings,
    score: {
      value: value === null ? null : round(clamp(value, 0, 10)),
      sourceCount,
      coverage: round(coverage),
      totalWeight: round(totalWeight),
      status: sourceCount === 0 ? "unrated" : hasEnoughSources ? "ranked" : "single-source",
    },
  };
}
