import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAniList } from "./lib/adapters/anilist.mjs";
import { fetchBangumi } from "./lib/adapters/bangumi.mjs";
import { fetchMal } from "./lib/adapters/mal.mjs";
import { fetchCommercialData, inheritMangaEditions } from "./lib/commercial.mjs";
import { cacheCoverAssets } from "./lib/covers.mjs";
import { discoverCatalog } from "./lib/discover.mjs";
import { calculateScore } from "./lib/score.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceKeys = ["bangumi", "mal", "anilist"];

async function readJson(relativePath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJson(relativePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(root, relativePath), serialized, "utf8");
}

function adapterFailure(key, error) {
  return {
    key,
    ratings: new Map(),
    errors: [{ id: null, message: error.message }],
    status: "error",
    via: "unavailable",
  };
}

function mergeSourceResult(key, discovered, adapter) {
  const ratings = new Map(discovered.ratings[key]);
  for (const [id, record] of adapter.ratings) ratings.set(id, record);

  const discoveryErrors = discovered.errors
    .filter((error) => error.source === key)
    .map((error) => ({ id: null, message: `${error.medium}: ${error.message}` }));
  const errors = [...discoveryErrors, ...adapter.errors];
  const usedDiscovery = discovered.ratings[key].size > 0;
  const via = [usedDiscovery ? "catalog discovery" : null, adapter.ratings.size ? adapter.via : null]
    .filter(Boolean)
    .join(" + ") || adapter.via;

  return {
    key,
    ratings,
    errors,
    status: errors.length === 0 ? "ok" : ratings.size > 0 ? "partial" : "error",
    via,
  };
}

function editorialCommercialFor(title, editorial) {
  const entry = editorial[title.medium]?.[title.id];
  if (!entry) return null;

  if (title.medium === "anime") {
    return {
      metric: "bd-dvd-average",
      unitsPerVolume: entry.unitsPerVolume,
      releaseCount: entry.releaseCount,
      asOf: entry.asOf,
      scope: entry.scope,
      sourceUrl: entry.sourceUrl,
      sourceLabel: entry.sourceLabel,
    };
  }

  return {
    metric: "circulation-per-volume",
    circulation: entry.circulation,
    volumesAtAnnouncement: entry.volumesAtAnnouncement,
    perVolume: Math.round(entry.circulation / entry.volumesAtAnnouncement),
    asOf: entry.asOf,
    scope: entry.scope,
    includesDigital: entry.includesDigital,
    sourceUrl: entry.sourceUrl,
    sourceLabel: entry.sourceLabel,
  };
}

function commercialSourceKey(commercial, medium) {
  const sourceUrl = String(commercial?.sourceUrl || "").toLocaleLowerCase("en-US");
  if (medium === "anime") {
    if (sourceUrl.includes("mangacodex.com/anime/")) return "mangaCodexAnime";
    if (sourceUrl.includes("w.atwiki.jp/wallofmasterpieces")) return "animeAnnual";
    if (sourceUrl.includes("someanithing.com")) return "animeArchive";
    if (sourceUrl.includes("ja.wikipedia.org")) return "animeWiki";
  }
  if (medium === "manga") {
    if (sourceUrl.includes("mangacodex.com/manga/")) return "mangaCodexManga";
    if (sourceUrl.includes("/wiki/list_of_best-selling_manga")) return "manga";
    if (sourceUrl.includes("ja.wikipedia.org")) return "mangaWiki";
  }
  return null;
}

export function commercialFor(title, automaticCommercial, editorial, oldItem, sources = {}) {
  const fresh = automaticCommercial || editorialCommercialFor(title, editorial);
  if (fresh) return fresh;

  const previous = oldItem?.commercial || null;
  const sourceKey = commercialSourceKey(previous, title.medium);
  const source = sourceKey ? sources[sourceKey] : null;
  if (source?.status === "ok" && source.received > 0) return null;
  return previous;
}

export function bestMangaCommercial(...records) {
  return records
    .filter(Boolean)
    .sort((left, right) =>
      Number(Boolean(left.historyOnly)) - Number(Boolean(right.historyOnly)) ||
      (right.circulation || 0) - (left.circulation || 0)
    )[0] || null;
}

