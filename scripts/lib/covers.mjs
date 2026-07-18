import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delay } from "./http.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultDataDir = path.join(root, "public", "data");
const extensions = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function remoteCandidates(cover) {
  const candidates = [
    ...(Array.isArray(cover?.alternatives) ? cover.alternatives : []),
    cover?.remoteUrl || cover?.url
      ? {
          url: cover.remoteUrl || cover.url,
          source: cover.source || null,
          color: cover.color || null,
        }
      : null,
  ];
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate?.url || !/^https?:\/\//i.test(candidate.url) || seen.has(candidate.url)) {
      return false;
    }
    seen.add(candidate.url);
    return true;
  });
}

async function fetchImage(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
          "User-Agent": `FanRank/0.3 (${process.env.PROJECT_HOMEPAGE || "local-development"})`,
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const extension = extensions.get(contentType);
      if (!extension) throw new Error(`unsupported content type ${contentType || "unknown"}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 5_000_000) {
        throw new Error(`invalid image size ${bytes.length}`);
      }
      return { bytes, contentType, extension };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt === 0) await delay(500);
  }
  throw new Error(`cover download failed for ${url}: ${lastError?.message || "unknown error"}`);
}

function publicCover(entry) {
  return {
    url: entry.path,
    remoteUrl: entry.remoteUrl,
    color: entry.color || null,
    source: entry.source || null,
  };
}

async function cachedEntry(entry, coverDir) {
  if (!entry?.file || !entry.path) return null;
  return (await fileExists(path.join(coverDir, entry.file))) ? entry : null;
}

async function cacheOne(item, previous, coverDir) {
  const candidates = remoteCandidates(item.cover);
  const existing = await cachedEntry(previous, coverDir);
  const matchingExisting = existing && candidates.some(
    (candidate) => candidate.url === existing.remoteUrl,
  );
  if (matchingExisting || (existing && candidates.length === 0)) {
    return { item, entry: existing, outcome: "reused" };
  }
  if (!existing && candidates.length === 0 && !item.cover) {
    return { item, entry: null, outcome: "missing", errors: [] };
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      const image = await fetchImage(candidate.url);
      const file = `${safeId(item.id)}${image.extension}`;
      await writeFile(path.join(coverDir, file), image.bytes);
      return {
        item,
        entry: {
          file,
          path: `./data/covers/${file}`,
          remoteUrl: candidate.url,
          contentType: image.contentType,
          source: candidate.source || item.cover?.source || null,
          color: candidate.color || item.cover?.color || null,
        },
        outcome: "downloaded",
      };
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (existing) return { item, entry: existing, outcome: "reused" };
  return { item, entry: null, outcome: "failed", errors };
}

export async function cacheCoverAssets(items, { dataDir = defaultDataDir, concurrency = 8 } = {}) {
  const coverDir = path.join(dataDir, "covers");
  const indexPath = path.join(dataDir, "covers.json");
  await mkdir(coverDir, { recursive: true });
  const previousIndex = await readJson(indexPath, { covers: {} });
  const previous = previousIndex.covers || {};
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      results[index] = await cacheOne(item, previous[item.id], coverDir);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker),
  );

  const covers = {};
  const stats = {
    available: 0,
    downloaded: 0,
    reused: 0,
    failed: 0,
    missing: 0,
    removed: 0,
  };
  for (const result of results) {
    stats[result.outcome] += 1;
    if (result.entry) {
      covers[result.item.id] = result.entry;
      result.item.cover = publicCover(result.entry);
      stats.available += 1;
    } else if (result.item.cover) {
      const { alternatives, ...cover } = result.item.cover;
      result.item.cover = cover;
    }
  }

  const activeFiles = new Set(Object.values(covers).map((entry) => entry.file));
  const managedExtensions = new Set(extensions.values());
  const obsoleteFiles = (await readdir(coverDir)).filter((file) =>
    managedExtensions.has(path.extname(file).toLocaleLowerCase("en-US")) &&
    !activeFiles.has(file),
  );
  await Promise.all(obsoleteFiles.map(async (file) => {
    try {
      await unlink(path.join(coverDir, file));
      stats.removed += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }));

  await writeFile(
    indexPath,
    `${JSON.stringify({ version: 1, covers }, null, 2)}\n`,
    "utf8",
  );
  return stats;
}
