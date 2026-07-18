import { fetchJson } from "../http.mjs";

const query = `
  query RatingBatch($ids: [Int], $type: MediaType) {
    Page(page: 1, perPage: 50) {
      media(id_in: $ids, type: $type) {
        id
        status
        averageScore
        siteUrl
        coverImage { extraLarge large color }
        stats { scoreDistribution { amount } }
      }
    }
  }
`;

export async function fetchAniList(titles) {
  const ratings = new Map();
  const errors = [];

  for (const medium of ["anime", "manga"]) {
    const selected = titles.filter(
      (item) => item.medium === medium && item.ids.anilist !== null,
    );
    if (selected.length === 0) continue;

    for (let offset = 0; offset < selected.length; offset += 50) {
      const batch = selected.slice(offset, offset + 50);
      try {
        const data = await fetchJson("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            query,
            variables: {
              ids: batch.map((item) => item.ids.anilist),
              type: medium === "anime" ? "ANIME" : "MANGA",
            },
          }),
        });

        if (data.errors?.length) {
          throw new Error(data.errors.map((error) => error.message).join("; "));
        }

        const byId = new Map((data.data?.Page?.media || []).map((item) => [item.id, item]));
        for (const title of batch) {
          const item = byId.get(title.ids.anilist);
          if (!item || !Number.isFinite(item.averageScore)) continue;
          const votes = (item.stats?.scoreDistribution || []).reduce(
            (total, bucket) => total + bucket.amount,
            0,
          );
          if (votes <= 0) continue;

          ratings.set(title.id, {
            rating: {
              raw: item.averageScore,
              scale: 100,
              votes,
              url: item.siteUrl || `https://anilist.co/${medium}/${title.ids.anilist}`,
              fetchedAt: new Date().toISOString(),
              via: "AniList GraphQL API",
              stale: false,
            },
            cover: item.coverImage?.large || item.coverImage?.extraLarge || null,
            color: item.coverImage?.color || null,
          });
        }
      } catch (error) {
        for (const title of batch) errors.push({ id: title.id, message: error.message });
      }
    }
  }

  return {
    key: "anilist",
    ratings,
    errors,
    status: errors.length === 0 ? "ok" : ratings.size > 0 ? "partial" : "error",
    via: "AniList GraphQL API",
  };
}
