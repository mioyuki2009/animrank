import { delay, fetchJson } from "./http.mjs";

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const JIKAN_ENDPOINT = "https://api.jikan.moe/v4";
const BANGUMI_ENDPOINT = "https://api.bgm.tv/v0/subjects";
const PAGE_SIZE = 50;

const anilistQuery = `
  query CatalogBatch($page: Int!, $perPage: Int!, $type: MediaType!) {
    Page(page: $page, perPage: $perPage) {
      media(sort: SCORE_DESC, type: $type, isAdult: false) {
        id
        idMal
        format
        averageScore
        siteUrl
        title { romaji english native }
        synonyms
        startDate { year }
        coverImage { extraLarge large color }
        stats { scoreDistribution { amount } }
      }
    }
  }
`;

function yearOf(item) {
  const raw =
    item.startDate?.year ??
    item.year ??
    item.aired?.prop?.from?.year ??
    item.published?.prop?.from?.year ??
    item.aired?.from?.slice?.(0, 4) ??
    item.published?.from?.slice?.(0, 4) ??
    item.date?.slice?.(0, 4);
  const year = Number(raw);
  return Number.isInteger(year) && year > 1900 ? year : null;
}

function aliasesOf(item) {
  return [
    item.title?.romaji,
    item.title?.english,
    item.title?.native,
    item.title_english,
    item.title_japanese,
    item.title,
    item.name_cn,
    item.name,
    ...(Array.isArray(item.synonyms) ? item.synonyms : []),
    ...(Array.isArray(item.titles) ? item.titles.map((title) => title?.title) : []),
  ].filter((value) => typeof value === "string" && value.trim());
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function displayTitle(item) {
  const aliases = aliasesOf(item);
  return item.name_cn || item.title?.english || item.title_english || item.title?.romaji ||
    item.title || item.name || aliases[0] || "未命名作品";
}

function formatOf(item, medium) {
  return item.format ||
    (typeof item.type === "string" ? item.type : null) ||
    item.platform ||
    (medium === "anime" ? "TV" : "MANGA");
}

function normalizedFormat(value) {
  return String(value || "")
    .trim()
    .toLocaleUpperCase("en-US")
    .replace(/[\s-]+/g, "_");
}

function isAllowedFormat(medium, format) {
  const normalized = normalizedFormat(format);
  if (medium === "manga") {
    return !["NOVEL", "LIGHT_NOVEL", "小说", "轻小说", "ライトノベル"].includes(normalized);
  }
  return !["MUSIC", "CM", "PV"].includes(normalized);
}

function asset(source, raw, votes, url, cover, color, via) {
  if (!Number.isFinite(raw) || !Number.isFinite(votes) || votes <= 0) return null;
  return {
    rating: {
      raw,
      scale: source === "anilist" ? 100 : 10,
      votes,
      url,
      fetchedAt: new Date().toISOString(),
      via,
      stale: false,
    },
    cover: cover || null,
    color: color || null,
  };
}

function candidate(medium, source, item) {
  const year = yearOf(item);
  const aliases = aliasesOf(item);
  if (!year || aliases.length === 0) return null;

  const format = formatOf(item, medium);
  if (!isAllowedFormat(medium, format)) return null;

  const ids = {
    bangumi: source === "bangumi" && Number.isInteger(item.id) ? item.id : null,
    mal: source === "mal" && Number.isInteger(item.mal_id) ? item.mal_id :
      source === "anilist" && Number.isInteger(item.idMal) ? item.idMal : null,
    anilist: source === "anilist" && Number.isInteger(item.id) ? item.id : null,
  };
  if (!Object.values(ids).some(Boolean)) return null;

  const sourceAsset =
    source === "anilist"
      ? asset(
          source,
          item.averageScore,
          (item.stats?.scoreDistribution || []).reduce((sum, bucket) => sum + (bucket.amount || 0), 0),
          item.siteUrl || `https://anilist.co/${medium}/${item.id}`,
          item.coverImage?.extraLarge || item.coverImage?.large,
          item.coverImage?.color,
          "AniList GraphQL API",
        )
      : source === "mal"
        ? asset(
            source,
            item.score,
            item.scored_by,
            item.url || `https://myanimelist.net/${medium}/${item.mal_id}`,
            item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url,
            null,
            "Jikan (MAL mirror)",
          )
        : asset(
            source,
            item.rating?.score,
            item.rating?.total,
            `https://bgm.tv/subject/${item.id}`,
            item.images?.large || item.images?.common,
            null,
            "Bangumi API v0",
          );

  return {
    id: `${medium}:${source}-${source === "anilist" ? item.id : source === "mal" ? item.mal_id : item.id}`,
    medium,
    title: { zh: displayTitle(item), original: item.title?.native || item.title_japanese || item.name || aliases[0] },
    year,
    format: formatOf(item, medium),
    ids,
    aliases,
    assets: { [source]: sourceAsset },
    scores: {
      [source]: source === "anilist" ? (Number.isFinite(item.averageScore) ? item.averageScore / 10 : null) :
        source === "mal" ? item.score : item.rating?.score,
    },
    source,
  };
}

function merge(target, incoming) {
  const idKeys = ["bangumi", "mal", "anilist"];
  const aliases = new Set((incoming.aliases || []).map(normalize).filter(Boolean));
  const existing = target.find((item) =>
    idKeys.some((key) => incoming.ids[key] && item.ids[key] === incoming.ids[key]) ||
    (
      (!item.year || !incoming.year || Math.abs(item.year - incoming.year) <= 1) &&
      (item.aliases || []).some((known) => aliases.has(normalize(known)))
    ),
  );

  if (!existing) {
    target.push(incoming);
    return incoming;
  }

  for (const key of idKeys) {
    if (!existing.ids[key] && incoming.ids[key]) existing.ids[key] = incoming.ids[key];
  }
  existing.aliases = [...new Set([...(existing.aliases || []), ...(incoming.aliases || [])])];
  existing.assets = { ...existing.assets, ...incoming.assets };
  existing.scores = { ...existing.scores, ...incoming.scores };
  if (incoming.title?.zh && (!existing.title?.zh || existing.title.zh === existing.title.original)) {
    existing.title.zh = incoming.title.zh;
  }
  if (incoming.source === "bangumi") {
    existing.title.zh = incoming.title.zh;
  }
  return existing;
}

function cachedCandidate(item) {
  const format = formatOf(item, item.medium);
  if (!isAllowedFormat(item.medium, format)) return null;

  return {
    ...item,
    ids: {
      bangumi: item.ids?.bangumi ?? null,
      mal: item.ids?.mal ?? null,
      anilist: item.ids?.anilist ?? null,
    },
    aliases: [item.title?.zh, item.title?.original].filter(Boolean),
    assets: {},
    scores: {},
    source: "cache",
  };
}

async function fetchAniList(type, count) {
  const pages = Math.ceil(count / PAGE_SIZE);
  const records = [];
  const errors = [];
  for (let page = 1; page <= pages; page += 1) {
    try {
      const data = await fetchJson(ANILIST_ENDPOINT, {
        attempts: 2,
        timeoutMs: 20_000,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: anilistQuery,
          variables: { page, perPage: PAGE_SIZE, type },
        }),
      });
      if (data.errors?.length) {
        throw new Error(data.errors.map((error) => error.message).join("; "));
      }
      const pageRecords = data.data?.Page?.media || [];
      records.push(...pageRecords);
      if (pageRecords.length < PAGE_SIZE) break;
    } catch (error) {
      errors.push({ page, message: error.message });
      break;
    }
  }
  return { records: records.slice(0, count), errors };
}

