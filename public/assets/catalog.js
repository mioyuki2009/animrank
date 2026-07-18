const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function searchableText(item) {
  return [item.title.zh, item.title.original, item.year, item.format]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

export function commercialValue(item) {
  if (!item.commercial) return null;
  const value =
    item.medium === "anime"
      ? item.commercial.unitsTotal ?? item.commercial.unitsPerVolume
      : item.commercial.perVolume;
  return Number.isFinite(value) ? value : null;
}

export function ratingValue(item, source) {
  const rating = item.ratings?.[source];
  if (!rating) return null;
  if (Number.isFinite(rating.normalized)) return rating.normalized;
  if (Number.isFinite(rating.raw) && Number.isFinite(rating.scale) && rating.scale > 0) {
    return (10 * rating.raw) / rating.scale;
  }
  return null;
}

function numericCompare(left, right, direction) {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  return (left - right) * (direction === "asc" ? 1 : -1);
}

export function filterAndSort(items, options = {}) {
  const {
    search = "",
    coverage = "all",
    sort = "score",
    direction = "desc",
  } = options;
  const needle = search.trim().toLocaleLowerCase("zh-CN");

  const filtered = items.filter((item) => {
    if (needle && !searchableText(item).includes(needle)) return false;
    if (coverage === "complete" && item.score.sourceCount !== 3) return false;
    if (coverage === "missing" && item.score.sourceCount === 3) return false;
    if (coverage === "ranked" && item.score.status !== "ranked") return false;
    return true;
  });

  return filtered.sort((left, right) => {
    let compared = 0;
    if (sort === "score") {
      compared = numericCompare(left.score.value, right.score.value, direction);
    } else if (sort === "commercial") {
      compared = numericCompare(commercialValue(left), commercialValue(right), direction);
    } else if (["bangumi", "mal", "anilist"].includes(sort)) {
      compared = numericCompare(ratingValue(left, sort), ratingValue(right, sort), direction);
    } else if (sort === "year") {
      compared = numericCompare(left.year, right.year, direction);
    } else if (sort === "sources") {
      compared = numericCompare(left.score.sourceCount, right.score.sourceCount, direction);
    } else if (sort === "title") {
      compared = collator.compare(left.title.zh, right.title.zh);
      if (direction === "desc") compared *= -1;
    }

    return compared || collator.compare(left.title.zh, right.title.zh);
  });
}

export function isOlderThan(isoDate, days, now = Date.now()) {
  if (!isoDate) return true;
  return now - Date.parse(isoDate) > days * 86_400_000;
}
