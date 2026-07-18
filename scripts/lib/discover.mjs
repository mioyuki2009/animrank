import { delay, fetchJson } from "./http.mjs";
import { fetchWikidataMappings } from "./wikidata.mjs";

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const JIKAN_ENDPOINT = "https://api.jikan.moe/v4";
const BANGUMI_ENDPOINT = "https://api.bgm.tv/v0/subjects";
const BANGUMI_SEARCH_ENDPOINT = "https://api.bgm.tv/v0/search/subjects";
const PAGE_SIZE = 50;

const anilistQuery = `
  query CatalogBatch($page: Int!, $perPage: Int!, $type: MediaType!) {
    Page(page: $page, perPage: $perPage) {
      media(sort: SCORE_DESC, type: $type, isAdult: false) {
        id
        idMal
        format
        status
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

const anilistResolutionFields = `
  id
  idMal
  format
  status
  averageScore
  siteUrl
  title { romaji english native }
  synonyms
  startDate { year }
  coverImage { extraLarge large color }
  stats { scoreDistribution { amount } }
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
    return ![
      "NOVEL",
      "LIGHT_NOVEL",
      "小说",
      "轻小说",
      "ライトノベル",
      "ART_BOOK",
      "ARTBOOK",
      "画集",
      "插画集",
      "イラスト集",
    ].includes(normalized);
  }
  return !["MUSIC", "CM", "PV"].includes(normalized);
}

function isReleased(item) {
  if (["NOT_YET_RELEASED", "Not yet aired", "Not yet published"].includes(item.status)) {
    return false;
  }
  const rawDate = item.date || item.aired?.from || item.published?.from;
  const timestamp = rawDate ? Date.parse(rawDate) : NaN;
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function isDiscoveryEligible(item, medium, source) {
  if (!isReleased(item)) return false;
  if (medium === "manga" && source === "bangumi" && item.series === false) return false;
  const votes = item.assets[source]?.rating?.votes;
  if (!Number.isFinite(votes)) return true;
  const minimum = {
    anime: { anilist: 500, mal: 1000, bangumi: 100 },
    manga: { anilist: 100, mal: 500, bangumi: 50 },
  };
  return votes >= minimum[medium][source];
}

function asset(source, raw, votes, url, cover, color, via) {
  const hasRating = Number.isFinite(raw) && Number.isFinite(votes) && votes > 0;
  if (!hasRating && !cover) return null;
  return {
    rating: hasRating
      ? {
          raw,
          scale: source === "anilist" ? 100 : 10,
          votes,
          url,
          fetchedAt: new Date().toISOString(),
          via,
          stale: false,
        }
      : null,
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
          item.coverImage?.large || item.coverImage?.extraLarge,
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
    series: medium === "manga" && source === "bangumi"
      ? item.series ?? null
      : null,
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
  if (incoming.series !== null && incoming.series !== undefined) {
    existing.series = incoming.series;
  }
  existing.wikidata ||= incoming.wikidata || null;
  if (incoming.title?.zh && (!existing.title?.zh || existing.title.zh === existing.title.original)) {
    existing.title.zh = incoming.title.zh;
  }
  if (incoming.source === "bangumi") {
    existing.title.zh = incoming.title.zh;
  }
  return existing;
}

function consolidate(candidates) {
  const consolidated = [];
  for (const item of candidates) merge(consolidated, item);
  candidates.splice(0, candidates.length, ...consolidated);
}

function removeMatchingCandidate(candidates, incoming) {
  const index = candidates.findIndex((item) =>
    ["bangumi", "mal", "anilist"].some(
      (source) => incoming.ids[source] && item.ids[source] === incoming.ids[source],
    ),
  );
  if (index >= 0) candidates.splice(index, 1);
}

function mappingMatches(item, mapping) {
  return ["bangumi", "mal", "anilist"].some(
    (source) => item.ids[source] && mapping.ids[source].includes(item.ids[source]),
  );
}

function applyWikidataMappings(candidates, mappings) {
  let enriched = 0;
  for (const mapping of mappings) {
    const matches = candidates.filter((item) => mappingMatches(item, mapping));
    if (matches.length === 0) continue;
    for (const item of matches) {
      for (const source of ["bangumi", "mal", "anilist"]) {
        if (!item.ids[source] && mapping.ids[source].length === 1) {
          item.ids[source] = mapping.ids[source][0];
          enriched += 1;
        }
      }
      item.wikidata = {
        id: mapping.wikidataId,
        articles: mapping.articles,
      };
    }
  }
  consolidate(candidates);
  return enriched;
}

function bigrams(value) {
  const characters = Array.from(value);
  if (characters.length < 2) return characters;
  return characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
}

function diceSimilarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 5) return 0;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);

  const counts = new Map();
  for (const pair of bigrams(b)) counts.set(pair, (counts.get(pair) || 0) + 1);
  let overlap = 0;
  const leftPairs = bigrams(a);
  for (const pair of leftPairs) {
    const count = counts.get(pair) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (leftPairs.length + bigrams(b).length);
}