async function fetchJikan(type, count) {
  const kind = type === "ANIME" ? "anime" : "manga";
  const pages = Math.ceil(count / 25);
  const records = [];
  const errors = [];
  for (let page = 1; page <= pages; page += 1) {
    try {
      if (page > 1) await delay(450);
      const data = await fetchJson(`${JIKAN_ENDPOINT}/top/${kind}?limit=25&page=${page}`, {
        attempts: 2,
        timeoutMs: 20_000,
      });
      records.push(...(data.data || []));
      if (!data.pagination?.has_next_page) break;
    } catch (error) {
      errors.push({ page, message: error.message });
      break;
    }
  }
  return { records: records.slice(0, count), errors };
}

async function fetchBangumi(type, count) {
  const subjectType = type === "ANIME" ? 2 : 1;
  const records = [];
  const errors = [];
  const pageSize = Math.min(count, 100);

  for (let offset = 0; offset < count; offset += pageSize) {
    const limit = Math.min(pageSize, count - offset);
    try {
      if (offset > 0) await delay(250);
      const data = await fetchJson(
        `${BANGUMI_ENDPOINT}?type=${subjectType}&sort=rank&limit=${limit}&offset=${offset}`,
        {
          attempts: 2,
          timeoutMs: 20_000,
          headers: {
            "User-Agent": `FanRank/0.2 (${process.env.PROJECT_HOMEPAGE || "local-development"})`,
            Accept: "application/json",
          },
        },
      );
      const pageRecords = data.data || [];
      records.push(...pageRecords);
      if (pageRecords.length < limit) break;
    } catch (error) {
      errors.push({ page: Math.floor(offset / pageSize) + 1, message: error.message });
      break;
    }
  }

  return { records: records.slice(0, count), errors };
}

