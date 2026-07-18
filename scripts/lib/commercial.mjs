import { parseHTML } from "linkedom";
import { delay, fetchJson } from "./http.mjs";
import {
  fetchMangaCodexAnime,
  fetchMangaCodexManga,
} from "./mangacodex.mjs";

const EN_API = "https://en.wikipedia.org/w/api.php";
const JA_API = "https://ja.wikipedia.org/w/api.php";
const MANGA_PAGE = "List of best-selling manga";
const MANGA_PAGE_URL = "https://en.wikipedia.org/wiki/List_of_best-selling_manga";
const ANIME_ARCHIVE_AS_OF = "2021-09-07";
const ANIME_ARCHIVE_URL =
  "https://web.archive.org/web/20210907181831id_/https://www.someanithing.com/series-data-quick-view";
const ANIME_ANNUAL_URL =
  "https://w.atwiki.jp/wallofmasterpieces/pages/21.html";
const WAYBACK_AVAILABILITY_URL = "https://archive.org/wayback/available";

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
    item.wikidata?.articles?.ja,
    item.wikidata?.articles?.en,
  ].filter(Boolean))];
}

function archiveFormatCompatible(item, row) {
  const format = String(item.format || "").toLocaleUpperCase("en-US");
  if (row.kind === "series") return !/(MOVIE|FILM|OVA|OAD|剧场|劇場|映画)/u.test(format);
  return !/(TV|MOVIE|FILM|剧场|劇場|映画)/u.test(format);
}

