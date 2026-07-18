import assert from "node:assert/strict";
import test from "node:test";
import { discoverCatalog } from "../scripts/lib/discover.mjs";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cachedTitle(medium, suffix, ids, format = medium === "anime" ? "TV" : "MANGA") {
  return {
    id: `${medium}:cached-${suffix}`,
    medium,
    title: { zh: `Cached ${suffix}`, original: `Cached ${suffix}` },
    year: 2020,
    format,
    ids: {
      bangumi: ids.bangumi ?? null,
      mal: ids.mal ?? null,
      anilist: ids.anilist ?? null,
    },
  };
}

function jikanRecord(kind, id, title) {
  const record = {
    mal_id: id,
    title,
    title_english: title,
    title_japanese: title,
    type: kind === "anime" ? "TV" : "Manga",
    score: 8.5,
    scored_by: 1000,
    url: `https://myanimelist.net/${kind}/${id}`,
    images: {},
  };
  if (kind === "anime") record.aired = { prop: { from: { year: 2020 } } };
  else record.published = { prop: { from: { year: 2020 } } };
  return record;
}

test("last-good IDs stay stable when one discovery source fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://query.wikidata.org/sparql") {
      return jsonResponse({ results: { bindings: [] } });
    }
    if (target.startsWith("https://api.bgm.tv/v0/search/subjects?")) {
      return new Response("resolver disabled in this test", { status: 401 });
    }
    if (target === "https://graphql.anilist.co") {
      return jsonResponse({ errors: [{ message: "temporary AniList outage" }] });
    }
    if (target.includes("/top/anime")) {
      return jsonResponse({
        data: [jikanRecord("anime", 11, "Cached anime")],
        pagination: { has_next_page: false },
      });
    }
    if (target.includes("/top/manga")) {
      return jsonResponse({
        data: [jikanRecord("manga", 22, "Cached manga")],
        pagination: { has_next_page: false },
      });
    }
    if (target.includes("api.bgm.tv/v0/subjects?type=1")) {
      return jsonResponse({
        data: [{
          id: 999,
          type: 1,
          platform: "小说",
          date: "2020-01-01",
          name: "Filtered novel",
          rating: { score: 9.9, total: 1000 },
        }],
      });
    }
    if (target.startsWith("https://api.bgm.tv/v0/subjects?")) {
      return jsonResponse({ data: [] });
    }
    throw new Error(`Unexpected request: ${target} ${options.method || "GET"}`);
  };

  const previous = [
    cachedTitle("anime", "anime", { mal: 11, anilist: 111 }),
    cachedTitle("manga", "manga", { mal: 22, anilist: 222 }),
  ];

  try {
    const result = await discoverCatalog({ anime: 1, manga: 1 }, previous);
    assert.equal(result.anime[0].id, "anime:cached-anime");
    assert.equal(result.anime[0].ids.anilist, 111);
    assert.equal(result.manga[0].id, "manga:cached-manga");
    assert.equal(result.manga[0].ids.anilist, 222);
    assert.equal(result.sources["anime:anilist"], "error");
    assert.equal(result.ratings.mal.has("anime:cached-anime"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("later page failures keep earlier discovery records", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://query.wikidata.org/sparql") {
      return jsonResponse({ results: { bindings: [] } });
    }
    if (target.startsWith("https://api.bgm.tv/v0/search/subjects?")) {
      return new Response("resolver disabled in this test", { status: 401 });
    }
    if (target === "https://graphql.anilist.co") {
      const request = JSON.parse(options.body);
      if (!request.query.includes("CatalogBatch")) {
        return jsonResponse({ data: {} });
      }
      const variables = request.variables;
      if (variables.type === "ANIME" && variables.page === 2) {
        return jsonResponse({ errors: [{ message: "second page failed" }] });
      }

      const count = variables.type === "ANIME" ? 50 : 1;
      const start = variables.type === "ANIME" ? 1 : 1001;
      return jsonResponse({
        data: {
          Page: {
            media: Array.from({ length: count }, (_, index) => {
              const id = start + index;
              return {
                id,
                idMal: null,
                format: variables.type === "ANIME" ? "TV" : "MANGA",
                averageScore: 99 - index / 10,
                siteUrl: `https://anilist.co/${variables.type === "ANIME" ? "anime" : "manga"}/${id}`,
                title: { romaji: `Title ${id}`, english: null, native: `Title ${id}` },
                synonyms: [],
                startDate: { year: 2020 },
                coverImage: {},
                stats: { scoreDistribution: [{ amount: 1000 }] },
              };
            }),
          },
        },
      });
    }
    if (target.includes("api.jikan.moe/v4/top/")) {
      return jsonResponse({ data: [], pagination: { has_next_page: false } });
    }
    if (target.startsWith("https://api.bgm.tv/v0/subjects?")) {
      return jsonResponse({ data: [] });
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  const previous = [
    ...Array.from({ length: 34 }, (_, index) =>
      cachedTitle("anime", index + 1, { anilist: index + 1 }),
    ),
    cachedTitle("manga", "one", { anilist: 1001 }),
  ];

  try {
    const result = await discoverCatalog({ anime: 34, manga: 1 }, previous);
    assert.equal(result.anime.length, 34);
    assert.equal(result.sources["anime:anilist"], "partial");
    assert.equal(result.ratings.anilist.size, 35);
    assert.ok(result.errors.some((error) => error.message.includes("second page failed")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