function rankingScore(item) {
  const values = Object.values(item.scores).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clean(item) {
  const { aliases, assets, scores, source, ...publicItem } = item;
  return publicItem;
}

/**
 * Discover the catalog during refresh. The only local input is the maximum
 * count per medium; all metadata and IDs come from the public datasets.
 */
export async function discoverCatalog(limits, previous = []) {
  const result = {
    anime: [],
    manga: [],
    ratings: { bangumi: new Map(), mal: new Map(), anilist: new Map() },
    sources: {},
    errors: [],
  };

  for (const [medium, type] of [["anime", "ANIME"], ["manga", "MANGA"]]) {
    const limit = Math.max(1, Math.floor(limits[medium] || 0));
    const pool = limit + Math.ceil(limit / 2);
    const candidates = [];

    // Seed with the last-good catalog so matching API records retain a stable
    // public ID and all previously known platform IDs.
    for (const old of previous.filter((item) => item.medium === medium)) {
      const cached = cachedCandidate(old);
      if (cached) merge(candidates, cached);
    }

    const calls = await Promise.allSettled([
      fetchAniList(type, pool),
      fetchJikan(type, pool),
      fetchBangumi(type, pool),
    ]);
    const sources = ["anilist", "mal", "bangumi"];

    for (let index = 0; index < calls.length; index += 1) {
      const outcome = calls[index];
      const source = sources[index];
      if (outcome.status === "rejected") {
        result.sources[`${medium}:${source}`] = "error";
        result.errors.push({ medium, source, message: outcome.reason?.message || String(outcome.reason) });
        continue;
      }

      const { records, errors } = outcome.value;
      result.sources[`${medium}:${source}`] =
        errors.length === 0 ? "ok" : records.length > 0 ? "partial" : "error";
      for (const error of errors) {
        result.errors.push({
          medium,
          source,
          message: `page ${error.page}: ${error.message}`,
        });
      }
      for (const raw of records) {
        const item = candidate(medium, source, raw);
        if (item) merge(candidates, item);
      }
    }

    candidates.sort((left, right) => {
      const leftCoverage = Object.values(left.ids).filter(Boolean).length;
      const rightCoverage = Object.values(right.ids).filter(Boolean).length;
      return rankingScore(right) - rankingScore(left) || rightCoverage - leftCoverage ||
        left.title.zh.localeCompare(right.title.zh, "zh-CN");
    });

    const selected = candidates.slice(0, limit);
    if (selected.length < limit) {
      throw new Error(
        `${medium} discovery produced ${selected.length} of ${limit} configured entries`,
      );
    }
    result[medium] = selected.map(clean);
    for (const item of selected) {
      const sourceAssets = candidates.find((candidateItem) => candidateItem.id === item.id)?.assets || {};
      for (const [source, record] of Object.entries(sourceAssets)) {
        if (record) result.ratings[source].set(item.id, record);
      }
    }
  }
  return result;
}
