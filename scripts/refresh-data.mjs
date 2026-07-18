import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAniList } from "./lib/adapters/anilist.mjs";
import { fetchBangumi } from "./lib/adapters/bangumi.mjs";
import { fetchMal } from "./lib/adapters/mal.mjs";
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

function commercialFor(title, editorial) {
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

function newestTimestamp(values) {
  const timestamps = values.filter(Boolean).map((value) => Date.parse(value));
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
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
  const discovered = await discoverCatalog(catalogConfig, oldCatalog);
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

  const settled = await Promise.allSettled([
    fetchBangumi(pending.bangumi),
    fetchMal(pending.mal),
    fetchAniList(pending.anilist),
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
    const freshAssets = [];

    for (const sourceKey of sourceKeys) {
      if (title.ids[sourceKey] === null) {
        rawRatings[sourceKey] = null;
        continue;
      }

      const fresh = bySource[sourceKey].ratings.get(title.id);
      if (fresh) {
        rawRatings[sourceKey] = fresh.rating;
        freshAssets.push(fresh);
      } else if (oldItem?.ratings?.[sourceKey]) {
        rawRatings[sourceKey] = { ...oldItem.ratings[sourceKey], stale: true };
      } else {
        rawRatings[sourceKey] = null;
      }
    }

    const calculated = calculateScore(rawRatings, title.medium, config);
    const aniListAsset = bySource.anilist.ratings.get(title.id);
    const malAsset = bySource.mal.ratings.get(title.id);
    const bangumiAsset = bySource.bangumi.ratings.get(title.id);
    const selectedAsset = aniListAsset || malAsset || bangumiAsset || freshAssets[0];
    const cover = selectedAsset?.cover
      ? {
          url: selectedAsset.cover,
          color: selectedAsset.color || oldItem?.cover?.color || null,
          source: aniListAsset ? "anilist" : malAsset ? "mal" : "bangumi",
        }
      : oldItem?.cover || null;

    return {
      id: title.id,
      medium: title.medium,
      title: title.title,
      year: title.year,
      format: title.format,
      cover,
      ratings: calculated.ratings,
      score: calculated.score,
      commercial: commercialFor(title, editorial) || oldItem?.commercial || null,
    };
  });

  const freshCount = results.reduce((total, result) => total + result.ratings.size, 0);
  if (freshCount === 0 && previous.size === 0) {
    throw new Error("Every rating source failed and there is no last-good data to deploy");
  }

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
    },
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
