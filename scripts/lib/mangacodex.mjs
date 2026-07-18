import { parseHTML } from "linkedom";
import { delay, fetchJson } from "./http.mjs";

const BASE_URL = "https://mangacodex.com";
const SEARCH_URL = BASE_URL + "/search/api.php";
const ANIME_AVERAGE_URL = BASE_URL + "/sales/anime?tab=initial_avg&page=1";
const ANIME_PRE2000_URL = BASE_URL + "/sales/anime?tab=pre2000&page=1";
const MANGA_CIRCULATION_URL =
  BASE_URL + "/sales/rankings?type=circulation&page=1";

function dateOnly(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
}

function queryUrl(endpoint, parameters) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function parseInteger(value) {
  const match = String(value || "").replaceAll(",", "").match(/\d+/);
  const number = Number(match?.[0]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseCompactNumber(value) {
  const text = String(value || "").replaceAll(",", "").trim();
  const match = text.match(/(\d+(?:\.\d+)?)\s*([KMB])?/iu);
  if (!match) return null;
  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
  }[String(match[2] || "").toLocaleUpperCase("en-US")] || 1;
  const number = Math.round(Number(match[1]) * multiplier);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeDigits(value) {
  return String(value || "").replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

function normalizedTitle(value) {
  return normalizeDigits(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function titleBigrams(value) {
  const characters = Array.from(value);
  if (characters.length < 2) return characters;
  return characters.slice(0, -1).map((character, index) =>
    character + characters[index + 1],
  );
}

function titleSimilarity(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 5) return 0;
  const counts = new Map();
  for (const pair of titleBigrams(b)) counts.set(pair, (counts.get(pair) || 0) + 1);
  let overlap = 0;
  const leftPairs = titleBigrams(a);
  for (const pair of leftPairs) {
    const count = counts.get(pair) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (leftPairs.length + titleBigrams(b).length);
}

function detailTitleSimilarity(left, right) {
  const score = titleSimilarity(left, right);
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 12 && (a.includes(b) || b.includes(a))) {
    return Math.max(score, 0.96);
  }
  return score;
}

function aliasesFor(item) {
  return [...new Set([
    ...(item.aliases || []),
    item.title?.zh,
    item.title?.original,
    item.wikidata?.articles?.ja,
    item.wikidata?.articles?.en,
  ].filter(Boolean))];
}

function installmentNumbers(value) {
  const text = normalizeDigits(value).normalize("NFKC");
  const numbers = new Set();
  const patterns = [
    /(?:season|シーズン)\s*([1-9]\d?)/giu,
    /第\s*([1-9]\d?)\s*(?:期|季|シーズン|クール|部)/gu,
    /([1-9]\d?)(?:st|nd|rd|th)\s*(?:season|cour|part)/giu,
    /(?:part|cour|パート|クール)\s*[.:_-]?\s*([1-9]\d?)/giu,
    /(?<!\d)([2-9])\s*$/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) numbers.add(Number(match[1]));
  }
  return numbers;
}

function splitInstallments(value) {
  const text = normalizeDigits(value).normalize("NFKC");
  const parts = new Set();
  const patterns = [
    /(?:part|cour|パート|クール|parte|partie|teil)\s*[.:_-]?\s*([1-9]\d?)/giu,
    /第\s*([1-9]\d?)\s*(?:クール|部)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) parts.add(Number(match[1]));
  }
  const halves = new Set();
  if (/(?:(?:second|2nd|latter)\s+half|後半(?:戦)?|後編)/iu.test(text)) halves.add(2);
  if (/(?:(?:first|1st|former)\s+half|前半(?:戦)?|前編)/iu.test(text)) halves.add(1);
  return { parts, halves };
}

function setsOverlap(left, right) {
  return [...left].some((value) => right.has(value));
}

function installmentCompatible(item, aliases, rowTitle) {
  const primary = splitInstallments([
    item.title?.zh,
    item.title?.original,
  ].filter(Boolean).join(" "));
  const rowSpecific = splitInstallments(rowTitle);
  if (primary.parts.size > 0 && !setsOverlap(primary.parts, rowSpecific.parts)) return false;
  if (primary.halves.size > 0 && !setsOverlap(primary.halves, rowSpecific.halves)) return false;

  const itemNumbers = new Set(aliases.flatMap((alias) => [...installmentNumbers(alias)]));
  const rowNumbers = installmentNumbers(rowTitle);
  if (itemNumbers.size === 0 || rowNumbers.size === 0) return true;
  return setsOverlap(itemNumbers, rowNumbers);
}

function formatGroup(value) {
  const format = String(value || "").toLocaleUpperCase("en-US");
  if (/(?:MOVIE|FILM|剧场|劇場|映画)/u.test(format)) return "movie";
  if (/(?:OVA|OAD)/u.test(format)) return "ova";
  if (/(?:ONA|WEB)/u.test(format)) return "ona";
  if (/(?:SPECIAL|SP)/u.test(format)) return "special";
  if (/(?:TV|テレビ)/u.test(format)) return "tv";
  return null;
}

function animeFormatCompatible(item, row) {
  const itemGroup = formatGroup(item.format);
  if (row.pre2000Total) return itemGroup === "movie";
  const rowGroup = formatGroup(row.format);
  if (!itemGroup || !rowGroup) return true;
  return itemGroup === rowGroup;
}

function rowTitles(row) {
  return [...new Set([row.title, ...(row.matchTitles || [])].filter(Boolean))];
}

function uniqueRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = row.detailUrl || [
      row.title,
      row.format,
      row.commercial?.unitsPerVolume,
      row.circulation,
    ].join("|");
    const existing = byKey.get(key);
    if (!existing || (row.pre2000Total && !existing.pre2000Total)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function matchRows(titles, inputRows, medium) {
  const rows = uniqueRows(inputRows);
  const edges = [];
  const byItem = new Map();

  for (const item of titles.filter((title) => title.medium === medium)) {
    const aliases = aliasesFor(item);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (Number.isInteger(row.year) && Number.isInteger(item.year) &&
        Math.abs(row.year - item.year) > 1) continue;
      if (medium === "anime") {
        if (!animeFormatCompatible(item, row)) continue;
        if (!installmentCompatible(item, aliases, row.title)) continue;
      }

      const score = Math.max(...aliases.flatMap((alias) =>
        rowTitles(row).map((rowTitle) =>
          Number.isInteger(row.year) || row.pre2000Total
            ? detailTitleSimilarity(alias, rowTitle)
            : titleSimilarity(alias, rowTitle)
        )
      ));
      const threshold = medium === "anime" ? 0.91 : 0.93;
      if (score < threshold) continue;
      const edge = {
        item,
        row,
        rowIndex,
        score,
        exact: score === 1,
        yearDistance: Number.isInteger(row.year) && Number.isInteger(item.year)
          ? Math.abs(row.year - item.year)
          : 99,
      };
      edges.push(edge);
      if (!byItem.has(item.id)) byItem.set(item.id, []);
      byItem.get(item.id).push(edge);
    }
  }

  const eligible = new Set();
  for (const [itemId, itemEdges] of byItem) {
    itemEdges.sort((left, right) =>
      Number(right.exact) - Number(left.exact) ||
      right.score - left.score ||
      left.yearDistance - right.yearDistance
    );
    const best = itemEdges[0];
    const second = itemEdges[1];
    if (second && best.rowIndex !== second.rowIndex &&
      best.score - second.score < 0.035) {
      continue;
    }
    eligible.add(itemId);
  }

  edges.sort((left, right) =>
    Number(right.exact) - Number(left.exact) ||
    right.score - left.score ||
    left.yearDistance - right.yearDistance
  );
  const usedItems = new Set();
  const usedRows = new Set();
  const result = new Map();
  for (const edge of edges) {
    if (!eligible.has(edge.item.id) ||
      usedItems.has(edge.item.id) ||
      usedRows.has(edge.rowIndex)) continue;
    usedItems.add(edge.item.id);
    usedRows.add(edge.rowIndex);
    result.set(edge.item.id, edge.row);
  }
  return result;
}

export function matchMangaCodexAnimeRows(titles, rows) {
  return matchRows(titles, rows, "anime");
}

export function matchMangaCodexMangaRows(titles, rows) {
  return matchRows(titles, rows, "manga");
}

function directCells(row) {
  return [...row.querySelectorAll(":scope > td")];
}

function absoluteUrl(value) {
  try {
    return new URL(value, BASE_URL).toString();
  } catch {
    return null;
  }
}

function pageCount(html) {
  const { document } = parseHTML(String(html || ""));
  const pages = [...document.querySelectorAll(".pagination a[href]")]
    .map((link) => {
      try {
        return Number(new URL(link.getAttribute("href"), BASE_URL).searchParams.get("page"));
      } catch {
        return 0;
      }
    })
    .filter(Number.isInteger);
  return Math.max(1, ...pages);
}

export function parseMangaCodexAnimeAveragePage(html, asOf) {
  const { document } = parseHTML(String(html || ""));
  if (!/Initial averages/iu.test(document.querySelector(".data-head__title")?.textContent || "")) {
    return [];
  }
  const records = [];
  for (const row of document.querySelectorAll(".data-table tbody tr")) {
    const cells = directCells(row);
    const link = cells[1]?.querySelector("a[href]");
    const title = link?.textContent.replace(/\s+/g, " ").trim();
    const format = cells[2]?.textContent.trim();
    const unitsPerVolume = parseInteger(cells[3]?.textContent);
    const detailUrl = absoluteUrl(link?.getAttribute("href"));
    if (!title || !format || !unitsPerVolume || !detailUrl) continue;
    records.push({
      title,
      matchTitles: [title],
      format,
      year: null,
      detailUrl,
      commercial: {
        metric: "bd-dvd-average",
        unitsPerVolume,
        releaseCount: null,
        asOf,
        scope: "Manga Codex 日本实体影碟初回销量的系列平均值（DVD / BD / Other）",
        sourceUrl: detailUrl,
        sourceLabel: "Manga Codex - Anime sales",
      },
    });
  }
  return records;
}

export function parseMangaCodexAnimePre2000Page(html, asOf) {
  const { document } = parseHTML(String(html || ""));
  if (!/pre-2000/iu.test(document.querySelector(".data-head__title")?.textContent || "")) {
    return [];
  }
  const records = [];
  for (const row of document.querySelectorAll(".data-table tbody tr")) {
    const cells = directCells(row);
    const link = cells[1]?.querySelector("a[href]");
    const title = link?.textContent.replace(/\s+/g, " ").trim();
    const unitsPerVolume = parseInteger(cells[4]?.textContent);
    const detailUrl = absoluteUrl(link?.getAttribute("href"));
    if (!title || !unitsPerVolume || !detailUrl) continue;
    records.push({
      title,
      matchTitles: [title],
      format: "MOVIE",
      year: null,
      pre2000Total: true,
      detailUrl,
      commercial: {
        metric: "bd-dvd-average",
        unitsPerVolume,
        releaseCount: 1,
        asOf,
        scope: "Manga Codex 2000 年前电影实体影碟初版与再版合计销量",
        sourceUrl: detailUrl,
        sourceLabel: "Manga Codex - Anime sales",
      },
    });
  }
  return records;
}

export function parseMangaCodexCirculationPage(html) {
  const { document } = parseHTML(String(html || ""));
  if (!/Top by Circulation/iu.test(document.querySelector(".data-head__title")?.textContent || "")) {
    return [];
  }
  const records = [];
  for (const row of document.querySelectorAll(".data-table tbody tr")) {
    const cells = directCells(row);
    const link = cells[1]?.querySelector("a[href]");
    const title = link?.textContent.replace(/\s+/g, " ").trim();
    const circulation = parseInteger(cells[3]?.textContent);
    const detailUrl = absoluteUrl(link?.getAttribute("href"));
    if (!title || !circulation || !detailUrl) continue;
    records.push({
      title,
      matchTitles: [title],
      year: null,
      circulation,
      detailUrl,
    });
  }
  return records;
}

function infoValue(document, label) {
  for (const row of document.querySelectorAll(".info-list__row")) {
    if (row.querySelector("dt")?.textContent.trim() === label) {
      return row.querySelector("dd")?.textContent.replace(/\s+/g, " ").trim() || null;
    }
  }
  return null;
}

function sourceDate(value, fallback) {
  const text = normalizeDigits(value);
  const numeric = text.match(/((?:19|20)\d{2})[/-](\d{1,2})[/-](\d{1,2})/u);
  if (numeric) {
    return numeric[1] + "-" +
      numeric[2].padStart(2, "0") + "-" +
      numeric[3].padStart(2, "0");
  }
  const english = text.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s+((?:19|20)\d{2})/iu,
  );
  if (!english) return fallback;
  const months = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const month = months[english[1].slice(0, 3).toLocaleLowerCase("en-US")];
  return english[3] + "-" +
    String(month).padStart(2, "0") + "-" +
    english[2].padStart(2, "0");
}

function volumeCount(value) {
  const values = [...normalizeDigits(value).matchAll(/\d+/gu)]
    .map((match) => Number(match[0]))
    .filter((number) => Number.isInteger(number) && number > 0 && number < 1000);
  return values.length ? Math.max(...values) : null;
}

export function parseMangaCodexMangaDetail(html, sourceUrl, asOf) {
  const { document } = parseHTML(String(html || ""));
  const title = document.querySelector(".manga-header__title")?.textContent.trim();
  const original = document.querySelector(".manga-header__title-jp")?.textContent.trim();
  const meta = document.querySelector(".manga-header__meta")?.textContent || "";
  const year = parseInteger(meta.match(/(?:19|20)\d{2}/u)?.[0]);
  const headerCirculation = parseInteger(
    document.querySelector(".circulation-block__big")?.textContent,
  );
  const headerVolumes = parseInteger(infoValue(document, "Volumes"));
  const history = [];
  let hasPerVolumeHistory = false;

  for (const table of document.querySelectorAll(".data-table")) {
    const headers = [...table.querySelectorAll("thead th")].map((cell) =>
      cell.textContent.replace(/\s+/g, " ").trim(),
    );
    const volumesIndex = headers.findIndex((header) =>
      /^(?:volumes?|volume count)$/iu.test(header),
    );
    const cumulativeIndex = headers.findIndex((header) =>
      /^(?:cumulative|total|circulation)$/iu.test(header),
    );
    const sourceIndex = headers.findIndex((header) =>
      /^(?:source|publisher|announcement)$/iu.test(header),
    );
    const perVolumeTable = sourceIndex < 0 &&
      /^volume$/iu.test(headers[volumesIndex] || "") &&
      /^total$/iu.test(headers[cumulativeIndex] || "");
    hasPerVolumeHistory ||= perVolumeTable;
    if (volumesIndex < 0 || cumulativeIndex < 0) continue;
    for (const row of table.querySelectorAll("tbody tr")) {
      const cells = directCells(row);
      const volumes = volumeCount(cells[volumesIndex]?.textContent);
      const circulation = parseInteger(cells[cumulativeIndex]?.textContent);
      const sourceCell = cells[sourceIndex >= 0 ? sourceIndex : 0];
      const upstreamLabel = sourceCell?.textContent.replace(/\s+/g, " ").trim() || null;
      const upstreamUrl = sourceIndex >= 0
        ? absoluteUrl(sourceCell?.querySelector("a[href]")?.getAttribute("href"))
        : null;
      if (!volumes || !circulation) continue;
      history.push({
        circulation,
        volumes,
        upstreamLabel,
        upstreamUrl,
        asOf: sourceDate(upstreamLabel, asOf),
      });
    }
  }

  let historical = null;
  if (hasPerVolumeHistory) {
    // The live Manga Codex table reports cumulative sales per individual
    // volume. Deduplicate weekly rows, then average only volumes with data.
    const byVolume = new Map();
    for (const entry of history) {
      const existing = byVolume.get(entry.volumes);
      if (!existing || entry.circulation > existing.circulation) {
        byVolume.set(entry.volumes, entry);
      }
    }
    const reported = [...byVolume.values()];
    reported.sort((left, right) =>
      Date.parse(right.asOf || 0) - Date.parse(left.asOf || 0),
    );
    if (reported.length) {
      historical = {
        circulation: reported.reduce((sum, entry) => sum + entry.circulation, 0),
        volumes: reported.length,
        asOf: reported[0].asOf,
        upstreamUrl: null,
        upstreamLabel: reported[0].upstreamLabel,
        perVolumeHistory: true,
      };
    }
  } else {
    history.sort((left, right) =>
      right.circulation - left.circulation || right.volumes - left.volumes
    );
    historical = history[0] || null;
  }
  const useHeader = headerCirculation && headerVolumes &&
    (hasPerVolumeHistory || !historical || headerCirculation > historical.circulation);
  const circulation = useHeader ? headerCirculation : historical?.circulation;
  const volumesAtAnnouncement = useHeader ? headerVolumes : historical?.volumes;
  if (!title || !circulation || !volumesAtAnnouncement) return null;

  return {
    title,
    matchTitles: [title, original].filter(Boolean),
    year,
    detailUrl: sourceUrl,
    commercial: {
      metric: "circulation-per-volume",
      circulation,
      volumesAtAnnouncement,
      perVolume: Math.round(circulation / volumesAtAnnouncement),
      asOf: useHeader ? asOf : historical.asOf,
      scope: useHeader
        ? "Manga Codex 系列累计发行量与同一条目卷数"
        : historical.perVolumeHistory
          ? "Manga Codex Oricon 各卷累计销量的平均值（仅统计有销售记录的卷，不等同于系列总发行量）"
          : "Manga Codex 系列累计发行量与同一条目卷数",
      includesDigital: null,
      ...(useHeader || !historical.perVolumeHistory ? {} : { historyOnly: true }),
      sourceUrl,
      sourceLabel: "Manga Codex - " + title,
      upstreamUrl: useHeader ? null : historical.upstreamUrl,
      upstreamLabel: useHeader ? null : historical.upstreamLabel,
    },
  };
}

export function parseMangaCodexAnimeDetail(html, sourceUrl, asOf) {
  const { document } = parseHTML(String(html || ""));
  const title = document.querySelector(".manga-header__title")?.textContent.trim();
  const meta = document.querySelector(".manga-header__meta")?.textContent || "";
  const year = parseInteger(meta.match(/(?:19|20)\d{2}/u)?.[0]);
  const format = infoValue(document, "Format") ||
    meta.split("·").map((part) => part.trim()).find((part) =>
      /^(?:TV|MOVIE|OVA|OAD|ONA|SPECIAL)$/iu.test(part)
    ) || null;

  let salesRows = [];
  for (const table of document.querySelectorAll(".data-table")) {
    const headers = [...table.querySelectorAll("thead th")].map((cell) =>
      cell.textContent.replace(/\s+/g, " ").trim(),
    );
    const volumeIndex = headers.indexOf("Vol");
    const formatIndex = headers.indexOf("Format");
    const salesIndex = headers.indexOf("Sales");
    if (volumeIndex < 0 || formatIndex < 0 || salesIndex < 0) continue;
    salesRows = [...table.querySelectorAll("tbody tr")]
      .map((row) => {
        const cells = directCells(row);
        return {
          volume: parseInteger(cells[volumeIndex]?.textContent),
          sales: parseInteger(cells[salesIndex]?.textContent),
        };
      })
      .filter((row) => row.sales);
    if (salesRows.length) break;
  }

  let unitsPerVolume = null;
  for (const card of document.querySelectorAll(".highlight-card")) {
    if (/Sales avg \(total\)/iu.test(card.querySelector(".highlight-card__label")?.textContent || "")) {
      unitsPerVolume = parseCompactNumber(
        card.querySelector(".highlight-card__value")?.textContent,
      );
    }
  }
  if (!unitsPerVolume && salesRows.length) {
    unitsPerVolume = Math.round(
      salesRows.reduce((sum, row) => sum + row.sales, 0) / salesRows.length,
    );
  }
  if (!title || !unitsPerVolume) return null;

  const through = [...document.querySelectorAll(".section-meta")]
    .map((node) => node.textContent.replace(/\s+/g, " ").trim())
    .find((value) => /Sales data through/iu.test(value));
  const releaseCount = new Set(salesRows.map((row) => row.volume).filter(Boolean)).size ||
    salesRows.length || null;
  return {
    title,
    matchTitles: [title],
    year,
    format,
    detailUrl: sourceUrl,
    commercial: {
      metric: "bd-dvd-average",
      unitsPerVolume,
      releaseCount,
      asOf: sourceDate(through, asOf),
      scope: "Manga Codex 日本实体影碟初回销量的系列平均值（DVD / BD / Other）",
      sourceUrl,
      sourceLabel: "Manga Codex - Anime sales",
    },
  };
}

async function fetchText(url, { attempts = 2, timeoutMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "FanRank/0.3 (" +
            (process.env.PROJECT_HOMEPAGE || "local-development") + ")",
        },
      });
      if (!response.ok) throw new Error(response.status + " " + response.statusText);
      return await response.text();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts - 1) await delay(750);
  }
  throw new Error("Unable to fetch " + url + ": " + (lastError?.message || "unknown error"));
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function fetchPagedRows(firstUrl, parser, asOf) {
  const firstHtml = await fetchText(firstUrl, { attempts: 2, timeoutMs: 30_000 });
  const totalPages = pageCount(firstHtml);
  const rows = parser(firstHtml, asOf);
  const errors = [];
  const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
  const outcomes = await mapConcurrent(pages, 6, async (page) => {
    const url = new URL(firstUrl);
    url.searchParams.set("page", String(page));
    try {
      const html = await fetchText(url.toString(), { attempts: 2, timeoutMs: 30_000 });
      return parser(html, asOf);
    } catch (error) {
      errors.push("page " + page + ": " + error.message);
      return [];
    }
  });
  return {
    rows: rows.concat(...outcomes),
    errors,
    pages: totalPages,
  };
}

