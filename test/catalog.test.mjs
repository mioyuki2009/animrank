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
  assert.equal(commercialValue({
    medium: "anime",
    commercial: { unitsTotal: 75_000, unitsPerVolume: 1000 },
  }), 75_000);
  assert.equal(
    isOlderThan("2026-07-01T00:00:00.000Z", 14, Date.parse("2026-07-17T00:00:00.000Z")),
    true,
  );
});
const sourceItems = [
  {
    id: "anime:source-a",
    medium: "anime",
    title: { zh: "源甲", original: "Source A" },
    year: 2020,
    format: "TV",
    score: { value: 8, sourceCount: 3, status: "ranked" },
    ratings: {
      bangumi: { raw: 8.8, scale: 10, normalized: 8.8 },
      mal: { raw: 8.5, scale: 10, normalized: 8.5 },
      anilist: { raw: 90, scale: 100, normalized: 9 },
    },
    commercial: { unitsPerVolume: 1000 },
  },
  {
    id: "anime:source-b",
    medium: "anime",
    title: { zh: "源乙", original: "Source B" },
    year: 2020,
    format: "TV",
    score: { value: 7, sourceCount: 2, status: "ranked" },
    ratings: {
      bangumi: { raw: 7.2, scale: 10, normalized: 7.2 },
      mal: { raw: 7.8, scale: 10, normalized: 7.8 },
      anilist: { raw: 80, scale: 100, normalized: 8 },
    },
    commercial: { unitsPerVolume: 500 },
  },
  {
    id: "anime:source-missing",
    medium: "anime",
    title: { zh: "源缺失", original: "Source Missing" },
    year: 2020,
    format: "TV",
    score: { value: null, sourceCount: 0, status: "unrated" },
    ratings: { bangumi: null, mal: null, anilist: null },
    commercial: null,
  },
];

test("source score sorts use normalized ten-point values and keep missing last", () => {
  assert.deepEqual(
    filterAndSort(sourceItems, { sort: "anilist", direction: "desc" }).map((item) => item.id),
    ["anime:source-a", "anime:source-b", "anime:source-missing"],
  );
  assert.deepEqual(
    filterAndSort(sourceItems, { sort: "bangumi", direction: "asc" }).map((item) => item.id),
    ["anime:source-b", "anime:source-a", "anime:source-missing"],
  );
});

test("commercial sorting keeps missing values at the bottom in both directions", () => {
  assert.deepEqual(
    filterAndSort(sourceItems, { sort: "commercial", direction: "desc" }).map((item) => item.id),
    ["anime:source-a", "anime:source-b", "anime:source-missing"],
  );
  assert.deepEqual(
    filterAndSort(sourceItems, { sort: "commercial", direction: "asc" }).map((item) => item.id),
    ["anime:source-b", "anime:source-a", "anime:source-missing"],
  );
});
