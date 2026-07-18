import assert from "node:assert/strict";
import test from "node:test";
import {
  matchMangaCodexAnimeRows,
  matchMangaCodexMangaRows,
  parseMangaCodexAnimeAveragePage,
  parseMangaCodexAnimeDetail,
  parseMangaCodexAnimePre2000Page,
  parseMangaCodexCirculationPage,
  parseMangaCodexMangaDetail,
} from "../scripts/lib/mangacodex.mjs";

test("Manga Codex anime average pages expose comparable per-series values", () => {
  const html = `
    <h1 class="data-head__title">Initial averages — post-2000</h1>
    <table class="data-table"><tbody><tr>
      <td>01</td>
      <td><a href="/anime/uma-musume-season-2">Uma Musume: Pretty Derby Season 2</a></td>
      <td>TV</td>
      <td>196,859</td>
      <td>0%</td><td>100%</td><td>0%</td>
    </tr></tbody></table>`;
  const rows = parseMangaCodexAnimeAveragePage(html, "2026-07-18");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].format, "TV");
  assert.equal(rows[0].commercial.unitsPerVolume, 196_859);
  assert.match(rows[0].commercial.sourceLabel, /Manga Codex/);
});

test("Manga Codex pre-2000 totals only map to movies", () => {
  const html = `
    <h1 class="data-head__title">Initial sales — pre-2000</h1>
    <table class="data-table"><tbody><tr>
      <td>01</td>
      <td><a href="/anime/mononoke-hime">Mononoke-hime</a></td>
      <td>1,077,143</td><td>—</td><td>1,077,143</td>
    </tr></tbody></table>`;
  const rows = parseMangaCodexAnimePre2000Page(html, "2026-07-18");
  const duplicateAverage = parseMangaCodexAnimeAveragePage(`
    <h1 class="data-head__title">Initial averages — post-2000</h1>
    <table class="data-table"><tbody><tr>
      <td>01</td>
      <td><a href="/anime/mononoke-hime">Mononoke-hime</a></td>
      <td>MOVIE</td><td>101,100</td>
    </tr></tbody></table>`, "2026-07-18");
  const titles = [
    {
      id: "anime:movie",
      medium: "anime",
      title: { zh: "幽灵公主", original: "もののけ姫" },
      aliases: ["Mononoke-hime"],
      year: 1997,
      format: "MOVIE",
    },
    {
      id: "anime:tv",
      medium: "anime",
      title: { zh: "幽灵公主 TV", original: "Mononoke-hime" },
      aliases: ["Mononoke-hime"],
      year: 1997,
      format: "TV",
    },
  ];
  const mapped = matchMangaCodexAnimeRows(titles, [
    ...duplicateAverage,
    ...rows,
  ]);

  assert.equal(rows[0].commercial.unitsPerVolume, 1_077_143);
  assert.equal(mapped.has("anime:movie"), true);
  assert.equal(mapped.get("anime:movie").commercial.unitsPerVolume, 1_077_143);
  assert.equal(mapped.has("anime:tv"), false);
});

test("Manga Codex circulation rankings retain the detail URL", () => {
  const html = `
    <h1 class="data-head__title">Top by Circulation</h1>
    <table class="data-table"><tbody><tr>
      <td>1</td><td><a href="/manga/touch">Touch</a></td>
      <td>Shogakukan</td><td>100,000,000</td>
    </tr></tbody></table>`;
  const rows = parseMangaCodexCirculationPage(html);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].circulation, 100_000_000);
  assert.equal(rows[0].detailUrl, "https://mangacodex.com/manga/touch");
});