function installmentNumbers(value) {
  const text = normalizeDigits(value).normalize("NFKC");
  const numbers = new Set();
  const patterns = [
    /(?:season|シーズン)\s*([1-9]\d?)/giu,
    /第\s*([1-9]\d?)\s*(?:期|季|シーズン|クール|部)/gu,
    /([1-9]\d?)(?:st|nd|rd|th)\s*(?:season|cour|part)/giu,
    /(?:part|cour|パート|クール)\s*([1-9]\d?)/giu,
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
  const partPatterns = [
    /(?:part|cour|パート|クール|parte|partie|teil)\s*[.:_-]?\s*([1-9]\d?)/giu,
    /第\s*([1-9]\d?)\s*(?:クール|部)/gu,
  ];
  for (const pattern of partPatterns) {
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

function archiveInstallmentCompatible(item, aliases, rowTitle) {
  const primary = splitInstallments([
    item.title?.zh,
    item.title?.original,
  ].filter(Boolean).join(" "));
  const rowSpecific = splitInstallments(rowTitle);
  if (primary.parts.size > 0 && !setsOverlap(primary.parts, rowSpecific.parts)) return false;
  if (primary.halves.size > 0 && !setsOverlap(primary.halves, rowSpecific.halves)) return false;

  const itemNumbers = new Set(aliases.flatMap((alias) => [...installmentNumbers(alias)]));
  const rowNumbers = installmentNumbers(rowTitle);
  if (itemNumbers.size === 0 && rowNumbers.size === 0) return true;
  if (itemNumbers.size === 0 || rowNumbers.size === 0) return true;
  return setsOverlap(itemNumbers, rowNumbers);
}

export function matchAnimeArchive(titles, rows) {
  const result = new Map();
  for (const item of titles.filter((title) => title.medium === "anime")) {
    const aliases = archiveAliases(item);
    const ranked = rows
      .filter((row) =>
        Math.abs(row.year - item.year) <= 1 &&
        archiveFormatCompatible(item, row) &&
        archiveInstallmentCompatible(item, aliases, row.title),
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

const MANGA_EDITION_MARKER =
  /(?:完全版|新装版|新裝版|文庫版|愛蔵版|愛藏版|爱藏版|豪華版|豪华版|ワイド版|復刻版|复刻版|kanzenban|perfect edition|complete edition|deluxe edition|collector'?s edition|omnibus edition?)/iu;
const MANGA_EDITION_MARKERS =
  /(?:完全版|新装版|新裝版|文庫版|愛蔵版|愛藏版|爱藏版|豪華版|豪华版|ワイド版|復刻版|复刻版|kanzenban|perfect edition|complete edition|deluxe edition|collector'?s edition|omnibus edition?)/giu;

function mangaAliases(item) {
  return [...new Set([
    ...(item.aliases || []),
    item.title?.zh,
    item.title?.original,
    item.wikidata?.articles?.ja,
    item.wikidata?.articles?.en,
  ].filter(Boolean))];
}

function editionBases(value) {
  const text = String(value || "").normalize("NFKC");
  if (!MANGA_EDITION_MARKER.test(text)) return [];
  const segments = text.split(MANGA_EDITION_MARKERS);
  const cleaned = text
    .replace(MANGA_EDITION_MARKERS, " ")
    .replace(/\bthe masterpiece\b/giu, " ");
  return [...new Set(
    [...segments, cleaned]
      .map((segment) => archiveTitle(segment))
      .filter((segment) => segment.length >= 3),
  )];
}

export function inheritMangaEditions(items, titles) {
  const titleById = new Map(titles.map((title) => [title.id, title]));
  const candidates = items
    .filter((item) => item.medium === "manga" && item.commercial)
    .map((item) => ({
      item,
      title: titleById.get(item.id),
    }))
    .filter((candidate) => candidate.title);
  let inherited = 0;

  for (const item of items) {
    if (item.medium !== "manga" || item.commercial) continue;
    const title = titleById.get(item.id);
    if (!title) continue;
    const bases = new Set(mangaAliases(title).flatMap(editionBases));
    if (bases.size === 0) continue;

    const matches = candidates.filter((candidate) =>
      mangaAliases(candidate.title).some((alias) => bases.has(archiveTitle(alias))),
    );
    const sources = new Map(
      matches.map((match) => [
        [
          match.item.commercial.sourceUrl,
          match.item.commercial.circulation,
          match.item.commercial.volumesAtAnnouncement,
        ].join("|"),
        match,
      ]),
    );
    if (sources.size !== 1) continue;

    const [{ item: source }] = sources.values();
    item.commercial = {
      ...source.commercial,
      scope: source.commercial.scope +
        "；该条目为完全版/再版，沿用原系列的发行量与原版卷数，非该版本单独销量",
      sourceLabel: source.commercial.sourceLabel + "（原系列映射）",
      inheritedFrom: {
        id: source.id,
        title: source.title.zh,
      },
    };
    inherited += 1;
  }

  return inherited;
}

async function fetchAnimeArchive(titles) {
  const html = await fetchText(ANIME_ARCHIVE_URL);
  return matchAnimeArchive(titles, parseAnimeArchive(html));
}

function annualTitle(value) {
  return String(value || "")
    .replace(/\s*[（(][^（）()]*巻[^（）()]*[）)]\s*$/u, "")
    .replace(/\s*[（(]※[^（）()]*枚[^（）()]*[）)]\s*$/u, "")
    .trim();
}

function hasAnnualRows(html) {
  return /○\s*20\d{2}年TVアニメ/u.test(String(html || "")) &&
    !/<title>\s*Just a moment/iu.test(String(html || ""));
}

async function latestWaybackUrl(target) {
  const data = await fetchJson(queryUrl(WAYBACK_AVAILABILITY_URL, { url: target }), {
    attempts: 2,
    timeoutMs: 20_000,
  });
  const snapshot = data.archived_snapshots?.closest;
  if (!snapshot?.available || snapshot.status !== "200" || !/^\d{14}$/.test(snapshot.timestamp)) {
    throw new Error("No usable Wayback snapshot for annual anime disc sales");
  }
  return "https://web.archive.org/web/" + snapshot.timestamp + "id_/" + target;
}

export function parseAnimeAnnual(html, sourceUrl = ANIME_ANNUAL_URL) {
  const normalized = String(html || "").replace(/<br\s*\/?>/giu, "\n");
  const { document } = parseHTML(normalized);
  const body = document.querySelector("#wikibody");
  if (!body) return [];

  const modifiedAt = document.querySelector("time[datetime]")?.getAttribute("datetime");
  const asOf = /^\d{4}-\d{2}-\d{2}/.exec(modifiedAt || "")?.[0] || dateOnly(modifiedAt);
  const sourceLabel = sourceUrl.includes("web.archive.org")
    ? "ATWiki 年度销量榜（Internet Archive）"
    : "ATWiki 年度销量榜";
  const records = [];
  let year = null;

  for (const rawLine of body.textContent.split(/\n+/u)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const heading = line.match(/^○\s*(20\d{2})年TVアニメ/u);
    if (heading) {
      year = Number(heading[1]);
      continue;
    }
    if (!year) continue;

    const match = line.match(/^\([^)]+\)\s*\*?\s*([\d,]+(?:\.\d+)?)\s+(.+)$/u);
    const unitsPerVolume = Math.round(Number(match?.[1]?.replaceAll(",", "")));
    const title = annualTitle(match?.[2]);
    if (!title || !Number.isInteger(unitsPerVolume) || unitsPerVolume <= 0) continue;

    records.push({
      title,
      year,
      kind: "series",
      commercial: {
        metric: "bd-dvd-average",
        unitsPerVolume,
        releaseCount: null,
        asOf,
        scope: "日本 TV 动画 BD/DVD 累计单卷平均销量（年度榜单）",
        sourceUrl,
        sourceLabel,
      },
    });
  }

  return records;
}

async function fetchAnimeAnnual(titles) {
  let sourceUrl = ANIME_ANNUAL_URL;
  let html = null;

  try {
    html = await fetchText(sourceUrl, { attempts: 1, timeoutMs: 15_000 });
  } catch {
    html = null;
  }

  if (!hasAnnualRows(html)) {
    sourceUrl = await latestWaybackUrl(ANIME_ANNUAL_URL);
    html = await fetchText(sourceUrl, { attempts: 2, timeoutMs: 30_000 });
  }
  if (!hasAnnualRows(html)) {
    throw new Error("Annual anime disc sales page did not contain ranking rows");
  }

  return matchAnimeArchive(titles, parseAnimeAnnual(html, sourceUrl));
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

async function fetchJapaneseArticles(items) {
  const result = new Map();
  for (let offset = 0; offset < items.length; offset += 40) {
    if (offset > 0) await delay(250);
    const batch = items.slice(offset, offset + 40);
    const data = await fetchJson(queryUrl(JA_API, {
      action: "query",
      prop: "revisions",
      rvprop: "timestamp|content",
      rvslots: "main",
      redirects: "1",
      titles: batch.map((item) => item.title).join("|"),
      format: "json",
      formatversion: "2",
    }), { attempts: 3, timeoutMs: 30_000 });
    const aliases = canonicalTitleMap(data.query || {});
    const requested = new Map();
    for (const item of batch) {
      const key = pageKey(resolvePageTitle(item.title, aliases));
      if (!requested.has(key)) requested.set(key, []);
      requested.get(key).push(item);
    }
    for (const page of data.query?.pages || []) {
      const matches = requested.get(pageKey(page.title)) || [];
      const revision = page.revisions?.[0];
      const content = revision?.slots?.main?.content ?? revision?.content;
      if (!content) continue;
      for (const item of matches) {
        result.set(item.key, {
          title: page.title,
          content,
          timestamp: revision.timestamp,
        });
      }
    }
  }
  return result;
}

function normalizeDigits(value) {
  return String(value || "").replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

function plainWikitext(value) {
  let text = normalizeDigits(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/giu, " ")
    .replace(/<ref\b[^>]*\/>/giu, " ")
    .replace(/\{\{\s*formatnum\s*:\s*([^{}|]+)[^{}]*\}\}/giu, "$1")
    .replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/giu, "$1")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/'{2,}/g, "");
  for (let index = 0; index < 4; index += 1) {
    text = text.replace(/\{\{[^{}]*\}\}/g, " ");
  }
  return text;
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

function reportedCopies(sentence) {
  const normalized = normalizeDigits(sentence).replaceAll(",", "");
  const values = [];
  for (const match of normalized.matchAll(
    /(?:(\d+(?:\.\d+)?)\s*億)?\s*(?:(\d+(?:\.\d+)?)\s*万)?\s*部/gu,
  )) {
    if (!match[1] && !match[2]) continue;
    const value = Number(match[1] || 0) * 100_000_000 +
      Number(match[2] || 0) * 10_000;
    if (Number.isFinite(value) && value > 0) values.push(Math.round(value));
  }
  for (const match of normalized.matchAll(/(\d{5,})\s*部/gu)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(Math.round(value));
  }
  return values.length ? Math.max(...values) : null;
}

function circulationDate(sentence) {
  const dates = [...normalizeDigits(sentence).matchAll(
    /((?:19|20)\d{2})年(?:(\d{1,2})月)?(?:\d{1,2}日)?(?:時点|現在)/gu,
  )].map((match) => ({
    year: Number(match[1]),
    month: Number(match[2] || 1),
  }));
  dates.sort((left, right) => right.year - left.year || right.month - left.month);
  const date = dates[0];
  return date
    ? String(date.year) + "-" + String(date.month).padStart(2, "0") + "-01"
    : null;
}

function completedPublication(publication) {
  return Number.isInteger(publication?.volumes) &&
    publication.volumes > 0 &&
    Number.isInteger(publication?.endYear) &&
    /(?:FINISHED|Finished|Completed|完結)/iu.test(publication?.status || "");
}

export function extractMangaCirculation(text, publication) {
  if (!completedPublication(publication)) return null;
  const finalVolumePattern = new RegExp(
    "全\\s*" + publication.volumes + "\\s*巻",
    "u",
  );
  const candidates = [];

  for (const sentence of plainWikitext(text).split(/(?<=[。.!?])\s*|\n+/u)) {
    if (!/累計発行部数/u.test(sentence)) continue;
    if (/シリーズ累計発行部数/u.test(sentence)) continue;
    const circulation = reportedCopies(sentence);
    if (!circulation) continue;

    const statementDate = circulationDate(sentence);
    const statementYear = Number(statementDate?.slice(0, 4));
    const usesFinalVolumes = finalVolumePattern.test(sentence);
    if (!usesFinalVolumes && (!statementYear || statementYear < publication.endYear)) {
      continue;
    }

    candidates.push({
      circulation,
      volumesAtAnnouncement: publication.volumes,
      perVolume: Math.round(circulation / publication.volumes),
      statementDate,
      includesDigital: /電子(?:版|書籍|コミック)/u.test(sentence) ? true : null,
      scope: sentence.replace(/\s+/g, " ").trim().slice(0, 280),
    });
  }

  return candidates.sort((left, right) =>
    Date.parse(right.statementDate || 0) - Date.parse(left.statementDate || 0) ||
    right.circulation - left.circulation
  )[0] || null;
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

async function fetchMangaArticleCommercial(titles) {
  const articleItems = titles
    .filter((item) =>
      item.medium === "manga" &&
      item.wikidata?.id &&
      item.wikidata.articles?.ja &&
      completedPublication(item.publication),
    )
    .map((item) => ({
      key: item.id,
      qid: item.wikidata.id,
      title: item.wikidata.articles.ja,
      publication: item.publication,
    }));
  const articles = await fetchJapaneseArticles(articleItems);
  const result = new Map();

  for (const item of articleItems) {
    const article = articles.get(item.key);
    if (!article) continue;
    const sales = extractMangaCirculation(article.content, item.publication);
    if (!sales) continue;
    result.set(item.qid, {
      metric: "circulation-per-volume",
      circulation: sales.circulation,
      volumesAtAnnouncement: sales.volumesAtAnnouncement,
      perVolume: sales.perVolume,
      asOf: sales.statementDate || dateOnly(article.timestamp),
      scope: sales.scope,
      includesDigital: sales.includesDigital,
      sourceUrl: "https://ja.wikipedia.org/wiki/" +
        encodeURIComponent(article.title.replaceAll(" ", "_")),
      sourceLabel: "Wikipedia - " + article.title,
    });
  }

  return result;
}

async function fetchAnimeCommercial(titles) {
  const articleItems = titles
    .filter((item) => item.medium === "anime" && item.wikidata?.id && item.wikidata.articles?.ja)
    .map((item) => ({
      key: item.id,
      qid: item.wikidata.id,
      title: item.wikidata.articles.ja,
    }));
  const articles = await fetchJapaneseArticles(articleItems);
  const result = new Map();

  for (const item of articleItems) {
    const article = articles.get(item.key);
    if (!article) continue;
    const sales = extractDiscSales(plainWikitext(article.content));
    if (!sales?.unitsPerVolume) continue;
    result.set(item.qid, {
      metric: "bd-dvd-average",
      unitsPerVolume: sales.unitsPerVolume,
      releaseCount: null,
      asOf: dateOnly(article.timestamp),
      scope: sales.scope,
      sourceUrl: "https://ja.wikipedia.org/wiki/" +
        encodeURIComponent(article.title.replaceAll(" ", "_")),
      sourceLabel: "Wikipedia - " + article.title,
    });
  }
  return result;
}

export function mergeCommercialMaps(...maps) {
  const result = new Map();
  for (const records of maps) {
    for (const [key, incoming] of records) {
      const existing = result.get(key);
      if (!existing) {
        result.set(key, incoming);
        continue;
      }
      const incomingDate = Date.parse(incoming.asOf || 0);
      const existingDate = Date.parse(existing.asOf || 0);
      const incomingValue = incoming.circulation || incoming.unitsPerVolume || 0;
      const existingValue = existing.circulation || existing.unitsPerVolume || 0;
      if (incomingDate > existingDate ||
        (incomingDate === existingDate && incomingValue > existingValue)) {
        result.set(key, incoming);
      }
    }
  }
  return result;
}

function mangaCodexSource(outcome, value) {
  if (outcome.status === "rejected") {
    return {
      status: "error",
      received: 0,
      pages: 0,
      message: outcome.reason?.message || String(outcome.reason),
    };
  }
  return {
    status: value.errors.length === 0
      ? "ok"
      : value.records.size > 0 ? "partial" : "error",
    received: value.records.size,
    pages: value.pages,
    message: value.errors[0] || null,
  };
}

export async function fetchCommercialData(titles) {
  const settled = await Promise.allSettled([
    fetchMangaCodexManga(titles),
    fetchMangaCodexAnime(titles),
    fetchMangaCommercial(),
    fetchMangaArticleCommercial(titles),
    fetchAnimeCommercial(titles),
    fetchAnimeArchive(titles),
    fetchAnimeAnnual(titles),
  ]);
  const mangaCodexManga = settled[0].status === "fulfilled"
    ? settled[0].value
    : { records: new Map(), errors: [], pages: 0 };
  const mangaCodexAnime = settled[1].status === "fulfilled"
    ? settled[1].value
    : { records: new Map(), errors: [], pages: 0 };
  const [manga, mangaWiki, animeWiki, animeArchive, animeAnnual] = settled.slice(2).map((result) =>
    result.status === "fulfilled" ? result.value : new Map(),
  );
  return {
    primaryByTitleId: new Map([
      ...mangaCodexManga.records,
      ...mangaCodexAnime.records,
    ]),
    byWikidata: mergeCommercialMaps(manga, mangaWiki, animeWiki),
    byTitleId: new Map([...animeArchive, ...animeAnnual]),
    sources: {
      mangaCodexManga: mangaCodexSource(settled[0], mangaCodexManga),
      mangaCodexAnime: mangaCodexSource(settled[1], mangaCodexAnime),
      manga: {
        status: settled[2].status === "fulfilled" ? "ok" : "error",
        received: manga.size,
        message: settled[2].status === "rejected" ? settled[2].reason.message : null,
      },
      mangaWiki: {
        status: settled[3].status === "fulfilled" ? "ok" : "error",
        received: mangaWiki.size,
        message: settled[3].status === "rejected" ? settled[3].reason.message : null,
      },
      animeWiki: {
        status: settled[4].status === "fulfilled" ? "ok" : "error",
        received: animeWiki.size,
        message: settled[4].status === "rejected" ? settled[4].reason.message : null,
      },
      animeArchive: {
        status: settled[5].status === "fulfilled" ? "ok" : "error",
        received: animeArchive.size,
        message: settled[5].status === "rejected" ? settled[5].reason.message : null,
      },
      animeAnnual: {
        status: settled[6].status === "fulfilled" ? "ok" : "error",
        received: animeAnnual.size,
        message: settled[6].status === "rejected" ? settled[6].reason.message : null,
      },
    },
  };
}
