# 番鉴

一个面向 GitHub Pages 的静态动画 / 漫画评分站。浏览器只读取仓库内生成的 JSON；作品目录与评分请求全部发生在数据刷新阶段。

## 数据源

综合分只采用三个同时覆盖动画和漫画的平台：

- [Bangumi](https://bgm.tv/)：基础权重 40%
- [MyAnimeList](https://myanimelist.net/)：基础权重 30%
- [AniList](https://anilist.co/)：基础权重 30%

MyAnimeList 优先使用官方 API；未配置 `MAL_CLIENT_ID` 时使用 [Jikan](https://jikan.moe/) 作为 MAL 数据的备用取数通道。Jikan 不会被视为第四个评分平台。目录发现和评分抓取都发生在 CI 构建阶段，浏览器只读取生成后的静态 JSON。

Wikidata 只用于按平台 ID 补齐 Bangumi、MAL、AniList 的作品映射，不提供第四份评分。动画销量和漫画发行量不参与口碑评分：

- 漫画从 MediaWiki API 读取 Wikipedia 的畅销漫画表，以同一行的累计量除以单行本卷数。
- 动画优先读取日文 Wikipedia API 中明确写出的 BD / DVD 卷均；同时使用 Internet Archive 保存的 Someanithing 2021 年最终汇总页补历史卷均。
- `data/editorial.json` 保留为经过人工核验的降级数据；本次 API 没有可靠结果时继续沿用上次成功值。Someanithing 已停止维护，因此 2021 年后的动画通常会显示 `-`，不会拿首周单卷或票房数字填空。

Bangumi v0 API 没有销量或发行量字段。书籍的 `volumes` 只是从 Bangumi wiki 解析出的册数，不能当作销量。刷新脚本也会把外站封面下载到 `public/data/covers/`，页面不再依赖用户浏览器直连 AniList 等图片域名。

完整选择依据和算法见 [数据源与评分协议](docs/data-sources.md)。

## 本地运行

需要 Node.js 20 或更高版本。

```powershell
npm ci
npm run refresh
npm test
npm run validate
npm run build
npm run serve
```

默认地址为 `http://127.0.0.1:4173/`。作品目录不在仓库中手工维护：`config/catalog.json` 只设置动画和漫画的最大条数。每次 `npm run refresh` 会从三个站点的分页 API 发现作品、合并平台 ID，并把目录缓存写入 `public/data/catalog.json`。

Bangumi 要求可识别的 User-Agent。本地可设置：

```powershell
$env:PROJECT_HOMEPAGE='https://github.com/your-name/your-repo'
```

如有 MAL 官方 API Client ID：

```powershell
$env:MAL_CLIENT_ID='your-client-id'
```

## GitHub Pages

`.github/workflows/pages.yml` 会在推送、手动触发和每日定时任务中安装依赖、测试、刷新、校验、构建并部署。浏览器端始终是纯静态页面；动态取数只发生在 GitHub Actions 构建期间。单个来源失败时会继续使用最后一次成功的数据并标记状态。

在仓库 Settings → Pages 中把 Source 设为 **GitHub Actions**。如需 MAL 官方 API，在 Actions secrets 中添加 `MAL_CLIENT_ID`。

各评分、封面和商业数据归原平台及原作者所有。本项目不是 Bangumi、MyAnimeList、AniList、Wikipedia 或 Oricon 的关联服务，也不镜像评论、简介或完整平台数据库。
