import assert from "node:assert/strict";
import test from "node:test";
import { fetchBangumi } from "../scripts/lib/adapters/bangumi.mjs";
import { fetchMal } from "../scripts/lib/adapters/mal.mjs";

function title(id) {
  return {
    id: `anime:item-${id}`,
    medium: "anime",
    ids: { bangumi: id, mal: id, anilist: null },
  };
}

test("MAL adapter stops after a service-wide rejection", async () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.MAL_CLIENT_ID;
  let calls = 0;
  delete process.env.MAL_CLIENT_ID;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("forbidden", { status: 403, statusText: "Forbidden" });
  };

  try {
    const result = await fetchMal([title(1), title(2), title(3)]);
    assert.equal(calls, 1);
    assert.equal(result.ratings.size, 0);
    assert.equal(result.errors.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.MAL_CLIENT_ID;
    else process.env.MAL_CLIENT_ID = originalClientId;
  }
});

test("Bangumi adapter stops after a service-wide rejection", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("forbidden", { status: 403, statusText: "Forbidden" });
  };

  try {
    const result = await fetchBangumi([title(1), title(2), title(3)]);
    assert.equal(calls, 1);
    assert.equal(result.ratings.size, 0);
    assert.equal(result.errors.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
