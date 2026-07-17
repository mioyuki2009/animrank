import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const outputDir = path.join(root, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(publicDir, outputDir, { recursive: true });
await writeFile(path.join(outputDir, ".nojekyll"), "", "utf8");

console.log(`Built static site in ${outputDir}`);