function detailUrlFor(result, includeHistory = false) {
  const url = new URL("/" + result.media + "/" + result.slug, BASE_URL);
  if (result.siblings > 1 && result.series_id) {
    url.searchParams.set("v", String(result.series_id));
  }
  if (includeHistory) url.searchParams.set("hist_tab", "circulation");
  return url.toString();
}

function isMissingDetail(error) {
  return /\b404 Not Found\b/iu.test(error?.message || "");
}

function searchQueries(item) {
  const aliases = aliasesFor(item);
  const candidates = [
    item.title?.original,
    item.wikidata?.articles?.en,
    ...aliases.filter((alias) => /^[\x20-\x7e]+$/u.test(alias)),
    item.wikidata?.articles?.ja,
    item.title?.zh,
  ].filter((value) => String(value || "").trim().length >= 2);
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = normalizedTitle(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(String(candidate).trim());
    if (result.length === 3) break;
  }
  return result;
}

function candidateOrder(item, candidates) {
  const aliases = aliasesFor(item);
  return [...candidates].sort((left, right) => {
    const rightScore = Math.max(...aliases.map((alias) => titleSimilarity(alias, right.title)));
    const leftScore = Math.max(...aliases.map((alias) => titleSimilarity(alias, left.title)));
    return rightScore - leftScore;
  });
}