test("Manga Codex manga details combine current circulation and volume count", () => {
  const html = `
    <div class="manga-header">
      <p class="manga-header__meta">MANGA · SINCE 1981</p>
      <h1 class="manga-header__title">Touch</h1>
      <p class="manga-header__title-jp">タッチ</p>
      <div class="circulation-block__big">100,000,000</div>
      <dl class="info-list">
        <div class="info-list__row"><dt>Volumes</dt><dd>26</dd></div>
      </dl>
    </div>
    <table class="data-table">
      <thead><tr><th>Volumes</th><th>Cumulative</th><th>Source</th></tr></thead>
      <tbody><tr>
        <td>1–26</td><td>68,000,000</td>
        <td><a href="https://example.test/source">Publisher: 2000/01/02</a></td>
      </tr></tbody>
    </table>`;
  const row = parseMangaCodexMangaDetail(
    html,
    "https://mangacodex.com/manga/touch?hist_tab=circulation",
    "2026-07-18",
  );

  assert.equal(row.commercial.circulation, 100_000_000);
  assert.equal(row.commercial.volumesAtAnnouncement, 26);
  assert.equal(row.commercial.perVolume, 3_846_154);
  assert.equal(row.commercial.asOf, "2026-07-18");
});

test("Manga Codex manga details accept Volume/Total circulation history tables", () => {
  const html = `
    <div class="manga-header">
      <p class="manga-header__meta">MANGA · SINCE 2004</p>
      <h1 class="manga-header__title">Steel Ball Run</h1>
      <h2 class="manga-header__title-jp">スティール・ボール・ラン</h2>
      <dl class="info-list">
        <div class="info-list__row"><dt>Volumes</dt><dd>24</dd></div>
      </dl>
    </div>
    <p class="section-meta">Sales data through Jun 6, 2011</p>
    <table class="data-table">
      <thead><tr><th>Week</th><th>Volume</th><th>Ranking</th><th>Weekly</th><th>Total</th></tr></thead>
      <tbody>
        <tr><td>Jun 6, 2011</td><td>Vol 24</td><td>#7</td><td>61,785</td><td>183,374</td></tr>
        <tr><td>May 30, 2011</td><td>Vol 24</td><td>#6</td><td>121,589</td><td>121,589</td></tr>
      </tbody>
    </table>`;
  const row = parseMangaCodexMangaDetail(
    html,
    "https://mangacodex.com/manga/steel-ball-run?hist_tab=circulation",
    "2026-07-18",
  );

  assert.equal(row.commercial.circulation, 183_374);
  assert.equal(row.commercial.volumesAtAnnouncement, 1);
  assert.equal(row.commercial.perVolume, 183_374);
  assert.equal(row.commercial.asOf, "2011-06-06");
  assert.equal(row.commercial.historyOnly, true);
  assert.match(row.commercial.scope, /不等同于系列总发行量/);
});

test("Manga Codex series circulation wins over per-volume history on the same detail page", () => {
  const html = `
    <div class="manga-header">
      <p class="manga-header__meta">MANGA · SINCE 2012</p>
      <h1 class="manga-header__title">Example Series</h1>
      <div class="circulation-block__big">2,000,000</div>
      <dl class="info-list">
        <div class="info-list__row"><dt>Volumes</dt><dd>10</dd></div>
      </dl>
    </div>
    <table class="data-table">
      <thead><tr><th>Week</th><th>Volume</th><th>Ranking</th><th>Weekly</th><th>Total</th></tr></thead>
      <tbody>
        <tr><td>Jan 1, 2024</td><td>Vol 9</td><td>#1</td><td>100,000</td><td>180,000</td></tr>
        <tr><td>Jan 8, 2024</td><td>Vol 10</td><td>#1</td><td>100,000</td><td>200,000</td></tr>
      </tbody>
    </table>`;
  const row = parseMangaCodexMangaDetail(
    html,
    "https://mangacodex.com/manga/example-series?hist_tab=circulation",
    "2026-07-18",
  );

  assert.equal(row.commercial.circulation, 2_000_000);
  assert.equal(row.commercial.volumesAtAnnouncement, 10);
  assert.equal(row.commercial.perVolume, 200_000);
  assert.equal(row.commercial.historyOnly, undefined);
});

