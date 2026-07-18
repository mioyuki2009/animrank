import { parseHTML } from "linkedom";
import { delay, fetchJson } from "./http.mjs";

const EN_API = "https://en.wikipedia.org/w/api.php";
const JA_API = "https://ja.wikipedia.org/w/api.php";
const MANGA_PAGE = "List of best-selling manga";
const MANGA_PAGE_URL = "https://en.wikipedia.org/wiki/List_of_best-selling_manga";
const ANIME_ARCHIVE_AS_OF = "2021-09-07";
const ANIME_ARCHIVE_URL =
  "https://web.archive.org/web/20210907181831id_/https://www.someanithing.com/series-data-quick-view";

function pageKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replaceAll("_", " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function queryUrl(endpoint, parameters) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function dateOnly(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
}

function canonicalTitleMap(query) {
  const aliases = new Map();
  for (const item of [...(query.normalized || []), ...(query.redirects || [])]) {
    aliases.set(pageKey(item.from), item.to);
  }
  return aliases;
}

function resolvePageTitle(title, aliases) {
  let current = title;
  const seen = new Set();
  while (aliases.has(pageKey(current)) && !seen.has(pageKey(current))) {
    seen.add(pageKey(current));
    current = aliases.get(pageKey(current));
  }
  return current;
}

async function fetchPageQids(pageTitles) {
  const result = new Map();
  const unique = [...new Set(pageTitles.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const batch = unique.slice(offset, offset + 50);
    const data = await fetchJson(queryUrl(EN_API, {
      action: "query",
      prop: "pageprops",
      ppprop: "wikibase_item",
      redirects: "1",
      titles: batch.join("|"),
      format: "json",
      formatversion: "2",
    }), { attempts: 2, timeoutMs: 20_000 });
    const aliases = canonicalTitleMap(data.query || {});
    const byTitle = new Map(
      (data.query?.pages || []).map((page) => [pageKey(page.title), page.pageprops?.wikibase_item]),
    );
    for (const title of batch) {
      const canonical = resolvePageTitle(title, aliases);
      const qid = byTitle.get(pageKey(canonical));
      if (qid) result.set(title, qid);
    }
  }
  return result;
}

function parseInteger(value) {
  const match = String(value || "").replaceAll(",", "").match(/\d+/);
  const number = Number(match?.[0]);
  return Number.isInteger(number) && number > 0 ? number : null;
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
          "User-Agent": `FanRank/0.3 (${process.env.PROJECT_HOMEPAGE || "local-development"})`,
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts - 1) await delay(750);
  }
  throw new Error(`Unable to fetch ${url}: ${lastError?.message || "unknown error"}`);
}

export function parseMangaRows(html, asOf) {
  const { document } = parseHTML(html);
  const rows = [];

  for (const table of document.querySelectorAll("table.wikitable")) {
    const headers = [...table.querySelectorAll("tr:first-child th")].map((cell) =>
      cell.textContent.replace(/\s+/g, "").trim().toLocaleLowerCase("en-US"),
    );
    const titleIndex = headers.findIndex((header) => header === "mangaseries");
    const volumeIndex = headers.findIndex((header) => header.startsWith("no.ofcollected"));
    const salesIndex = headers.findIndex((header) => header === "approximatesales");
    if (titleIndex < 0 || volumeIndex < 0 || salesIndex < 0) continue;

    for (const row of table.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll(":scope > td")];
      if (cells.length <= Math.max(titleIndex, volumeIndex, salesIndex)) continue;
      const link = cells[titleIndex].querySelector("a[title]");
      const pageTitle = link?.getAttribute("title");
      const volumes = parseInteger(cells[volumeIndex].textContent);
      const reportedThousands = Number(cells[salesIndex].getAttribute("data-sort-value"));
      const circulation = Number.isFinite(reportedThousands) && reportedThousands > 0
        ? Math.round(reportedThousands * 1000)
        : null;
      if (!pageTitle || !volumes || !circulation) continue;
      rows.push({
        pageTitle,
        commercial: {
          metric: "circulation-per-volume",
          circulation,
          volumesAtAnnouncement: volumes,
          perVolume: Math.round(circulation / volumes),
          asOf,
          scope: "Wikipedia 畅销漫画表中的近似销量/发行量与同一行单行本卷数",
          includesDigital: cells[salesIndex].textContent.includes("‡") ? true : null,
          sourceUrl: MANGA_PAGE_URL,
          sourceLabel: "Wikipedia - List of best-selling manga",
        },
      });
    }
  }
  return rows;
}