async function findViaSearch(
  item,
  media,
  asOf,
  searchCache,
  detailCache,
  errors,
) {
  for (const query of searchQueries(item)) {
    let candidates;
    try {
      if (!searchCache.has(query)) {
        searchCache.set(query, fetchJson(queryUrl(SEARCH_URL, { q: query }), {
          attempts: 2,
          timeoutMs: 20_000,
          headers: {
            Accept: "application/json",
            "User-Agent": "FanRank/0.3 (" +
              (process.env.PROJECT_HOMEPAGE || "local-development") + ")",
          },
        }));
      }
      candidates = await searchCache.get(query);
    } catch (error) {
      errors.push("search " + query + ": " + error.message);
      continue;
    }

    const ranked = candidateOrder(
      item,
      candidates.filter((candidate) =>
        candidate.media === media
      ),
    ).slice(0, 2);
    for (const candidate of ranked) {
      const sourceUrl = detailUrlFor(candidate, media === "manga");
      try {
        if (!detailCache.has(sourceUrl)) {
          detailCache.set(sourceUrl, fetchText(sourceUrl, {
            attempts: 2,
            timeoutMs: 30_000,
          }));
        }
        const html = await detailCache.get(sourceUrl);
        const row = media === "manga"
          ? parseMangaCodexMangaDetail(html, sourceUrl, asOf)
          : parseMangaCodexAnimeDetail(html, sourceUrl, asOf);
        if (!row) continue;
        const matched = matchRows([item], [row], media);
        if (matched.has(item.id)) return row.commercial;
      } catch (error) {
        if (!isMissingDetail(error)) {
          errors.push("detail " + sourceUrl + ": " + error.message);
        }
      }
    }
  }
  return null;
}

