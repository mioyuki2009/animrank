import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDiscSales,
  matchAnimeArchive,
  parseAnimeArchive,
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

test("archived anime tables map explicit aliases and preserve per-volume scope", () => {
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
    aliases: ["Mahou Shoujo Madoka★Magica"],
    year: 2011,
    format: "TV",
  }], rows);
  assert.equal(mapped.get("anime:madoka").unitsPerVolume, 79_056);
});
