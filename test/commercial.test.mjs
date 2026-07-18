import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDiscSales,
  extractMangaCirculation,
  inheritMangaEditions,
  matchAnimeArchive,
  mergeCommercialMaps,
  parseAnimeArchive,
  parseAnimeAnnual,
  parseMangaRows,
} from "../scripts/lib/commercial.mjs";

test("manga tables tolerate MediaWiki headers with collapsed whitespace", () => {
  const html = `
    <table class="wikitable">
      <tr>
        <th>Manga series</th>
        <th>No. of collected<span>volumes</span></th>
        <th>Approximate<span>sales</span></th>
      </tr>
      <tr>
        <td><a title="Example manga">Example</a></td>
        <td>25</td>
        <td data-sort-value="50000">50 million†‡</td>
      </tr>
    </table>`;
  const [row] = parseMangaRows(html, "2026-07-18");
  assert.equal(row.pageTitle, "Example manga");
  assert.equal(row.commercial.circulation, 50_000_000);
  assert.equal(row.commercial.perVolume, 2_000_000);
  assert.equal(row.commercial.includesDigital, true);
});

test("manga editions inherit a uniquely matched original series without mapping story parts", () => {
  const commercial = {
    metric: "circulation-per-volume",
    circulation: 185_000_000,
    volumesAtAnnouncement: 31,
    perVolume: 5_967_742,
    asOf: "2026-07-18",
    scope: "Wikipedia list row",
    sourceUrl: "https://example.test/slam-dunk",
    sourceLabel: "Wikipedia",
  };
  const items = [
    {
      id: "manga:slam-dunk",
      medium: "manga",
      title: { zh: "灌篮高手", original: "SLAM DUNK" },
      commercial,
    },
    {
      id: "manga:slam-dunk-kanzenban",
      medium: "manga",
      title: { zh: "灌篮高手 完全版", original: "SLAM DUNK 完全版" },
      commercial: null,
    },
    {
      id: "manga:jojo-part-7",
      medium: "manga",
      title: { zh: "JoJo 第七部", original: "Steel Ball Run" },
      commercial: null,
    },
  ];
  const titles = [
    { id: "manga:slam-dunk", aliases: ["Slam Dunk", "SLAM DUNK"] },
    { id: "manga:slam-dunk-kanzenban", aliases: ["SLAM DUNK 完全版"] },
    { id: "manga:jojo-part-7", aliases: ["Steel Ball Run", "JoJo Part 7"] },
  ];

  assert.equal(inheritMangaEditions(items, titles), 1);
  assert.equal(items[1].commercial.perVolume, commercial.perVolume);
  assert.equal(items[1].commercial.inheritedFrom.id, "manga:slam-dunk");
  assert.match(items[1].commercial.scope, /非该版本单独销量/);
  assert.equal(items[2].commercial, null);
});

test("manga article circulation requires a completed work and compatible announcement date", () => {
  const publication = { status: "FINISHED", volumes: 13, endYear: 2013 };
  const result = extractMangaCirculation(
    "2025年2月時点で累計発行部数は630万部を突破している。",
    publication,
  );
  assert.equal(result.circulation, 6_300_000);
  assert.equal(result.volumesAtAnnouncement, 13);
  assert.equal(result.perVolume, 484_615);
  assert.equal(result.statementDate, "2025-02-01");

  assert.equal(extractMangaCirculation(
    "2012年時点で累計発行部数は600万部を突破した。",
    publication,
  ), null);
  assert.equal(extractMangaCirculation(
    "2025年時点で累計発行部数は630万部を突破した。",
    { ...publication, status: "RELEASING", endYear: null },
  ), null);
});

test("manga article circulation accepts an explicit final-volume statement", () => {
  const result = extractMangaCirculation(
    "コミックス全７巻の累計発行部数は1780万部を突破している。",
    { status: "Finished", volumes: 7, endYear: 1994 },
  );
  assert.equal(result.circulation, 17_800_000);
  assert.equal(result.perVolume, 2_542_857);
  assert.equal(result.statementDate, null);
  assert.equal(extractMangaCirculation(
    "2025年時点でシリーズ累計発行部数は2000万部を突破した。",
    { status: "Finished", volumes: 7, endYear: 1994 },
  ), null);
});

test("disc sales require both a cumulative qualifier and a BD or DVD marker", () => {
  const result = extractDiscSales(
    "BD・DVDの累計売上は7万5000枚を突破した。DVD第1巻は初週9000枚を売り上げた。",
  );
  assert.equal(result.unitsTotal, 75_000);
  assert.equal(
    extractDiscSales("BDとDVDの平均売上は12,345枚だった。").unitsPerVolume,
    12_345,
  );
  assert.equal(extractDiscSales("DVD第1巻は初週9000枚を売り上げた。"), null);
  assert.equal(extractDiscSales("関連商品は累計10万個を販売した。"), null);
});