function archiveTitle(value) {
  return String(value || "")
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
  const a = archiveTitle(left);
  const b = archiveTitle(right);
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

export function parseAnimeArchive(html, asOf = ANIME_ARCHIVE_AS_OF) {
  const { document } = parseHTML(html);
  const records = [];

  for (const [tableIndex, table] of [...document.querySelectorAll("table")].entries()) {
    const headerCells = [...table.querySelectorAll("tr:first-child th")];
    const headers = headerCells.map((cell) =>
      cell.textContent.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US"),
    );
    const titleIndex = headers.indexOf("title");
    const yearIndex = headers.indexOf("year");
    const totalIndex = headers.indexOf("total");
    const averageIndex = headers.indexOf("average sales");
    const salesIndex = totalIndex >= 0 ? totalIndex : averageIndex;
    if (titleIndex < 0 || yearIndex < 0 || salesIndex < 0) continue;

    for (const row of table.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll(":scope > td")];
      if (cells.length <= Math.max(titleIndex, yearIndex, salesIndex)) continue;
      const title = cells[titleIndex].textContent.replace(/\s+/g, " ").trim();
      const year = parseInteger(cells[yearIndex].textContent);
      const unitsPerVolume = parseInteger(cells[salesIndex].textContent);
      if (!title || !year || !unitsPerVolume) continue;
      records.push({
        title,
        year,
        kind: tableIndex === 0 ? "series" : "ova",
        commercial: {
          metric: "bd-dvd-average",
          unitsPerVolume,
          releaseCount: null,
          asOf,
          scope: totalIndex >= 0
            ? "日本实体动画 BD/DVD 单卷平均销量，采用含再发行的 Total 列"
            : "日本实体 OVA/特别篇 BD/DVD 单卷平均销量",
          sourceUrl: ANIME_ARCHIVE_URL,
          sourceLabel: "Someanithing Series Data - Quick View (Internet Archive)",
        },
      });
    }
  }
  return records;
}

function archiveAliases(item) {
  return [...new Set([
    ...(item.aliases || []),
    item.title?.zh,
    item.title?.original,
  ].filter(Boolean))];
}

function archiveFormatCompatible(item, row) {
  const format = String(item.format || "").toLocaleUpperCase("en-US");
  if (row.kind === "series") return !/(MOVIE|FILM|OVA|OAD|剧场|劇場|映画)/u.test(format);
  return !/(TV|MOVIE|FILM|剧场|劇場|映画)/u.test(format);
}

export function matchAnimeArchive(titles, rows) {
  const result = new Map();
  for (const item of titles.filter((title) => title.medium === "anime")) {
    const aliases = archiveAliases(item);
    const ranked = rows
      .filter((row) =>
        Math.abs(row.year - item.year) <= 1 && archiveFormatCompatible(item, row),
      )
      .map((row) => ({
        row,
        score: Math.max(...aliases.map((alias) => titleSimilarity(alias, row.title))),
      }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const margin = best ? best.score - (ranked[1]?.score || 0) : 0;
    if (!best || best.score < 0.88 || (best.score < 1 && margin < 0.06)) continue;
    result.set(item.id, best.row.commercial);
  }
  return result;
}

async function fetchAnimeArchive(titles) {
  const html = await fetchText(ANIME_ARCHIVE_URL);
  return matchAnimeArchive(titles, parseAnimeArchive(html));
}

async function fetchMangaCommercial() {
  const parsed = await fetchJson(queryUrl(EN_API, {
    action: "parse",
    page: MANGA_PAGE,
    prop: "text|revid",
    format: "json",
    formatversion: "2",
  }), { attempts: 2, timeoutMs: 25_000 });
  const revision = await fetchJson(queryUrl(EN_API, {
    action: "query",
    prop: "revisions",
    revids: String(parsed.parse.revid),
    rvprop: "timestamp",
    format: "json",
    formatversion: "2",
  }), { attempts: 2, timeoutMs: 15_000 });
  const asOf = dateOnly(revision.query?.pages?.[0]?.revisions?.[0]?.timestamp);
  const rows = parseMangaRows(parsed.parse.text, asOf);
  const qids = await fetchPageQids(rows.map((row) => row.pageTitle));
  return new Map(
    rows
      .map((row) => [qids.get(row.pageTitle), row.commercial])
      .filter(([qid]) => Boolean(qid)),
  );
}

function normalizeDigits(value) {
  return String(value || "").replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

function reportedUnits(sentence) {
  const normalized = normalizeDigits(sentence).replaceAll(",", "");
  const values = [];
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*万\s*(\d+)?\s*枚/g)) {
    values.push(Math.round(Number(match[1]) * 10_000 + Number(match[2] || 0)));
  }
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(million|thousand)?\s*(?:copies|units|枚)/gi)) {
    let value = Number(match[1]);
    if (match[2]?.toLowerCase() === "million") value *= 1_000_000;
    if (match[2]?.toLowerCase() === "thousand") value *= 1000;
    if (Number.isFinite(value)) values.push(Math.round(value));
  }
  return values.length ? Math.max(...values) : null;
}

