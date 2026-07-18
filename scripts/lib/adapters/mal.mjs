import { delay, fetchJson } from "../http.mjs";

function fromOfficial(data, title, fetchedAt) {
  return {
    rating: {
      raw: data.mean,
      scale: 10,
      votes: data.num_scoring_users,
      url: `https://myanimelist.net/${title.medium === "anime" ? "anime" : "manga"}/${title.ids.mal}`,
      fetchedAt,
      via: "MAL API v2",
      stale: false,
    },
    cover: data.main_picture?.large || data.main_picture?.medium || null,
  };
}

function fromJikan(data, title, fetchedAt) {
  const item = data.data;
  return {
    rating: {
      raw: item.score,
      scale: 10,
      votes: item.scored_by,
      url: item.url || `https://myanimelist.net/${title.medium}/${title.ids.mal}`,
      fetchedAt,
      via: "Jikan (MAL mirror)",
      stale: false,
    },
    cover:
      item.images?.webp?.large_image_url ||
      item.images?.jpg?.large_image_url ||
      item.images?.jpg?.image_url ||
      null,
  };
}

export async function fetchMal(titles) {
  const ratings = new Map();
  const errors = [];
  const clientId = process.env.MAL_CLIENT_ID;
  const via = clientId ? "MAL API v2" : "Jikan (MAL mirror)";
  let networkUnavailable = false;

  for (const title of titles.filter((item) => item.ids.mal !== null)) {
    if (networkUnavailable) {
      errors.push({ id: title.id, message: `Skipped after ${via} became unreachable` });
      continue;
    }

    try {
      let result;
      const fetchedAt = new Date().toISOString();
      if (clientId) {
        const kind = title.medium === "anime" ? "anime" : "manga";
        const data = await fetchJson(
          `https://api.myanimelist.net/v2/${kind}/${title.ids.mal}?fields=main_picture,mean,num_scoring_users`,
          { headers: { "X-MAL-CLIENT-ID": clientId } },
        );
        result = fromOfficial(data, title, fetchedAt);
      } else {
        const kind = title.medium === "anime" ? "anime" : "manga";
        const data = await fetchJson(
          `https://api.jikan.moe/v4/${kind}/${title.ids.mal}`,
          { attempts: 3, timeoutMs: 20_000 },
        );
        result = fromJikan(data, title, fetchedAt);
        await delay(400);
      }

      if (
        Number.isFinite(result.rating.raw) &&
        Number.isFinite(result.rating.votes) &&
        result.rating.votes > 0
      ) {
        ratings.set(title.id, result);
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
      if (!clientId) await delay(800);
    }
  }

  return {
    key: "mal",
    ratings,
    errors,
    status: errors.length === 0 ? "ok" : ratings.size > 0 ? "partial" : "error",
    via,
  };
}
