import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheCoverAssets } from "../scripts/lib/covers.mjs";

test("cover assets are downloaded once and reused from the static cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fanrank-covers-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  };

  try {
    const first = [{
      id: "anime:example",
      cover: {
        url: "https://images.example/cover.jpg",
        source: "anilist",
        color: "#123456",
      },
    }];
    const firstStats = await cacheCoverAssets(first, { dataDir: directory, concurrency: 1 });
    assert.equal(firstStats.downloaded, 1);
    assert.equal(first[0].cover.url, "./data/covers/anime-example.jpg");
    assert.equal(first[0].cover.remoteUrl, "https://images.example/cover.jpg");

    const second = [{
      id: "anime:example",
      cover: {
        url: "https://images.example/cover.jpg",
        source: "anilist",
      },
    }];
    const secondStats = await cacheCoverAssets(second, { dataDir: directory, concurrency: 1 });
    assert.equal(secondStats.reused, 1);
    assert.equal(requests, 1);

    const index = JSON.parse(await readFile(path.join(directory, "covers.json"), "utf8"));
    assert.equal(index.covers["anime:example"].contentType, "image/jpeg");

    const replacement = [{
      id: "anime:replacement",
      cover: { url: "https://images.example/replacement.jpg", source: "mal" },
    }];
    const replacementStats = await cacheCoverAssets(replacement, {
      dataDir: directory,
      concurrency: 1,
    });
    assert.equal(replacementStats.removed, 1);
    await assert.rejects(
      readFile(path.join(directory, "covers", "anime-example.jpg")),
      { code: "ENOENT" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
