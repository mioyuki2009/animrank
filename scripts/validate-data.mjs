import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateCatalog,
  validateCatalogConfig,
  validateEditorial,
  validateGenerated,
} from "./lib/validate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));

const [config, catalogConfig, editorial, anime, manga, metadata, catalog] = await Promise.all([
  readJson("config/sources.json"),
  readJson("config/catalog.json"),
  readJson("data/editorial.json"),
  readJson("public/data/anime.json"),
  readJson("public/data/manga.json"),
  readJson("public/data/metadata.json"),
  readJson("public/data/catalog.json"),
]);

const errors = [
  ...validateCatalogConfig(catalogConfig),
  ...validateCatalog(catalog),
  ...validateEditorial(editorial, catalog),
  ...validateGenerated([...anime, ...manga], config),
];

for (const medium of ["anime", "manga"]) {
  const catalogCount = catalog.filter((item) => item.medium === medium).length;
  const generatedCount = (medium === "anime" ? anime : manga).length;
  if (catalogCount !== catalogConfig[medium]) {
    errors.push(
      `Catalog contains ${catalogCount} ${medium} entries; expected ${catalogConfig[medium]}`,
    );
  }
  if (generatedCount !== catalogConfig[medium]) {
    errors.push(
      `Generated data contains ${generatedCount} ${medium} entries; expected ${catalogConfig[medium]}`,
    );
  }
}

if (!metadata.generatedAt || !metadata.algorithmVersion) {
  errors.push("Metadata is incomplete");
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${anime.length} anime and ${manga.length} manga.`);
}