export async function fetchMangaCodexAnime(titles) {
  const asOf = dateOnly(new Date().toISOString());
  const errors = [];
  const pageResults = await Promise.allSettled([
    fetchPagedRows(ANIME_AVERAGE_URL, parseMangaCodexAnimeAveragePage, asOf),
    fetchPagedRows(ANIME_PRE2000_URL, parseMangaCodexAnimePre2000Page, asOf),
  ]);
  const rows = [];
  let pages = 0;
  for (const outcome of pageResults) {
    if (outcome.status === "fulfilled") {
      rows.push(...outcome.value.rows);
      errors.push(...outcome.value.errors);
      pages += outcome.value.pages;
    } else {
      errors.push(outcome.reason?.message || String(outcome.reason));
    }
  }
  if (rows.length === 0) {
    throw new Error(errors[0] || "Manga Codex anime rankings returned no rows");
  }

  const matched = matchMangaCodexAnimeRows(titles, rows);
  const titleById = new Map(titles.map((title) => [title.id, title]));
  const records = new Map();
  const detailCache = new Map();
  const parsed = await mapConcurrent([...matched], 4, async ([itemId, row]) => {
    try {
      if (!detailCache.has(row.detailUrl)) {
        detailCache.set(row.detailUrl, fetchText(row.detailUrl, {
          attempts: 2,
          timeoutMs: 30_000,
        }));
      }
      const detail = parseMangaCodexAnimeDetail(
        await detailCache.get(row.detailUrl),
        row.detailUrl,
        asOf,
      );
      const item = titleById.get(itemId);
      if (detail && item &&
        matchMangaCodexAnimeRows([item], [detail]).has(itemId)) {
        return [itemId, row.pre2000Total ? row.commercial : detail.commercial];
      }
      return detail ? null : [itemId, row.commercial];
    } catch (error) {
      if (!isMissingDetail(error)) {
        errors.push("detail " + row.detailUrl + ": " + error.message);
      }
      return [itemId, row.commercial];
    }
  });
  for (const entry of parsed.filter(Boolean)) records.set(...entry);

  const missing = titles.filter((item) =>
    item.medium === "anime" && !records.has(item.id)
  );
  const searchCache = new Map();
  const searched = await mapConcurrent(missing, 4, (item) =>
    findViaSearch(item, "anime", asOf, searchCache, detailCache, errors)
  );
  for (let index = 0; index < missing.length; index += 1) {
    if (searched[index]) records.set(missing[index].id, searched[index]);
  }
  return { records, errors, pages };
}

