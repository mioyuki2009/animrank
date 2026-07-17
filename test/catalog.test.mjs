import assert from "node:assert/strict";
import test from "node:test";
import {
  commercialValue,
  filterAndSort,
  isOlderThan,
} from "../public/assets/catalog.js";

const items = [
  {
    id: "anime:alpha",
    medium: "anime",
    title: { zh: "甲", original: "Alpha" },
    year: 2000,
    format: "TV",
    score: { value: 8, sourceCount: 3, status: "ranked" },
    commercial: { unitsPerVolume: 1000 },
  },
  {
    id: "anime:beta",
    medium: "anime",
    title: { zh: "乙", original: "Beta" },
    year: 2020,
    format: "MOVIE",
    score: { value: null, sourceCount: 1, status: "single-source" },
    commercial: null,
  },
  {
    id: "anime:gamma",
    medium: "anime",
    title: { zh: "丙", original: "Gamma" },
    year: 2010,
    format: "OVA",
    score: { value: 9, sourceCount: 2, status: "ranked" },
    commercial: { unitsPerVolume: 500 },
  },
];

test("search covers translated title, original title, year and format", () => {
  assert.deepEqual(filterAndSort(items, { search: "beta" }).map((item) => item.id), ["anime:beta"]);
  assert.deepEqual(filterAndSort(items, { search: "2010" }).map((item) => item.id), ["anime:gamma"]);
});

test("missing numeric values stay at the bottom in both directions", () => {
  assert.deepEqual(
    filterAndSort(items, { sort: "score", direction: "desc" }).map((item) => item.id),
    ["anime:gamma", "anime:alpha", "anime:beta"],
  );
  assert.deepEqual(
    filterAndSort(items, { sort: "score", direction: "asc" }).map((item) => item.id),
    ["anime:alpha", "anime:gamma", "anime:beta"],
  );
});

test("coverage filters use source count and ranking status", () => {
  assert.equal(filterAndSort(items, { coverage: "complete" }).length, 1);
  assert.equal(filterAndSort(items, { coverage: "missing" }).length, 2);
  assert.equal(filterAndSort(items, { coverage: "ranked" }).length, 2);
});

test("commercial helper and stale dates are deterministic", () => {
  assert.equal(commercialValue(items[0]), 1000);
  assert.equal(commercialValue(items[1]), null);
  assert.equal(
    isOlderThan("2026-07-01T00:00:00.000Z", 14, Date.parse("2026-07-17T00:00:00.000Z")),
    true,
  );
});