test("Manga Codex anime details calculate the exact average from release rows", () => {
  const html = `
    <div class="manga-header">
      <p class="manga-header__meta">ANIME · TV · 2021</p>
      <h1 class="manga-header__title">Example Season 2</h1>
      <dl class="info-list">
        <div class="info-list__row"><dt>Format</dt><dd>TV</dd></div>
      </dl>
    </div>
    <p class="section-meta">Sales data through Aug 18, 2021</p>
    <table class="data-table">
      <thead><tr><th>Vol</th><th>Format</th><th>Release date</th><th>Sales</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>BD</td><td>Jul 1, 2021</td><td>100,000</td></tr>
        <tr><td>2</td><td>BD</td><td>Aug 18, 2021</td><td>200,000</td></tr>
      </tbody>
    </table>`;
  const row = parseMangaCodexAnimeDetail(
    html,
    "https://mangacodex.com/anime/example-season-2",
    "2026-07-18",
  );

  assert.equal(row.year, 2021);
  assert.equal(row.format, "TV");
  assert.equal(row.commercial.unitsPerVolume, 150_000);
  assert.equal(row.commercial.releaseCount, 2);
  assert.equal(row.commercial.asOf, "2021-08-18");
});

test("Manga Codex anime detail uses its combined average instead of averaging formats twice", () => {
  const html = `
    <div class="manga-header">
      <p class="manga-header__meta">ANIME · TV · 2008</p>
      <h1 class="manga-header__title">Example R2</h1>
      <dl class="info-list">
        <div class="info-list__row"><dt>Format</dt><dd>TV</dd></div>
      </dl>
    </div>
    <div class="highlight-card">
      <div class="highlight-card__label">Sales avg (total)</div>
      <div class="highlight-card__value">42.7K</div>
    </div>
    <table class="data-table">
      <thead><tr><th>Vol</th><th>Format</th><th>Release date</th><th>Sales</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>DVD</td><td>Jan 1, 2009</td><td>20,000</td></tr>
        <tr><td>1</td><td>BD</td><td>Jan 1, 2009</td><td>22,700</td></tr>
      </tbody>
    </table>`;
  const row = parseMangaCodexAnimeDetail(
    html,
    "https://mangacodex.com/anime/example-r2",
    "2026-07-18",
  );

  assert.equal(row.commercial.unitsPerVolume, 42_700);
});

test("Manga Codex manga detail matching rejects a different same-name generation", () => {
  const item = {
    id: "manga:bastard-webtoon",
    medium: "manga",
    title: { zh: "Bastard", original: "후레자식" },
    aliases: ["Bastard"],
    year: 2014,
  };
  const oldSeries = {
    title: "Bastard",
    matchTitles: ["Bastard"],
    year: 1988,
    detailUrl: "https://mangacodex.com/manga/bastard",
  };

  assert.equal(matchMangaCodexMangaRows([item], [oldSeries]).size, 0);
});

test("verified anime details accept a distinctive alias contained in a franchise-prefixed title", () => {
  const item = {
    id: "anime:end-of-evangelion",
    medium: "anime",
    title: {
      zh: "新世纪福音战士剧场版 Air/真心为你",
      original: "新世紀エヴァンゲリオン劇場版 Air/まごころを、君に",
    },
    aliases: ["The End of Evangelion"],
    year: 1997,
    format: "MOVIE",
  };
  const detail = {
    title: "Evangelion - Shinseiki Evangerion Gekijouban: Ea/Magokoro wo, Kimi ni [The End of Evangelion]",
    year: 1998,
    format: "Movie",
    detailUrl: "https://mangacodex.com/anime/end-of-evangelion",
  };

  assert.equal(matchMangaCodexAnimeRows([item], [detail]).has(item.id), true);
  assert.equal(matchMangaCodexAnimeRows([item], [{
    ...detail,
    year: null,
    pre2000Total: true,
  }]).has(item.id), true);
});