function coverOption(record, source) {
  if (!record?.cover) return null;
  return {
    url: record.cover,
    color: record.color || null,
    source: record.source || source || null,
  };
}

function coverFor(title, discovered, bySource, oldItem) {
  const candidates = [
    coverOption(discovered.assets.get(title.id), discovered.assets.get(title.id)?.source),
    coverOption(bySource.anilist.ratings.get(title.id), "anilist"),
    coverOption(bySource.mal.ratings.get(title.id), "mal"),
    coverOption(bySource.bangumi.ratings.get(title.id), "bangumi"),
  ].filter(Boolean);
  const oldRemoteUrl = oldItem?.cover?.remoteUrl ||
    (/^https?:\/\//i.test(oldItem?.cover?.url || "") ? oldItem.cover.url : null);
  if (oldRemoteUrl) {
    candidates.push({
      url: oldRemoteUrl,
      color: oldItem.cover.color || null,
      source: oldItem.cover.source || null,
    });
  }

  const unique = candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.url === candidate.url) === index,
  );
  if (unique.length === 0) return oldItem?.cover || null;
  return {
    url: unique[0].url,
    remoteUrl: unique[0].url,
    color: unique[0].color,
    source: unique[0].source,
    alternatives: unique,
  };
}

function newestTimestamp(values) {
  const timestamps = values.filter(Boolean).map((value) => Date.parse(value));
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function discoveryCache(catalog, previous) {
  return catalog.map((title) => {
    const scores = { ...(title.scores || {}) };
    const oldItem = previous.get(title.id);
    for (const source of sourceKeys) {
      const rating = oldItem?.ratings?.[source];
      if (Number.isFinite(rating?.normalized)) {
        scores[source] = rating.normalized;
      } else if (
        Number.isFinite(rating?.raw) &&
        Number.isFinite(rating?.scale) &&
        rating.scale > 0
      ) {
        scores[source] = (10 * rating.raw) / rating.scale;
      }
    }
    return { ...title, scores };
  });
}

export async function refreshData() {
  const [
    config,
    catalogConfig,
    editorial,
    oldAnime,
    oldManga,
    oldMetadata,
    oldCatalog,
  ] = await Promise.all([
    readJson("config/sources.json"),
    readJson("config/catalog.json"),
    readJson("data/editorial.json"),
    readJson("public/data/anime.json", []),
    readJson("public/data/manga.json", []),
    readJson("public/data/metadata.json", {}),
    readJson("public/data/catalog.json", []),
  ]);

  const previous = new Map(
    [...oldAnime, ...oldManga].map((item) => [item.id, item]),
  );
  const discovered = await discoverCatalog(
    catalogConfig,
    discoveryCache(oldCatalog, previous),
  );
  const titles = [...discovered.anime, ...discovered.manga];
  const pending = Object.fromEntries(
    sourceKeys.map((source) => [
      source,
      titles.filter(
        (title) =>
          title.ids[source] !== null &&
          !discovered.ratings[source].has(title.id),
      ),
    ]),
  );

  const [settled, commercialData] = await Promise.all([
    Promise.allSettled([
      fetchBangumi(pending.bangumi),
      fetchMal(pending.mal),
      fetchAniList(pending.anilist),
    ]),
    fetchCommercialData(titles),
  ]);
  const adapterKeys = ["bangumi", "mal", "anilist"];
  const results = settled.map((result, index) => {
    const adapter =
      result.status === "fulfilled"
        ? result.value
        : adapterFailure(adapterKeys[index], result.reason);
    return mergeSourceResult(adapterKeys[index], discovered, adapter);
  });
  const bySource = Object.fromEntries(results.map((result) => [result.key, result]));

  const generated = titles.map((title) => {
    const oldItem = previous.get(title.id);
    const rawRatings = {};

    for (const sourceKey of sourceKeys) {
      if (title.ids[sourceKey] === null) {
        rawRatings[sourceKey] = null;
        continue;
      }

      const fresh = bySource[sourceKey].ratings.get(title.id);
      if (fresh) {
        rawRatings[sourceKey] = fresh.rating;
      } else if (oldItem?.ratings?.[sourceKey]) {
        rawRatings[sourceKey] = { ...oldItem.ratings[sourceKey], stale: true };
      } else {
        rawRatings[sourceKey] = null;
      }
    }

    const calculated = calculateScore(rawRatings, title.medium, config);
    const wikiCommercial = title.wikidata?.id
      ? commercialData.byWikidata.get(title.wikidata.id)
      : null;
    const mangaCodexCommercial = commercialData.primaryByTitleId.get(title.id);
    const fallbackCommercial = commercialData.byTitleId.get(title.id);
    const automaticCommercial = title.medium === "manga"
      ? bestMangaCommercial(
        mangaCodexCommercial,
        wikiCommercial,
        fallbackCommercial,
      )
      : mangaCodexCommercial || wikiCommercial || fallbackCommercial || null;

    return {
      id: title.id,
      medium: title.medium,
      title: title.title,
      year: title.year,
      format: title.format,
      cover: coverFor(title, discovered, bySource, oldItem),
      ratings: calculated.ratings,
      score: calculated.score,
      commercial: commercialFor(
        title,
        automaticCommercial,
        editorial,
        oldItem,
        commercialData.sources,
      ),
    };
  });
  const inheritedEditions = inheritMangaEditions(generated, titles);

  const freshCount = results.reduce((total, result) => total + result.ratings.size, 0);
  if (freshCount === 0 && previous.size === 0) {
    throw new Error("Every rating source failed and there is no last-good data to deploy");
  }

  const coverStats = await cacheCoverAssets(generated);
  const generatedAt = new Date().toISOString();
  const metadata = {
    generatedAt,
    algorithmVersion: config.algorithmVersion,
    minimumSources: config.minimumSources,
    staleAfterDays: config.staleAfterDays,
    calibration: "identity-fallback",
    catalog: {
      limits: catalogConfig,
      received: { anime: discovered.anime.length, manga: discovered.manga.length },
      discoverySources: discovered.sources,
      discoveryErrors: discovered.errors.length,
      mappingsAdded: discovered.mapping,
    },
    commercial: {
      sources: commercialData.sources,
      inheritedEditions,
      coverage: {
        anime: generated.filter(
          (item) => item.medium === "anime" && item.commercial?.metric === "bd-dvd-average",
        ).length,
        manga: generated.filter(
          (item) => item.medium === "manga" && item.commercial?.metric === "circulation-per-volume",
        ).length,
      },
    },
    covers: coverStats,
    sources: Object.fromEntries(
      results.map((result) => {
        const freshTimes = [...result.ratings.values()].map(
          (item) => item.rating.fetchedAt,
        );
        return [
          result.key,
          {
            status: result.status,
            via: result.via,
            received: result.ratings.size,
            errors: result.errors.length,
            lastSuccessAt:
              newestTimestamp(freshTimes) ||
              oldMetadata.sources?.[result.key]?.lastSuccessAt ||
              null,
            message: result.errors[0]?.message || null,
          },
        ];
      }),
    ),
  };

  const sortByScore = (left, right) =>
    (right.score.value ?? -1) - (left.score.value ?? -1) ||
    left.title.zh.localeCompare(right.title.zh, "zh-CN");
  const anime = generated.filter((item) => item.medium === "anime").sort(sortByScore);
  const manga = generated.filter((item) => item.medium === "manga").sort(sortByScore);

  await Promise.all([
    writeJson("public/data/anime.json", anime),
    writeJson("public/data/manga.json", manga),
    writeJson("public/data/catalog.json", titles),
    writeJson("public/data/metadata.json", metadata),
  ]);

  return { anime: anime.length, manga: manga.length, freshCount, metadata };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = await refreshData();
  console.log(
    `Refreshed ${result.anime} anime and ${result.manga} manga (${result.freshCount} fresh source records).`,
  );
  for (const [source, status] of Object.entries(result.metadata.sources)) {
    console.log(`${source}: ${status.status}, ${status.received} records via ${status.via}`);
  }
}
