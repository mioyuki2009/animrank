import { commercialValue, filterAndSort, isOlderThan } from "./catalog.js";

const sourceLabels = {
  bangumi: "Bangumi",
  mal: "MyAnimeList",
  anilist: "AniList",
};
const sourceOrder = ["bangumi", "mal", "anilist"];
const compactNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const integerNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const params = new URLSearchParams(location.search);
const state = {
  medium: params.get("type") === "manga" ? "manga" : "anime",
  search: params.get("q") || "",
  coverage: ["all", "ranked", "complete", "missing"].includes(params.get("coverage"))
    ? params.get("coverage")
    : "all",
  sort: ["score", "bangumi", "mal", "anilist", "commercial"].includes(params.get("sort"))
    ? params.get("sort")
    : "score",
  direction: params.get("direction") === "asc" ? "asc" : "desc",
};

const data = { anime: [], manga: [], metadata: null };
const elements = {
  body: document.querySelector("#catalog-body"),
  commercialHeading: document.querySelector("#commercial-heading"),
  coverage: document.querySelector("#coverage"),
  dialog: document.querySelector("#details-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  dialogKicker: document.querySelector("#dialog-kicker"),
  dialogTitle: document.querySelector("#dialog-title"),
  direction: document.querySelector("#direction"),
  empty: document.querySelector("#empty-state"),
  freshness: document.querySelector("#freshness"),
  resultCount: document.querySelector("#result-count"),
  search: document.querySelector("#search"),
  sort: document.querySelector("#sort"),
  sourceHealth: document.querySelector("#source-health"),
  tabs: [...document.querySelectorAll("[role=tab]")],
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  return dateFormatter.format(new Date(value));
}

function updateUrl() {
  const next = new URLSearchParams();
  if (state.medium !== "anime") next.set("type", state.medium);
  if (state.search) next.set("q", state.search);
  if (state.coverage !== "all") next.set("coverage", state.coverage);
  if (state.sort !== "score") next.set("sort", state.sort);
  if (state.direction !== "desc") next.set("direction", state.direction);
  const query = next.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function rawScore(rating) {
  if (!rating) return "-";
  return rating.scale === 100
    ? integerNumber.format(rating.raw)
    : Number(rating.raw).toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

function ratingCell(source, rating) {
  if (!rating) {
    return `<td class="rating-cell missing" data-label="${sourceLabels[source]}"><span>-</span></td>`;
  }
  const stale = rating.stale ? '<span class="stale-mark" title="沿用上次数据">旧</span>' : "";
  return `
    <td class="rating-cell" data-label="${sourceLabels[source]}">
      <a href="${escapeHtml(rating.url)}" target="_blank" rel="noreferrer">
        <strong>${rawScore(rating)}</strong>${stale}
        <small>${compactNumber.format(rating.votes)} 票</small>
      </a>
    </td>`;
}

function coverMarkup(item) {
  if (!item.cover?.url) {
    return `<span class="cover-fallback" aria-hidden="true">${escapeHtml(item.title.zh.slice(0, 1))}</span>`;
  }
  const color = item.cover.color ? ` style="--cover-color:${escapeHtml(item.cover.color)}"` : "";
  return `<span class="cover"${color}><img src="${escapeHtml(item.cover.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
}

function commercialMarkup(item) {
  const value = commercialValue(item);
  if (value === null) return '<span class="missing-value">-</span>';
  return `<strong>${compactNumber.format(value)}</strong><small>${item.medium === "anime" ? "张 / 卷" : "册 / 卷"}</small>`;
}

function hasCurrentSortValue(item) {
  if (state.sort === "score") return item.score.value !== null;
  if (state.sort === "commercial") return commercialValue(item) !== null;
  if (sourceOrder.includes(state.sort)) {
    return item.ratings[state.sort]?.normalized !== undefined;
  }
  return true;
}

function rowMarkup(item, index) {
  const final = item.score.value === null ? "-" : item.score.value.toFixed(2);
  const scoreClass = item.score.value >= 8.5 ? "excellent" : item.score.value >= 7.5 ? "strong" : "";
  const coverage = Math.round((item.score.coverage || 0) * 100);
  const rank = hasCurrentSortValue(item)
    ? index + 1
    : '<span class="missing-value">-</span>';
  return `
    <tr>
      <td class="rank-cell" data-label="排名">${rank}</td>
      <td class="work-cell" data-label="作品">
        ${coverMarkup(item)}
        <span class="work-copy">
          <strong>${escapeHtml(item.title.zh)}</strong>
          <small>${escapeHtml(item.title.original)}</small>
          <span>${item.year} · ${escapeHtml(item.format)}</span>
        </span>
      </td>
      ${sourceOrder.map((source) => ratingCell(source, item.ratings[source])).join("")}
      <td class="final-cell ${scoreClass}" data-label="综合">
        <span class="final-score-line"><strong>${final}</strong><em>/10</em></span>
        <span class="source-meter" aria-label="${item.score.sourceCount} / 3 个来源，覆盖 ${coverage}%">
          <i style="--coverage:${coverage}%"></i>
          <small>${item.score.sourceCount} / 3 来源</small>
        </span>
      </td>
      <td class="commercial-cell" data-label="${item.medium === "anime" ? "影碟卷均" : "卷均发行"}">
        ${commercialMarkup(item)}
      </td>
      <td class="detail-cell">
        <button type="button" data-detail="${escapeHtml(item.id)}">详情</button>
      </td>
    </tr>`;
}

function renderMetadata() {
  const metadata = data.metadata;
  if (!metadata?.generatedAt) {
    elements.freshness.innerHTML = '<span class="status-dot error" aria-hidden="true"></span><span>尚未刷新</span>';
    return;
  }

  const sourceDates = Object.values(metadata.sources || {})
    .map((source) => source.lastSuccessAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  const dataAsOf = sourceDates[0] || metadata.generatedAt;
  const stale = isOlderThan(dataAsOf, metadata.staleAfterDays);
  elements.freshness.innerHTML = `
    <span class="status-dot ${stale ? "warning" : "ready"}" aria-hidden="true"></span>
    <span>${stale ? "数据过期" : "更新于"} ${formatDate(dataAsOf)}</span>`;
  elements.sourceHealth.innerHTML = sourceOrder
    .map((source) => {
      const status = metadata.sources?.[source];
      const kind = !status ? "unknown" : status.status;
      const expired = status?.lastSuccessAt
        ? isOlderThan(status.lastSuccessAt, metadata.staleAfterDays)
        : false;
      const label =
        kind === "ok"
          ? expired
            ? "过期"
            : "正常"
          : kind === "partial"
            ? "部分"
            : status?.lastSuccessAt
              ? expired
                ? "过期"
                : "缓存"
              : "未连接";
      return `<span class="source-chip ${kind}"><i aria-hidden="true"></i>${sourceLabels[source]}<b>${label}</b></span>`;
    })
    .join("");
}

function render() {
  const items = filterAndSort(data[state.medium], state);
  elements.body.innerHTML = items.map(rowMarkup).join("");
  elements.empty.hidden = items.length !== 0;
  elements.resultCount.textContent = `${items.length} 部作品`;
  elements.commercialHeading.textContent = state.medium === "anime" ? "影碟卷均" : "卷均发行";
  document.querySelector("#anime-total").textContent = data.anime.length;
  document.querySelector("#manga-total").textContent = data.manga.length;
  elements.tabs.forEach((tab) => {
    const active = tab.dataset.medium === state.medium;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  elements.direction.textContent = state.direction === "desc" ? "↓" : "↑";
  elements.direction.setAttribute(
    "aria-label",
    state.direction === "desc" ? "当前降序，切换为升序" : "当前升序，切换为降序",
  );
  updateUrl();
}

function sourceDetail(source, rating) {
  if (!rating) {
    return `<tr><th scope="row">${sourceLabels[source]}</th><td class="missing-value">-</td><td>-</td><td>-</td><td>-</td></tr>`;
  }
  return `
    <tr>
      <th scope="row"><a href="${escapeHtml(rating.url)}" target="_blank" rel="noreferrer">${sourceLabels[source]}</a></th>
      <td>${rawScore(rating)} <small>/ ${rating.scale}</small></td>
      <td>${rating.normalized.toFixed(2)}</td>
      <td>${integerNumber.format(rating.votes)}</td>
      <td>${rating.effectiveWeight.toFixed(4)}</td>
    </tr>`;
}

function commercialDetail(item) {
  if (!item.commercial) return '<p class="commercial-empty">该作品暂无可核验的商业数据。</p>';
  const commercial = item.commercial;
  const values =
    item.medium === "anime"
      ? `<strong>${integerNumber.format(commercial.unitsPerVolume)}</strong><span>BD + DVD 卷均累计</span>`
      : `<strong>${integerNumber.format(commercial.perVolume)}</strong><span>${integerNumber.format(commercial.circulation)} ÷ ${commercial.volumesAtAnnouncement} 卷</span>`;
  return `
    <div class="commercial-detail">
      <div>${values}</div>
      <dl>
        <dt>统计日期</dt><dd>${escapeHtml(commercial.asOf)}</dd>
        <dt>口径</dt><dd>${escapeHtml(commercial.scope)}</dd>
        <dt>来源</dt><dd><a href="${escapeHtml(commercial.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(commercial.sourceLabel)}</a></dd>
      </dl>
    </div>`;
}

function openDetails(id) {
  const item = [...data.anime, ...data.manga].find((candidate) => candidate.id === id);
  if (!item) return;
  elements.dialogKicker.textContent = `${item.year} · ${item.format} · ${item.medium === "anime" ? "动画" : "漫画"}`;
  elements.dialogTitle.textContent = item.title.zh;
  elements.dialogContent.innerHTML = `
    <div class="dialog-scoreline">
      ${coverMarkup(item)}
      <div><span>综合评分</span><strong>${item.score.value === null ? "-" : item.score.value.toFixed(2)}</strong><small>算法 ${escapeHtml(data.metadata.algorithmVersion)} · 覆盖 ${(item.score.coverage * 100).toFixed(0)}%</small></div>
    </div>
    <section class="breakdown" aria-labelledby="breakdown-title">
      <h3 id="breakdown-title">评分明细</h3>
      <div class="detail-table-wrap">
        <table>
          <thead><tr><th>来源</th><th>原分</th><th>标准分</th><th>票数</th><th>有效权重</th></tr></thead>
          <tbody>${sourceOrder.map((source) => sourceDetail(source, item.ratings[source])).join("")}</tbody>
        </table>
      </div>
    </section>
    <section class="commercial-section" aria-labelledby="commercial-title">
      <h3 id="commercial-title">${item.medium === "anime" ? "实体影碟" : "累计发行"}</h3>
      ${commercialDetail(item)}
    </section>`;
  elements.dialog.showModal();
}

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.medium = tab.dataset.medium;
    render();
  });
});
elements.search.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});
elements.coverage.addEventListener("change", (event) => {
  state.coverage = event.target.value;
  render();
});
elements.sort.addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});
elements.direction.addEventListener("click", () => {
  state.direction = state.direction === "desc" ? "asc" : "desc";
  render();
});
elements.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-detail]");
  if (button) openDetails(button.dataset.detail);
});
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

async function load() {
  elements.search.value = state.search;
  elements.coverage.value = state.coverage;
  elements.sort.value = state.sort;

  try {
    const base = document.baseURI;
    const [metadata, anime, manga] = await Promise.all([
      fetch(new URL("./data/metadata.json", base)).then((response) => response.json()),
      fetch(new URL("./data/anime.json", base)).then((response) => response.json()),
      fetch(new URL("./data/manga.json", base)).then((response) => response.json()),
    ]);
    data.metadata = metadata;
    data.anime = anime;
    data.manga = manga;
    renderMetadata();
    render();
  } catch (error) {
    elements.freshness.innerHTML = '<span class="status-dot error" aria-hidden="true"></span><span>数据读取失败</span>';
    elements.empty.hidden = false;
    elements.empty.innerHTML = `<strong>无法载入榜单</strong><span>${escapeHtml(error.message)}</span>`;
  }
}

load();
