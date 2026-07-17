import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateCatalog,
  validateEditorial,
  validateGenerated,
} from "./lib/validate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(root, relativePath), "utf8"));

const [config, titles, editorial, anime, manga, metadata] = await Promise.all([
  readJson("config/sources.json"),
  readJson("config/titles.json"),
  readJson("data/editorial.json"),
  readJson("public/data/anime.json"),
  readJson("public/data/manga.json"),
  readJson("public/data/metadata.json"),
]);

const errors = [
  ...validateCatalog(titles),
  ...validateEditorial(editorial, titles),
  ...validateGenerated([...anime, ...manga], config),
];

if (!metadata.generatedAt || !metadata.algorithmVersion) {
  errors.push("Metadata is incomplete");
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${anime.length} anime and ${manga.length} manga.`);
}
