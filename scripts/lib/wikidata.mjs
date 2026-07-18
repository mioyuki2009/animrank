import { fetchJson } from "./http.mjs";

const ENDPOINT = "https://query.wikidata.org/sparql";
const PROPERTIES = {
  bangumi: "P5732",
  anime: { mal: "P4086", anilist: "P8729" },
  manga: { mal: "P4087", anilist: "P8731" },
};

function articleTitle(value) {
  if (!value) return null;
  try {
    const slug = new URL(value).pathname.split("/").pop();
    return decodeURIComponent(slug).replaceAll("_", " ");
  } catch {
    return null;
  }
}

function integerValue(binding) {
  const value = Number(binding?.value);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function addValue(target, key, value) {
  if (value !== null) target[key].add(value);
}

function mappingPairs(items, medium) {
  const pairs = [];
  for (const item of items) {
    if (Number.isInteger(item.ids?.bangumi)) {
      pairs.push(`(wdt:${PROPERTIES.bangumi} "${item.ids.bangumi}")`);
    }
    for (const source of ["mal", "anilist"]) {
      const id = item.ids?.[source];
      if (Number.isInteger(id)) {
        pairs.push(`(wdt:${PROPERTIES[medium][source]} "${id}")`);
      }
    }
  }
  return [...new Set(pairs)];
}

function buildQuery(items, medium) {
  const pairs = mappingPairs(items, medium);
  if (pairs.length === 0) return null;
  const malProperty = PROPERTIES[medium].mal;
  const aniListProperty = PROPERTIES[medium].anilist;

  return `
    SELECT DISTINCT ?item ?bangumi ?mal ?anilist ?jaArticle ?enArticle WHERE {
      VALUES (?knownProperty ?knownId) {
        ${pairs.join("\n        ")}
      }
      ?item ?knownProperty ?knownId.
      OPTIONAL { ?item wdt:${PROPERTIES.bangumi} ?bangumi. }
      OPTIONAL { ?item wdt:${malProperty} ?mal. }
      OPTIONAL { ?item wdt:${aniListProperty} ?anilist. }
      OPTIONAL {
        ?jaArticle schema:about ?item;
                   schema:isPartOf <https://ja.wikipedia.org/>.
      }
      OPTIONAL {
        ?enArticle schema:about ?item;
                   schema:isPartOf <https://en.wikipedia.org/>.
      }
    }
  `;
}

export async function fetchWikidataMappings(items, medium) {
  const query = buildQuery(items, medium);
  if (!query) return [];

  const body = new URLSearchParams({ query, format: "json" }).toString();
  const data = await fetchJson(ENDPOINT, {
    method: "POST",
    attempts: 2,
    timeoutMs: 25_000,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/sparql-results+json",
      "User-Agent": `FanRank/0.3 (${process.env.PROJECT_HOMEPAGE || "local-development"})`,
    },
    body,
  });

  const grouped = new Map();
  for (const row of data.results?.bindings || []) {
    const wikidataId = row.item?.value?.split("/").pop();
    if (!wikidataId) continue;
    if (!grouped.has(wikidataId)) {
      grouped.set(wikidataId, {
        wikidataId,
        ids: { bangumi: new Set(), mal: new Set(), anilist: new Set() },
        articles: { ja: null, en: null },
      });
    }
    const mapping = grouped.get(wikidataId);
    addValue(mapping.ids, "bangumi", integerValue(row.bangumi));
    addValue(mapping.ids, "mal", integerValue(row.mal));
    addValue(mapping.ids, "anilist", integerValue(row.anilist));
    mapping.articles.ja ||= articleTitle(row.jaArticle?.value);
    mapping.articles.en ||= articleTitle(row.enArticle?.value);
  }

  return [...grouped.values()].map((mapping) => ({
    ...mapping,
    ids: Object.fromEntries(
      Object.entries(mapping.ids).map(([source, values]) => [source, [...values]]),
    ),
  }));
}
