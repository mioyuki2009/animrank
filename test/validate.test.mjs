import assert from "node:assert/strict";
import test from "node:test";
import { validateCatalog, validateEditorial } from "../scripts/lib/validate.mjs";

const title = {
  id: "anime:example",
  medium: "anime",
  title: { zh: "示例", original: "Example" },
  year: 2020,
  format: "TV",
  ids: { bangumi: 1, mal: 2, anilist: null },
};

test("valid catalog entries accept explicit null platform ids", () => {
  assert.deepEqual(validateCatalog([title]), []);
});

test("duplicate ids and invalid platform ids are rejected", () => {
  const invalid = structuredClone(title);
  invalid.ids.mal = "2";
  const errors = validateCatalog([invalid, invalid]);
  assert.ok(errors.some((error) => error.includes("Duplicate")));
  assert.ok(errors.some((error) => error.includes("Invalid mal")));
});

test("editorial manga records require a dated source and same-date volume count", () => {
  const manga = {
    ...title,
    id: "manga:example",
    medium: "manga",
  };
  const errors = validateEditorial(
    {
      anime: {},
      manga: {
        "manga:example": {
          circulation: 1000,
          volumesAtAnnouncement: 0,
          asOf: "today",
          sourceUrl: "not-a-url",
        },
      },
    },
    [manga],
  );
  assert.equal(errors.length, 3);
});
