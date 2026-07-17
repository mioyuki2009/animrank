# 番鉴

一个面向 GitHub Pages 的静态动画 / 漫画评分站。浏览器只读取仓库内生成的 JSON；Bangumi、MyAnimeList 和 AniList 的请求全部发生在数据刷新阶段。

## 数据源

综合分只采用三个同时覆盖动画和漫画的平台：

- [Bangumi](https://bgm.tv/)：基础权重 40%
- [MyAnimeList](https://myanimelist.net/)：基础权重 30%
- [AniList](https://anilist.co/)：基础权重 30%

MyAnimeList 优先使用官方 API；未配置 `MAL_CLIENT_ID` 时使用 [Jikan](https://jikan.moe/) 作为 MAL 数据的备用取数通道。Jikan 不会被视为第四个评分平台。

动画销量和漫画发行量不参与口碑评分。由于 Oricon 没有适合公开 CI 的免费 API，这部分数据位于 `data/editorial.json`，需要人工核对来源。脚本只负责校验字段以及计算漫画卷均。

完整选择依据和算法见 [数据源与评分协议](docs/data-sources.md)。

## 本地运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```powershell
npm run refresh
npm test
npm run validate
npm run build
npm run serve
```

默认地址为 `http://127.0.0.1:4173/`。新增作品时编辑 `config/titles.json`，为每个平台填写人工确认的 ID；缺失 ID 使用 `null`，不要使用标题模糊匹配。

Bangumi 要求可识别的 User-Agent。本地可设置：

```powershell
$env:PROJECT_HOMEPAGE='https://github.com/your-name/your-repo'
```

如有 MAL 官方 API Client ID：

```powershell
$env:MAL_CLIENT_ID='your-client-id'
```

## GitHub Pages

`.github/workflows/pages.yml` 会在推送、手动触发和每日定时任务中执行校验、刷新、构建与部署。定时刷新失败时会继续部署最后一次成功的数据，并在页面标记来源状态。

在仓库 Settings → Pages 中把 Source 设为 **GitHub Actions**。如需 MAL 官方 API，在 Actions secrets 中添加 `MAL_CLIENT_ID`。

各评分和封面数据归原平台所有。本项目不是 Bangumi、MyAnimeList、AniList 或 Oricon 的关联服务，也不镜像评论、简介或完整平台数据库。
