# 联网检索模式（Netlify v3）

## 目的与范围

`/api/v3/live-*` 是独立于 v1/v2 合成基线的**可选**联网检索路径：

1. 服务端只将 `destination` 与选中的 `interests` 发送给 Tavily；
2. Tavily 返回少量网页搜索结果；
3. 服务端清洗为可打开的 `https` 来源、标题和短摘要；
4. 规划器只按照这些来源组织候选日程，并返回获取时间、来源 ID 与核验提示。

它不抓取页面全文，不保存搜索结果到 Git，不接收备注/联系人，不调用 DeepSeek，不预订，也不把搜索摘要当作票价、营业状态、交通或可订性的已核验事实。

这样做是为了让“联网”可被看见和审查，而不是把本地合成结果伪装成实时数据。v1/v2 仍保持可复跑的合成基线；它们不会因为 v3 的存在而被静默改写。

## 为什么 DeepSeek Key 不够

DeepSeek 在本项目中是可选的文本生成提供方，不是通用网页检索提供方。其 Responses API 文档明确说明内置 `web_search` 等工具会被忽略；要完成联网检索，应用需要自己调用检索 API，再把得到的来源作为受约束输入处理。见 [DeepSeek Responses API 指南](https://api-docs.deepseek.com/guides/responses_api/)。

本阶段选用 Tavily，是因为它提供面向程序的搜索结果、URL 与摘要，可设置中国/中文偏好，也有可用于开发测试的免费额度。具体额度和条款以 [Tavily API Credits](https://docs.tavily.com/documentation/api-credits) 与 [Search API 文档](https://docs.tavily.com/documentation/api-reference/endpoint/search) 为准。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v3/live-attractions?destination=上饶&interests=自然,文化&limit=6` | 只读、可短时 CDN 缓存的联网来源卡片 |
| `POST` | `/api/v3/live-plans` | 基于同次联网来源组织候选日程与预算分配框架 |

`POST /api/v3/live-plans` 复用 v1 的 `destination`、`days`、`travelers`、`total_budget_cny`、`interests`、`travel_style` 输入边界，但拒绝非空 `notes` 和所有建单请求。换言之，外部检索方不会收到个人备注、联系人或工单信息。

成功响应会新增：

```json
{
  "retrieval": {
    "mode": "live_web",
    "provider": "tavily",
    "status": "live",
    "retrieved_at": "2026-09-21T12:00:00.000Z",
    "cache_age_seconds": 0,
    "source_count": 4,
    "notices": ["网页检索结果会随时间变化；请打开来源页核验。"]
  },
  "budget": {
    "mode": "allocation_framework",
    "pricing_complete": false,
    "estimated_total_cny": null
  }
}
```

`status` 是 `live`、`cache_hit` 或 `no_results`。没有来源时，接口返回清楚的空结果和待补充状态，不会拿其他城市的资料或编造景点代替。

## Netlify 配置（不把 Key 发到聊天或 GitHub）

先保持站点为 **Private**，完成一次真实验收后再决定是否公开。登录 Tavily 后创建项目专用 Key；不要把 Key 粘贴到聊天、截图、仓库、`netlify.toml`、前端代码或 GitHub Actions。

在 Netlify 项目中依次打开 **Project configuration → Environment variables → Add a variable**，新增下面两项。真实 Key 只填进第一项的 Value：

| Key | Value | 说明 |
| --- | --- | --- |
| `TAVILY_API_KEY` | 你的 Tavily Key | 必填，仅函数运行时读取 |
| `TRAVELOPS_LIVE_RETRIEVAL_ENABLED` | `true` | 必填，显式开启 v3 |

可选项保持默认即可：

| Key | 推荐 Value |
| --- | --- |
| `TRAVELOPS_LIVE_RETRIEVAL_TIMEOUT_MS` | `4000` |
| `TRAVELOPS_LIVE_RETRIEVAL_MAX_RESULTS` | `6` |
| `TRAVELOPS_LIVE_RETRIEVAL_CACHE_TTL_SECONDS` | `600` |
| `TRAVELOPS_LIVE_RETRIEVAL_DAILY_QUOTA` | `15` |

保存变量后必须触发一次新的 Netlify Deploy，函数才能读取新值。Netlify 的函数环境变量说明见 [官方文档](https://docs.netlify.com/build/functions/environment-variables/)。部署成功后：

```powershell
curl.exe -sS https://<你的站点>.netlify.app/health
curl.exe -sS "https://<你的站点>.netlify.app/api/v3/live-attractions?destination=上饶&interests=自然,文化&limit=6"
```

`/health` 中应看到 `live_retrieval.enabled: true`，但绝不应出现 Key。第二条返回的每个 citation 都应有可打开的 `https` URL 和 `retrieved_at`。随后在网页中输入“上饶”，保持“联网检索公开网页来源”开启，再检查页面中的来源链接和核验提示。

## 公开前的额度与安全边界

每个 v3 函数配置了 Netlify 的 `3 次 / 分钟 / IP` 限流；查询来源的 `GET` 路径也使用 5 分钟 CDN 缓存。每次实际出站的缓存未命中查询还会先在 Netlify Blobs 中占用一个当日固定槽位，默认每天最多 `15` 个槽位。槽位仅记录 UTC 日期、槽号和预留时间，不记录城市、偏好、Key 或访问者信息；存储不可用或返回不安全的条件写入结果时，会 fail closed，不调用 Tavily。

这三层措施能降低重复点击和普通滥用，但仍**不是**严格的财务/付费 API 硬上限：函数 IP 限流可能有短暂传播延迟，Blobs 也不是事务型计费系统，Tavily 侧账户额度才是最终的供应商限制。Netlify 的适用范围与限制见 [函数限流文档](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)、[缓存文档](https://docs.netlify.com/build/caching/caching-overview/) 和 [Blobs 文档](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)。

因此，当前推荐流程是：

1. 先私有部署并用“上饶”等真实城市验收；
2. 记录一次去敏后的手工验收（日期、城市、来源条数、延迟、对应 commit）；
3. 在 Tavily 后台确认自己的免费/付费额度和告警设置，再按访问量调整 `TRAVELOPS_LIVE_RETRIEVAL_DAILY_QUOTA`；
4. 只有确认额度、公开范围和网页核验提示都符合预期后，才把 Netlify 站点改为 Public。

固定槽位不会在供应商失败后归还，避免并发释放导致超额；因此偶发失败也会占一个当天槽位。这是刻意采取的“宁可少服务、不超量调用”的演示安全取舍。

## 离线验证

CI 不调用 Tavily，也不需要 Key。`tests/live_retrieval.test.mjs` 用 fake provider 覆盖：上饶等任意城市的安全来源规范化、请求最小化、缓存、超时/限流、缺 Key 的 fail-closed 行为、无价格不显示为 `¥0`、以及 v3 路由限流配置。

```powershell
node --test tests/static_demo.test.mjs tests/netlify_api.test.mjs tests/live_retrieval.test.mjs
```

真实联网验收必须在密钥已配置、站点仍为私有的环境手动进行；不要把 Key、Authorization 头、原始供应商错误或访问者输入写入报告。
