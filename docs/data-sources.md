# 数据源与评分协议

## 首版来源

| 来源 | 动画 | 漫画 | 取数方式 | 基础权重 |
| --- | --- | --- | --- | ---: |
| Bangumi | 是 | 是 | [官方 v0 API](https://bangumi.github.io/api/) | 0.40 |
| MyAnimeList | 是 | 是 | [官方 API v2](https://myanimelist.net/apiconfig/references/api/v2)，Jikan 备用 | 0.30 |
| AniList | 是 | 是 | [官方 GraphQL API](https://docs.anilist.co/) | 0.30 |

三者的用户群和评分习惯并不相同，但都能覆盖两个板块，也都能用稳定作品 ID 查询。AniDB 只有动画；Kitsu 的样本量和维护可信度较弱；豆瓣没有适合 GitHub Actions 的可靠开放接口，因此首版不把它们纳入总分。

作品目录不在仓库中手工维护。`config/catalog.json` 只提供动画和漫画的最大条数；刷新阶段从 AniList、MAL/Jikan、Bangumi 的分页 API 发现作品并按平台 ID 合并。之后使用 Wikidata 的 Bangumi、MAL、AniList 外部 ID 补映射，再对仍缺失的条目调用 AniList GraphQL 和 Bangumi 搜索 API，并校验标题、年份和作品格式。平台未收录或无法可靠映射时保存为 `null`，页面显示 `-`。

## 综合分

历史最高作品的分数不是平台满分。不能因为某站榜首目前只有 `8.x`，就把 `8.x` 强行拉到 10；榜首变化会让所有历史分数漂移。

算法按以下顺序执行，动画和漫画分别配置：

1. 统一量纲。原始分 `r`、平台声明满分 `L` 转为十分制：`x = 10 × r / L`。
2. 分布校准。使用版本化校准快照中的中位数 `m` 和稳健离散度 `d = (Q75 - Q25) / 1.349`：`z = clamp((x - m) / max(d, 0.35), -2.8, 2.8)`，再映射为 `y = clamp(6.5 + 1.25 × z, 0, 10)`。
3. 票数置信度。平台内票数 `n` 和该平台配置的半权票数 `k` 计算 `c = n / (n + k)`。不同平台不能直接比较绝对票数，所以 `k` 按平台和媒介分别配置。
4. 有效权重：`w = 平台基础权重 × 校准可靠度 × c`。
5. 只对实际取得的来源重新归一化权重：`F = Σ(w × y) / Σw`。

平台缺失时不按 0 分处理，也不加入中性先验，只在已取得的来源之间重新归一化。只要有一个有效评分，就按已有评分计算综合分；所有平台都缺失时显示 `-`。销量和卷均是商业指标，永远不进入综合分。

校准样本必须分动画 / 漫画保存，且至少包含 300 个达到票数门槛的已发行作品。仓库初始配置使用显式的 `identity-fallback`，即样本未达到门槛时只做量纲统一，并降低校准可靠度；这比伪造一组精确参数更可审计。后续校准快照只在人工审核后升级算法版本。

## 销量口径

Bangumi 官方 v0 OpenAPI 没有销量、销售量或发行量字段。书籍条目的 `volumes` 仅表示由旧服务端从 wiki 解析的册数；通用 `infobox` 也没有稳定的销量结构，因此二者都不作为销量来源。

漫画刷新通过 MediaWiki API 读取 Wikipedia 的 `List of best-selling manga` 表。脚本使用同一行的近似销量/发行量和单行本卷数，并保留“是否含数字版”的标记：

`卷均发行量 = 公告累计发行量 / 公告时已发行卷数`

动画统一展示日本实体 BD + DVD 的单卷平均销量。刷新时先检查日文 Wikipedia 的 MediaWiki API，只接受同一句中明确出现 BD / DVD、平均口径和张数的记录；再读取 Internet Archive 保存的 Someanithing `Series Data - Quick View` 最终有效快照（2021-09-07），使用其 `Total` / `Average Sales` 列补历史数据。首周单卷、全系列累计、票房、漫画发行量和周边数量不会混入同一排序。

Someanithing 已停止维护，归档数据不会伪装成当前数据，2021 年后的作品通常显示 `-`。Oricon 是更权威的行业基准，但没有适合公开 CI 的免费 API，因此动画商业数据覆盖率仍会低于评分数据。

`data/editorial.json` 中经过人工核验的数据和上次成功生成的数据是降级来源。自动 Wiki 结果优先，但绝不会用旧公告累计量除以今天的卷数。

## 失败与陈旧数据

- 每个平台保存最后一次成功值和 `fetchedAt`。
- 单个平台刷新失败时沿用最后成功值并标记 `stale`，不清空整列。
- 从未成功取得的数据才显示 `-`。
- 封面在 CI 中下载到静态目录；下载失败时沿用上次缓存，再失败才保留远程地址或显示占位。
- 超过 14 天没有成功更新时，页面显示“数据过期”。
- 评分越界、票数为负、作品 ID 重复或卷均公式不一致都会让校验失败。

Bangumi 的 [User-Agent 规则](https://github.com/bangumi/api/blob/master/docs-raw/user%20agent.md)、[MAL API Agreement](https://myanimelist.net/static/apiagreement.html) 和 [AniList 限流说明](https://docs.anilist.co/guide/rate-limiting) 应在修改抓取器前重新确认。