function formatGroup(value) {
  const normalized = normalizedFormat(value);
  if (/MOVIE|FILM|剧场|劇場|映画/.test(normalized)) return "MOVIE";
  if (/OVA|OAD/.test(normalized)) return "OVA";
  if (/ONA|WEB/.test(normalized)) return "ONA";
  if (/TV/.test(normalized)) return "TV";
  if (/MANGA|漫画/.test(normalized)) return "MANGA";
  return null;
}

function matchScore(left, right) {
  if (left.year && right.year && Math.abs(left.year - right.year) > 1) return 0;
  const leftFormat = formatGroup(left.format);
  const rightFormat = formatGroup(right.format);
  if (leftFormat && rightFormat && leftFormat !== rightFormat) return 0;

  let titleScore = 0;
  for (const leftAlias of left.aliases || []) {
    for (const rightAlias of right.aliases || []) {
      titleScore = Math.max(titleScore, diceSimilarity(leftAlias, rightAlias));
    }
  }
  const yearBonus = left.year && right.year
    ? left.year === right.year ? 0.14 : 0.05
    : 0;
  const formatBonus = leftFormat && rightFormat ? 0.08 : 0;
  return Math.min(1, titleScore * 0.78 + yearBonus + formatBonus);
}

function searchTitle(item) {
  return item.title?.original || item.aliases?.[0] || item.title?.zh;
}

function cachedCandidate(item) {
  const format = formatOf(item, item.medium);
  if (!isAllowedFormat(item.medium, format)) return null;
  if (item.medium === "manga" && item.series === false) return null;

  return {
    ...item,
    ids: {
      bangumi: item.ids?.bangumi ?? null,
      mal: item.ids?.mal ?? null,
      anilist: item.ids?.anilist ?? null,
    },
    aliases: [...new Set([
      ...(item.aliases || []),
      item.title?.zh,
      item.title?.original,
    ].filter(Boolean))],
    assets: {},
    scores: { ...(item.scores || {}) },
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

async function resolveAniList(candidates, shortlist, medium) {
  const unresolved = shortlist.filter(
    (item) => !item.ids.anilist && (item.ids.mal || searchTitle(item)),
  );
  const errors = [];
  let resolved = 0;
  const mediaType = medium === "anime" ? "ANIME" : "MANGA";

  for (let offset = 0; offset < unresolved.length; offset += 20) {
    const batch = unresolved.slice(offset, offset + 20);
    const definitions = [];
    const fields = [];
    const variables = {};
    const requests = [];

    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const key = `m${index}`;
      if (item.ids.mal) {
        definitions.push(`$id${index}: Int`);
        variables[`id${index}`] = item.ids.mal;
        fields.push(`${key}: Media(idMal: $id${index}, type: ${mediaType}) { ${anilistResolutionFields} }`);
        requests.push({ item, key, direct: true });
      } else {
        definitions.push(`$search${index}: String`);
        variables[`search${index}`] = searchTitle(item);
        fields.push(`${key}: Media(search: $search${index}, type: ${mediaType}) { ${anilistResolutionFields} }`);
        requests.push({ item, key, direct: false });
      }
    }

    try {
      const data = await fetchJson(ANILIST_ENDPOINT, {
        method: "POST",
        attempts: 2,
        timeoutMs: 20_000,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `query Resolve(${definitions.join(", ")}) { ${fields.join("\n")} }`,
          variables,
        }),
      });
      if (data.errors?.length) {
        throw new Error(data.errors.map((error) => error.message).join("; "));
      }

      for (const request of requests) {
        const raw = data.data?.[request.key];
        if (!raw) continue;
        const incoming = candidate(medium, "anilist", raw);
        if (!incoming) continue;
        if (!request.direct && matchScore(request.item, incoming) < 0.82) continue;
        merge(candidates, incoming);
        resolved += 1;
      }
    } catch (error) {
      errors.push({ message: error.message });
    }
  }

  consolidate(candidates);
  return { resolved, errors };
}