export function extractDiscSales(text) {
  const sentences = String(text || "").split(/(?<=[。.!?])\s*|\n+/u);
  const candidates = [];
  for (const sentence of sentences) {
    if (!/(?:Blu-?ray|ブルーレイ|\bBD\b|\bDVD\b|BD\/DVD)/iu.test(sentence)) continue;
    if (!/(?:総売上|累計|合計|平均|combined|cumulative|total|average|per[ -]volume)/iu.test(sentence)) {
      continue;
    }
    const unitsTotal = reportedUnits(sentence);
    if (!unitsTotal) continue;
    const average = /(?:平均|average|per[ -]volume)/iu.test(sentence);
    candidates.push({
      ...(average ? { unitsPerVolume: unitsTotal } : { unitsTotal }),
      scope: sentence.replace(/\s+/g, " ").trim().slice(0, 280),
    });
  }
  return candidates.sort(
    (left, right) =>
      (right.unitsPerVolume || right.unitsTotal) -
      (left.unitsPerVolume || left.unitsTotal),
  )[0] || null;
}

async function fetchAnimeCommercial(titles) {
  const articleItems = titles
    .filter((item) => item.medium === "anime" && item.wikidata?.id && item.wikidata.articles?.ja)
    .map((item) => ({ qid: item.wikidata.id, title: item.wikidata.articles.ja }));
  const result = new Map();

  for (let offset = 0; offset < articleItems.length; offset += 20) {
    const batch = articleItems.slice(offset, offset + 20);
    const data = await fetchJson(queryUrl(JA_API, {
      action: "query",
      prop: "extracts|revisions",
      explaintext: "1",
      rvprop: "timestamp",
      redirects: "1",
      titles: batch.map((item) => item.title).join("|"),
      format: "json",
      formatversion: "2",
    }), { attempts: 2, timeoutMs: 25_000 });
    const aliases = canonicalTitleMap(data.query || {});
    const requested = new Map(
      batch.map((item) => [pageKey(resolvePageTitle(item.title, aliases)), item]),
    );
    for (const page of data.query?.pages || []) {
      const item = requested.get(pageKey(page.title));
      if (!item) continue;
      const sales = extractDiscSales(page.extract);
      if (!sales?.unitsPerVolume) continue;
      result.set(item.qid, {
        metric: "bd-dvd-average",
        unitsPerVolume: sales.unitsPerVolume,
        releaseCount: null,
        asOf: dateOnly(page.revisions?.[0]?.timestamp),
        scope: sales.scope,
        sourceUrl: `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(" ", "_"))}`,
        sourceLabel: `Wikipedia - ${page.title}`,
      });
    }
  }
  return result;
}

export async function fetchCommercialData(titles) {
  const settled = await Promise.allSettled([
    fetchMangaCommercial(),
    fetchAnimeCommercial(titles),
    fetchAnimeArchive(titles),
  ]);
  const [manga, animeWiki, animeArchive] = settled.map((result) =>
    result.status === "fulfilled" ? result.value : new Map(),
  );
  return {
    byWikidata: new Map([...manga, ...animeWiki]),
    byTitleId: animeArchive,
    sources: {
      manga: {
        status: settled[0].status === "fulfilled" ? "ok" : "error",
        received: manga.size,
        message: settled[0].status === "rejected" ? settled[0].reason.message : null,
      },
      animeWiki: {
        status: settled[1].status === "fulfilled" ? "ok" : "error",
        received: animeWiki.size,
        message: settled[1].status === "rejected" ? settled[1].reason.message : null,
      },
      animeArchive: {
        status: settled[2].status === "fulfilled" ? "ok" : "error",
        received: animeArchive.size,
        message: settled[2].status === "rejected" ? settled[2].reason.message : null,
      },
    },
  };
}