test("archived anime tables use authoritative article aliases and preserve per-volume scope", () => {
  const html = `
    <table>
      <tr><th>Title</th><th>Year</th><th>Avg Sales</th><th>Re-rls</th><th>Total</th></tr>
      <tr><td>Mahou Shoujo Madoka Magica</td><td>2011</td><td>71,056</td><td>8,000</td><td>79,056</td></tr>
    </table>
    <table>
      <tr><th>Title</th><th>Year</th><th>Average Sales</th></tr>
      <tr><td>Example OVA</td><td>2012</td><td>4,321</td></tr>
    </table>`;
  const rows = parseAnimeArchive(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].commercial.unitsPerVolume, 79_056);
  const mapped = matchAnimeArchive([{
    id: "anime:madoka",
    medium: "anime",
    title: { zh: "魔法少女小圆", original: "魔法少女まどか☆マギカ" },
    aliases: [],
    wikidata: {
      articles: { ja: "魔法少女まどか☆マギカ", en: "Mahou Shoujo Madoka★Magica" },
    },
    year: 2011,
    format: "TV",
  }], rows);
  assert.equal(mapped.get("anime:madoka").unitsPerVolume, 79_056);
});

test("anime sales matching rejects a different numbered season", () => {
  const rows = [{
    title: "進撃の巨人 Season3",
    year: 2018,
    kind: "series",
    commercial: { unitsPerVolume: 3_905 },
  }];
  const mapped = matchAnimeArchive([{
    id: "anime:aot-season-2",
    medium: "anime",
    title: { zh: "进击的巨人 第二季", original: "進撃の巨人 Season 2" },
    aliases: ["Attack on Titan Season 2"],
    year: 2017,
    format: "TV",
  }], rows);

  assert.equal(mapped.has("anime:aot-season-2"), false);
});

test("anime sales matching accepts an otherwise exact title when only one side has a season number", () => {
  const rows = [{
    title: "響け！ユーフォニアム",
    year: 2024,
    kind: "series",
    commercial: { unitsPerVolume: 8_310 },
  }];
  const mapped = matchAnimeArchive([{
    id: "anime:euphonium-season-3",
    medium: "anime",
    title: { zh: "吹响吧！上低音号 第三季", original: "響け！ユーフォニアム3" },
    aliases: ["Sound! Euphonium 3"],
    wikidata: { articles: { ja: "響け！ユーフォニアム" } },
    year: 2024,
    format: "TV",
  }], rows);

  assert.equal(mapped.get("anime:euphonium-season-3").unitsPerVolume, 8_310);
});

test("anime sales matching does not assign a whole-season record to an explicit split part", () => {
  const rows = [{
    title: "進撃の巨人 Season3",
    year: 2019,
    kind: "series",
    commercial: { unitsPerVolume: 3_905 },
  }];
  const mapped = matchAnimeArchive([{
    id: "anime:aot-season-3-part-2",
    medium: "anime",
    title: { zh: "进击的巨人 Season 3 Part 2", original: "進撃の巨人 Season3 Part.2" },
    aliases: [
      "Attack on Titan Season 3 Part 2",
      "Attack on Titan Season 3",
      "進撃の巨人 Season3",
    ],
    year: 2019,
    format: "TV",
  }], rows);

  assert.equal(mapped.has("anime:aot-season-3-part-2"), false);
});

test("commercial source merging prefers a newer statement and then the larger same-day value", () => {
  const older = new Map([["Q1", {
    circulation: 10_000_000,
    asOf: "2024-03-01",
    sourceLabel: "older",
  }]]);
  const newer = new Map([["Q1", {
    circulation: 9_000_000,
    asOf: "2025-02-01",
    sourceLabel: "newer",
  }]]);
  const sameDayHigher = new Map([["Q1", {
    circulation: 11_000_000,
    asOf: "2025-02-01",
    sourceLabel: "same-day higher",
  }]]);

  assert.equal(
    mergeCommercialMaps(older, newer, sameDayHigher).get("Q1").sourceLabel,
    "same-day higher",
  );
});

test("annual anime rankings parse cumulative per-volume averages across years", () => {
  const html = `
    <time datetime="2025-11-06T02:14:39+09:00"></time>
    <div id="wikibody">
      <div>○2025年TVアニメ 上位作品ランキング （累平1000以上）</div>
      <div>
        (春)*7,529　ウマ娘 シンデレラグレイ(2/4巻)<br>
        (春)*3,530　WIND BREAKER（※3,530.3枚）
      </div>
      <div>○2024年TVアニメ 上位作品ランキング</div>
      <div>(春)13,918　鬼滅の刃 柱稽古編</div>
    </div>`;
  const rows = parseAnimeAnnual(
    html,
    "https://web.archive.org/web/20260203074932id_/https://example.test/annual",
  );

  assert.deepEqual(rows.map((row) => ({
    title: row.title,
    year: row.year,
    units: row.commercial.unitsPerVolume,
  })), [
    { title: "ウマ娘 シンデレラグレイ", year: 2025, units: 7_529 },
    { title: "WIND BREAKER", year: 2025, units: 3_530 },
    { title: "鬼滅の刃 柱稽古編", year: 2024, units: 13_918 },
  ]);
  assert.equal(rows[0].commercial.asOf, "2025-11-06");
  assert.match(rows[0].commercial.sourceLabel, /Internet Archive/);
});
