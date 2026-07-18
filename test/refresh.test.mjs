import assert from "node:assert/strict";
import test from "node:test";
import {
  bestMangaCommercial,
  commercialFor,
} from "../scripts/refresh-data.mjs";

const title = {
  id: "anime:split-part",
  medium: "anime",
};
const previousAnnual = {
  commercial: {
    metric: "bd-dvd-average",
    unitsPerVolume: 3_905,
    sourceUrl:
      "https://web.archive.org/web/20260203074932id_/https://w.atwiki.jp/wallofmasterpieces/pages/21.html",
    sourceLabel: "ATWiki 年度销量榜（Internet Archive）",
  },
};

test("commercial fallback removes an old miss after its source refreshed successfully", () => {
  assert.equal(commercialFor(
    title,
    null,
    { anime: {}, manga: {} },
    previousAnnual,
    { animeAnnual: { status: "ok", received: 8 } },
  ), null);
});

test("commercial fallback retains the last good value when its source failed", () => {
  assert.equal(commercialFor(
    title,
    null,
    { anime: {}, manga: {} },
    previousAnnual,
    { animeAnnual: { status: "error", received: 0 } },
  ), previousAnnual.commercial);
});

test("commercial fallback does not discard an unclassified reviewed record", () => {
  const reviewed = {
    commercial: {
      ...previousAnnual.commercial,
      sourceUrl: "https://example.test/reviewed-source",
    },
  };
  assert.equal(commercialFor(
    title,
    null,
    { anime: {}, manga: {} },
    reviewed,
    { animeAnnual: { status: "ok", received: 8 } },
  ), reviewed.commercial);
});

test("manga source selection keeps the largest cumulative statement and Manga Codex on ties", () => {
  const mangaCodex = {
    circulation: 7_200_000,
    volumesAtAnnouncement: 9,
    asOf: "2026-07-18",
    sourceLabel: "Manga Codex",
  };
  const newerStatement = {
    circulation: 35_000_000,
    volumesAtAnnouncement: 15,
    asOf: "2026-07-11",
    sourceLabel: "Wikipedia",
  };
  assert.equal(
    bestMangaCommercial(mangaCodex, newerStatement),
    newerStatement,
  );
  assert.equal(
    bestMangaCommercial(
      { ...mangaCodex, circulation: 35_000_000 },
      newerStatement,
  ).sourceLabel,
    "Manga Codex",
  );
});

test("manga source selection prefers a series total over a per-volume history estimate", () => {
  const historyEstimate = {
    historyOnly: true,
    circulation: 90_000_000,
    volumesAtAnnouncement: 20,
    sourceLabel: "Manga Codex history",
  };
  const seriesTotal = {
    circulation: 12_000_000,
    volumesAtAnnouncement: 12,
    sourceLabel: "Wikipedia series total",
  };

  assert.equal(bestMangaCommercial(historyEstimate, seriesTotal), seriesTotal);
});
