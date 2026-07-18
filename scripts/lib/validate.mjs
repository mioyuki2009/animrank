const sourceKeys = ["bangumi", "mal", "anilist"];

export function validateCatalogConfig(config) {
  const errors = [];
  assert(config && typeof config === "object" && !Array.isArray(config), "Catalog config must be an object", errors);
  for (const medium of ["anime", "manga"]) {
    const value = config?.[medium];
    assert(Number.isInteger(value) && value > 0 && value <= 500, `Invalid ${medium} catalog limit`, errors);
  }
  return errors;
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isExcludedFormat(medium, format) {
  const normalized = String(format || "")
    .trim()
    .toLocaleUpperCase("en-US")
    .replace(/[\s-]+/g, "_");
  return medium === "manga"
    ? ["NOVEL", "LIGHT_NOVEL", "小说", "轻小说", "ライトノベル"].includes(normalized)
    : ["MUSIC", "CM", "PV"].includes(normalized);
}

export function validateCatalog(titles) {
  const errors = [];
  const ids = new Set();

  assert(Array.isArray(titles) && titles.length > 0, "Catalog must not be empty", errors);
  for (const item of titles) {
    assert(!ids.has(item.id), `Duplicate catalog id: ${item.id}`, errors);
    ids.add(item.id);
    assert(["anime", "manga"].includes(item.medium), `Invalid medium: ${item.id}`, errors);
    assert(item.id.startsWith(`${item.medium}:`), `ID/medium mismatch: ${item.id}`, errors);
    assert(Boolean(item.title?.zh && item.title?.original), `Missing title: ${item.id}`, errors);
    assert(Number.isInteger(item.year) && item.year > 1900, `Invalid year: ${item.id}`, errors);
    assert(!isExcludedFormat(item.medium, item.format), `Excluded format: ${item.id}`, errors);
    for (const source of sourceKeys) {
      const value = item.ids?.[source];
      assert(
        value === null || (Number.isInteger(value) && value > 0),
        `Invalid ${source} id: ${item.id}`,
        errors,
      );
    }
    assert(
      sourceKeys.filter((source) => item.ids?.[source] !== null).length >= 1,
      `No mapped source: ${item.id}`,
      errors,
    );
  }

  return errors;
}

export function validateEditorial(editorial, titles) {
  const errors = [];

  for (const medium of ["anime", "manga"]) {
    for (const [id, item] of Object.entries(editorial[medium] || {})) {
      // Editorial audits may outlive the current capped catalog; they are
      // applied when a matching discovered ID returns to the list.
      assert(id.startsWith(`${medium}:`), `Editorial medium mismatch: ${id}`, errors);
      assert(isIsoDate(item.asOf), `Invalid editorial date: ${id}`, errors);
      assert(isHttpUrl(item.sourceUrl), `Invalid editorial source URL: ${id}`, errors);

      if (medium === "anime") {
        assert(item.unitsPerVolume > 0, `Invalid anime sales: ${id}`, errors);
        assert(Number.isInteger(item.releaseCount) && item.releaseCount > 0, `Invalid release count: ${id}`, errors);
      } else {
        assert(Number.isInteger(item.circulation) && item.circulation > 0, `Invalid circulation: ${id}`, errors);
        assert(
          Number.isInteger(item.volumesAtAnnouncement) && item.volumesAtAnnouncement > 0,
          `Invalid announcement volume count: ${id}`,
          errors,
        );
      }
    }
  }

  return errors;
}

export function validateGenerated(items, config) {
  const errors = [];
  const ids = new Set();

  for (const item of items) {
    assert(!ids.has(item.id), `Duplicate generated id: ${item.id}`, errors);
    ids.add(item.id);
    assert(["anime", "manga"].includes(item.medium), `Invalid generated medium: ${item.id}`, errors);
    assert(item.commercial !== undefined, `Commercial field missing: ${item.id}`, errors);

    let sourceCount = 0;
    for (const source of sourceKeys) {
      const rating = item.ratings?.[source];
      if (rating === null) continue;
      sourceCount += 1;
      assert(rating.raw >= 0 && rating.raw <= rating.scale, `Rating out of range: ${item.id}/${source}`, errors);
      assert(rating.votes > 0, `Votes must be positive: ${item.id}/${source}`, errors);
      assert(rating.normalized >= 0 && rating.normalized <= 10, `Normalized score out of range: ${item.id}/${source}`, errors);
      assert(isHttpUrl(rating.url), `Invalid rating URL: ${item.id}/${source}`, errors);
    }

    assert(item.score.sourceCount === sourceCount, `Source count mismatch: ${item.id}`, errors);
    if (sourceCount < config.minimumSources) {
      assert(item.score.value === null, `Undersourced item has final score: ${item.id}`, errors);
    } else {
      assert(item.score.value >= 0 && item.score.value <= 10, `Final score out of range: ${item.id}`, errors);
    }

    if (item.medium === "manga" && item.commercial) {
      const expected = Math.round(
        item.commercial.circulation / item.commercial.volumesAtAnnouncement,
      );
      assert(item.commercial.perVolume === expected, `Per-volume mismatch: ${item.id}`, errors);
    }
    if (item.medium === "anime" && item.commercial) {
      const totalValid = Number.isInteger(item.commercial.unitsTotal) &&
        item.commercial.unitsTotal > 0;
      const averageValid = Number.isFinite(item.commercial.unitsPerVolume) &&
        item.commercial.unitsPerVolume > 0;
      assert(totalValid || averageValid, `Invalid anime commercial data: ${item.id}`, errors);
    }
  }

  return errors;
}
