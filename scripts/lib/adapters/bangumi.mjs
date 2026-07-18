import { fetchJson } from "../http.mjs";

export async function fetchBangumi(titles) {
  const ratings = new Map();
  const errors = [];
  const homepage = process.env.PROJECT_HOMEPAGE || "local-development";
  const userAgent = `FanRank/0.1 (${homepage})`;
  let networkUnavailable = false;

  for (const title of titles.filter((item) => item.ids.bangumi !== null)) {
    if (networkUnavailable) {
      errors.push({ id: title.id, message: "Skipped after Bangumi became unreachable" });
      continue;
    }

    try {
      const data = await fetchJson(
        `https://api.bgm.tv/v0/subjects/${title.ids.bangumi}`,
        {
          attempts: 2,
          timeoutMs: 10_000,
          headers: { "User-Agent": userAgent, Accept: "application/json" },
        },
      );
      const score = data.rating?.score;
      const votes = data.rating?.total;

      if (Number.isFinite(score) && Number.isFinite(votes) && votes > 0) {
        ratings.set(title.id, {
          rating: {
            raw: score,
            scale: 10,
            votes,
            url: `https://bgm.tv/subject/${title.ids.bangumi}`,
            fetchedAt: new Date().toISOString(),
            via: "Bangumi API v0",
            stale: false,
          },
          cover: data.images?.large || data.images?.common || null,
        });
      }
    } catch (error) {
      errors.push({ id: title.id, message: error.message });
      if (
        !error.status ||
        [401, 403, 429].includes(error.status) ||
        error.status >= 500
      ) {
        networkUnavailable = true;
      }
    }
  }

  return {
    key: "bangumi",
    ratings,
    errors,
    status: errors.length === 0 ? "ok" : ratings.size > 0 ? "partial" : "error",
    via: "Bangumi API v0",
  };
}
