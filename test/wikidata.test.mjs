import assert from "node:assert/strict";
import test from "node:test";
import { fetchWikidataMappings } from "../scripts/lib/wikidata.mjs";

test("Wikidata maps Bangumi, MAL and AniList IDs without title guessing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.match(options.body, /P5732/);
    assert.match(options.body, /P4086/);
    assert.match(options.body, /P8729/);
    return new Response(JSON.stringify({
      results: {
        bindings: [{
          item: { value: "http://www.wikidata.org/entity/Q123" },
          bangumi: { value: "42" },
          mal: { value: "5114" },
          anilist: { value: "5114" },
          jaArticle: { value: "https://ja.wikipedia.org/wiki/Example_anime" },
          enArticle: { value: "https://en.wikipedia.org/wiki/Example_anime" },
        }],
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const [mapping] = await fetchWikidataMappings([{
      ids: { bangumi: null, mal: 5114, anilist: null },
    }], "anime");
    assert.equal(mapping.wikidataId, "Q123");
    assert.deepEqual(mapping.ids, { bangumi: [42], mal: [5114], anilist: [5114] });
    assert.deepEqual(mapping.articles, { ja: "Example anime", en: "Example anime" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