async function resolveBangumi(candidates, shortlist, medium) {
  const unresolved = shortlist.filter((item) => !item.ids.bangumi && searchTitle(item));
  const errors = [];
  let resolved = 0;
  const subjectType = medium === "anime" ? 2 : 1;
  const homepage = process.env.PROJECT_HOMEPAGE || "local-development";

  for (let index = 0; index < unresolved.length; index += 1) {
    const item = unresolved[index];
    try {
      const data = await fetchJson(`${BANGUMI_SEARCH_ENDPOINT}?limit=5&offset=0`, {
        method: "POST",
        attempts: 2,
        timeoutMs: 15_000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": `FanRank/0.3 (${homepage})`,
        },
        body: JSON.stringify({
          keyword: searchTitle(item),
          sort: "match",
          filter: { type: [subjectType] },
        }),
      });
      const ranked = (data.data || [])
        .map((raw) => candidate(medium, "bangumi", raw))
        .filter(Boolean)
        .map((incoming) => ({ incoming, score: matchScore(item, incoming) }))
        .sort((left, right) => right.score - left.score);
      if (ranked[0]?.score >= 0.82) {
        merge(candidates, ranked[0].incoming);
        resolved += 1;
      }
    } catch (error) {
      errors.push({ message: error.message });
      if (!error.status || [401, 403, 429].includes(error.status) || error.status >= 500) break;
    }
    if (index < unresolved.length - 1) await delay(250);
  }

  consolidate(candidates);
  return { resolved, errors };
}

function sortCandidates(candidates) {
  candidates.sort((left, right) => {
    const leftCoverage = Object.values(left.ids).filter(Boolean).length;
    const rightCoverage = Object.values(right.ids).filter(Boolean).length;
    return rankingScore(right) - rankingScore(left) || rightCoverage - leftCoverage ||
      left.title.zh.localeCompare(right.title.zh, "zh-CN");
  });
}

function rankingScore(item) {
  const values = Object.values(item.scores).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clean(item) {
  const { assets, source, ...publicItem } = item;
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
    assets: new Map(),
    mapping: { wikidata: 0, anilist: 0, bangumi: 0 },
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
        if (!item) continue;
        const invalidWork = !isReleased(raw) ||
          (medium === "manga" && source === "bangumi" && raw.series === false);
        if (invalidWork) {
          removeMatchingCandidate(candidates, item);
        } else if (isDiscoveryEligible(item, medium, source)) {
          merge(candidates, item);
        }
      }
    }

    try {
      const mappings = await fetchWikidataMappings(candidates, medium);
      result.mapping.wikidata += applyWikidataMappings(candidates, mappings);
      result.sources[`${medium}:wikidata`] = "ok";
    } catch (error) {
      result.sources[`${medium}:wikidata`] = "error";
      result.errors.push({ medium, source: "wikidata", message: error.message });
    }

    sortCandidates(candidates);
    const shortlist = candidates.slice(0, pool);
    const aniListResolution = await resolveAniList(candidates, shortlist, medium);
    result.mapping.anilist += aniListResolution.resolved;
    result.sources[`${medium}:anilist-resolver`] =
      aniListResolution.errors.length === 0 ? "ok" : aniListResolution.resolved > 0 ? "partial" : "error";
    for (const error of aniListResolution.errors) {
      result.errors.push({ medium, source: "anilist-resolver", message: error.message });
    }

    sortCandidates(candidates);
    const bangumiResolution = await resolveBangumi(candidates, candidates.slice(0, pool), medium);
    result.mapping.bangumi += bangumiResolution.resolved;
    result.sources[`${medium}:bangumi-resolver`] =
      bangumiResolution.errors.length === 0 ? "ok" : bangumiResolution.resolved > 0 ? "partial" : "error";
    for (const error of bangumiResolution.errors) {
      result.errors.push({ medium, source: "bangumi-resolver", message: error.message });
    }

    sortCandidates(candidates);

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
        if (record?.rating) result.ratings[source].set(item.id, record);
      }
      for (const source of ["anilist", "mal", "bangumi"]) {
        const record = sourceAssets[source];
        if (!record?.cover) continue;
        result.assets.set(item.id, { ...record, source });
        break;
      }
    }
  }
  return result;
}