export async function fetchMangaCodexManga(titles) {
  const asOf = dateOnly(new Date().toISOString());
  const errors = [];
  let ranking;
  try {
    ranking = await fetchPagedRows(
      MANGA_CIRCULATION_URL,
      parseMangaCodexCirculationPage,
      asOf,
    );
    errors.push(...ranking.errors);
  } catch (error) {
    ranking = { rows: [], pages: 0 };
    errors.push(error.message);
  }

  const matchedRows = matchMangaCodexMangaRows(titles, ranking.rows);
  const records = new Map();
  const titleById = new Map(titles.map((title) => [title.id, title]));
  const detailCache = new Map();
  const matchedEntries = [...matchedRows];
  const parsed = await mapConcurrent(matchedEntries, 4, async ([itemId, row]) => {
    const sourceUrl = new URL(row.detailUrl);
    sourceUrl.searchParams.set("hist_tab", "circulation");
    try {
      const url = sourceUrl.toString();
      if (!detailCache.has(url)) {
        detailCache.set(url, fetchText(url, { attempts: 2, timeoutMs: 30_000 }));
      }
      const detail = parseMangaCodexMangaDetail(
        await detailCache.get(url),
        url,
        asOf,
      );
      const item = titleById.get(itemId);
      if (!detail || !item ||
        !matchMangaCodexMangaRows([item], [detail]).has(itemId)) {
        return null;
      }
      return [itemId, detail.commercial.historyOnly ? row.commercial : detail.commercial];
    } catch (error) {
      if (!isMissingDetail(error)) {
        errors.push("detail " + row.detailUrl + ": " + error.message);
      }
      return null;
    }
  });
  for (const entry of parsed.filter(Boolean)) records.set(...entry);

  const missing = titles.filter((item) =>
    item.medium === "manga" && !records.has(item.id)
  );
  const searchCache = new Map();
  const searched = await mapConcurrent(missing, 4, (item) =>
    findViaSearch(item, "manga", asOf, searchCache, detailCache, errors)
  );
  for (let index = 0; index < missing.length; index += 1) {
    if (searched[index]) records.set(missing[index].id, searched[index]);
  }
  return { records, errors, pages: ranking.pages };
}
