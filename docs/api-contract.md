# HTTP API 契约（v1 稳定基线 / v2 模型增强）

本文件描述 TravelOps Copilot 演示服务的稳定意图。服务启动后的 OpenAPI 页面（通常为 `/docs`）是运行时字段和示例的最终依据。所有示例均使用**虚构/合成**内容。

## 通用约定

- 内容类型：`application/json; charset=utf-8`；
- 字符集：UTF-8；
- API 前缀：`/api/v1`；
- 成功响应：通常是 `2xx` 与 JSON；参数校验失败应为 `4xx`；
- 不接受、记录或要求真实支付信息、证件信息、订单号或 API 密钥；
- `source_url` 中的 `synthetic://` 为合成来源 ID，并非可访问网页。

## `GET /health`

用于容器编排、演示录屏和评测前检查。

**预期成功字段**

```json
{
  "status": "ok",
  "mode": "deterministic_mock",
  "knowledge_records": 12,
  "public_demo_mode": false
}
```

`knowledge_records` 为当前加载的合成资料条数，随数据版本变化；`public_demo_mode` 表示当前服务是否拒绝所有模拟工单读写。调用方不应把健康检查视为真实外部服务可用性的证明。

## `GET /api/v1/attractions`

在合成知识库中按目的地和可选兴趣筛选候选项。

### 查询参数

| 参数 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `destination` | 是 | `杭州` | 演示用城市条件 |
| `interests` | 否 | `自然,文化` | 逗号分隔的兴趣标签；空值表示不额外过滤 |
| `limit` | 否 | `8` | 1–20；限制返回的候选条数 |

### 响应字段

响应固定为 `{ "destination": "...", "items": [...], "citations": [...] }`。每条候选项至少应有：

```json
{
  "id": "syn-hz-001",
  "name": "澜汀湿地公园",
  "city": "杭州",
  "category": "自然漫步",
  "summary": "虚构的滨水步行场景……",
  "price_cny": 35,
  "hours": "09:00-17:30（合成展示时间）",
  "tags": ["自然", "慢节奏"],
  "source_title": "合成条目：澜汀湿地公园",
  "source_url": "synthetic://travelops/syn-hz-001"
}
```

空结果应能区分“没有匹配的合成数据”与“服务错误”。不要基于空结果生成虚构地点。

## `POST /api/v1/plans`

生成结构化行程草案。它不执行预订，不保证任何现实世界的信息、价格或可用性。

### 请求体

```json
{
  "destination": "杭州",
  "days": 2,
  "travelers": 2,
  "total_budget_cny": 5000,
  "interests": ["自然", "文化"],
  "travel_style": "balanced",
  "start_date": "2026-10-01",
  "notes": "仅做本地演示",
  "create_follow_up_ticket": false,
  "contact_name": "演示用户"
}
```

| 字段 | 必填 | 类型 | 约束/语义 |
| --- | --- | --- | --- |
| `destination` | 是 | string | 1–80 个字符；匹配演示知识库中的城市时才能给出来源化候选 |
| `days` | 是 | integer | 1–14；用于排布草案天数 |
| `travelers` | 否 | integer | 1–10，默认 `1`；用于估算总成本 |
| `total_budget_cny` | 是 | number | 大于 0 且不超过 100,000 的预算上限；不是报价或支付金额 |
| `interests` | 否 | string[] | 最多 8 个兴趣标签；空列表会使用确定性的演示默认值 |
| `travel_style` | 否 | enum | `budget`、`balanced` 或 `comfort`；仅为演示中的成本假设档位，不是现实服务等级 |
| `start_date` | 否 | string | ISO 日期格式；不触发真实库存/天气查询 |
| `notes` | 否 | string | 最多 500 字符的演示备注；不传真实敏感信息 |
| `create_follow_up_ticket` | 否 | boolean | 仅为 `true` 时尝试创建模拟工单 |
| `contact_name` | 否 | string | 本地演示字段，不应当作生产级 PII 处理方案 |

当 `TRAVELOPS_PUBLIC_DEMO_MODE=true` 时，任何带 `create_follow_up_ticket=true` 的 v1 或 v2 规划请求都会返回 `403`，且不得重试为工单写入。公开演示页面会隐藏该选项；调用方也不应把个人信息放入 `notes` 或 `contact_name`。

### 成功响应的核心语义

下例对应上方的 `杭州 / 2 天 / 2 人 / 5000 元 / balanced` 合成请求。为控制篇幅，`line_items` 和 `citations` 只展示各自的第一项；实际响应会返回完整数组。实现可增加字段，但应保留以下概念：

```json
{
  "plan_id": "PLAN-EXAMPLE01",
  "request_summary": {
    "destination": "杭州",
    "days": 2,
    "travelers": 2,
    "interests": ["自然", "文化"],
    "travel_style": "balanced",
    "mock_mode": true
  },
  "itinerary": [
    {
      "day": 1,
      "theme": "自然漫步主题（第 1 天）",
      "items": [
        {
          "slot": "上午",
          "title": "澜汀湿地公园",
          "description": "虚构的滨水步行场景……（初版建议）",
          "estimated_duration_minutes": 120,
          "estimated_cost_cny": 35,
          "source_id": "syn-hz-001"
        }
      ]
    }
  ],
  "budget": {
    "currency": "CNY",
    "budget_cap_cny": 5000,
    "estimated_total_cny": 1587.6,
    "remaining_cny": 3412.4,
    "line_items": [
      {
        "category": "景点与体验",
        "amount_cny": 430,
        "assumption": "按每位旅客参与所选本地示例点位估算"
      }
    ]
  },
  "citations": [
    {
      "source_id": "syn-hz-001",
      "title": "合成条目：澜汀湿地公园",
      "uri": "synthetic://travelops/syn-hz-001",
      "excerpt": "虚构的滨水步行场景……",
      "relevance": "用于 自然 的本地资料检索"
    }
  ],
  "validation": {
    "passed": true,
    "within_budget": true,
    "coverage_ok": true,
    "issues": [],
    "revision_count": 0
  },
  "workflow_trace": [
    {"step": "parse", "status": "completed", "detail": "已标准化 杭州、2 天、2 位旅客的需求。"},
    {"step": "retrieve", "status": "completed", "detail": "从本地资料检索到 2 个可引用点位。"},
    {"step": "plan", "status": "completed", "detail": "已生成初版日程和逐项预算估算。"},
    {"step": "validate", "status": "completed", "detail": "预算与日程覆盖校验通过。"},
    {"step": "finalize", "status": "completed", "detail": "已输出可引用的方案。"}
  ],
  "ticket": null
}
```

字段名可能随实现演进调整；任何破坏性调整都应提升 API 版本或更新评测用例。应重点保证：

- `plan_id` / `request_summary`：本次演示请求的标识与已规范化的摘要；
- `itinerary`：按天、主题、时段与 `source_id` 表达的行程草案；
- `budget`：`budget_cap_cny`、`estimated_total_cny`、`remaining_cny` 与显式 `line_items`；
- `citations`：`source_id`、`title`、`uri`、`excerpt` 与 `relevance`；
- `validation`：`passed`、`within_budget`、`coverage_ok`、`issues` 与最多一次的 `revision_count`；
- `workflow_trace`：由 `parse`、`retrieve`、`plan`、`validate`、可选 `revise_once`、`finalize` 组成的结构化步骤，不含密钥/敏感内容；

- `ticket`：只有明确要求人工跟进时才可能有值，且仅代表模拟工单。

## `POST /api/v2/plans`

v2 使用与 `POST /api/v1/plans` 相同的请求体和确定性规划基础，再额外返回模型增强元数据。它用于演示“真实模型调用也必须被来源、结构和降级策略约束”的工程方式；它仍然只处理本仓库的合成资料，不是线上旅行助手。

模型调用的前提是：本地/部署环境显式开启、密钥和模型名有效、当前请求有同城来源、且确定性预算与日程校验通过。否则 HTTP 仍返回 `200` 的确定性结果，并在 `generation` 中解释为什么没有采用模型文本。

### v2 新增字段

```json
{
  "generation": {
    "mode": "llm_augmented",
    "provider": "deepseek",
    "model": "运行时配置或供应商返回的模型标识",
    "prompt_version": "travelops-v2.0.0",
    "fallback_code": null,
    "attempts": 1,
    "llm_latency_ms": 842.1,
    "usage": {
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "total_tokens": 0
    }
  },
  "narrative": {
    "overview": "基于受控合成资料的简短说明。",
    "day_notes": [
      {
        "day": 1,
        "theme": "模型生成的说明性主题",
        "rationale": "只根据已给出的合成候选作解释。",
        "source_ids": ["syn-hz-001"]
      }
    ],
    "caveats": ["示例资料不代表真实库存或营业信息。"]
  }
}
```

`generation` 只包含可用于评测的非敏感元数据，绝不包含 API Key、Authorization 请求头、原始供应商错误或完整提示词。`usage` 仅在供应商实际返回 token 信息时出现。`model` 和耗时是**某次运行的观测值**，不是固定性能承诺。

| 字段 | 语义 |
| --- | --- |
| `generation.mode` | `llm_augmented` 表示模型输出通过校验；`deterministic` 表示明确关闭模型；`deterministic_fallback` 表示配置、数据、网络或输出校验原因使系统保留确定性结果。 |
| `generation.fallback_code` | 安全的机器可读降级原因，例如 `knowledge_empty`、`validation_not_passed`、`provider_rate_limited` 或 `untrusted_provider_output`；不是供应商原始错误。 |
| `generation.attempts` | 本次实际供应商请求次数，最多 2 次；未调用为 0。 |
| `narrative` | 仅在 `llm_augmented` 时返回。它不替换 `itinerary`、`budget`、`citations` 或 `validation`。 |

### v2 安全约束

- 模型只会看到经过范围校验的目的地、天数、人数、预算、兴趣、确定性草案及合成候选；`notes`、`contact_name` 和工单内容不会发送给供应商。
- 返回文本必须是 JSON，且每一天恰好一次、所有 `source_ids` 都属于本次 `citations`，否则丢弃。
- 空城市、预算/覆盖校验失败、密钥缺失、超时、限流、无效 JSON 或来源幻觉都会回退；不会把失败伪装成成功。
- CI 只运行离线 fake-provider 测试，不使用或保存任何真实密钥。真实模型评测须手动运行，并保留去敏后的原始报告。

## `GET /api/v3/live-attractions`

这是独立、显式开启的联网来源检索接口。它只接受目的地与兴趣，不读取仓库中的合成景点资料，也不调用 DeepSeek。函数未配置联网检索 Key 时固定返回 `503` / `live_retrieval_not_configured`，不会把合成结果标为联网。

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `destination` | 是 | 1–80 个字符的目的地 |
| `interests` | 否 | 逗号分隔，最多 8 项、每项最多 40 个字符 |
| `limit` | 否 | 1–8；实际返回仍受服务端配置上限约束 |

成功响应中的 `items` 是网页来源卡片，不是已核验的 POI 或报价：`price_cny` 固定为 `null`。`citations` 是已清洗的 `https` URL、标题、短摘要和来源 ID；`retrieval` 包含 `provider`、`status`（`live` / `cache_hit` / `no_results`）、`retrieved_at`、`cache_age_seconds`、`source_count` 和核验提示。

该 GET 路径只包含查询参数，可能有短时 CDN 缓存；不要在 query 中放个人信息。

每个实际出站的缓存未命中请求会先占用一个 Netlify Blobs 的固定日额度槽位（默认 15）。额度已满返回 `429 live_search_demo_quota_exhausted`；存储保护不可用时返回 `503 live_search_quota_unavailable`，两种情形都不会调用外部搜索提供方。它是保守的演示可用性保护，不是付费/财务硬额度保证。

## `POST /api/v3/live-plans`

使用与 v1 相同的必填规划字段：`destination`、`days`、`travelers`、`total_budget_cny`。可选字段为 `start_date`、`interests` 和 `travel_style`。它额外遵守以下数据最小化边界：

- `notes` 非空时返回 `422 live_retrieval_notes_not_allowed`；
- `create_follow_up_ticket=true` 时返回公开演示的 `403`；
- 只有 `destination` 与规范化后的 `interests` 会被交给联网检索提供方；
- 所有未知字段都不会进入检索请求。

响应保持 v1 渲染字段（`itinerary`、`budget`、`citations`、`validation`、`workflow_trace`、`ticket`），并增加 `retrieval`。每个日程项目指向本次来源的 `source_id`；无法检索时是“待补充”状态，而不是替换为别城内容。

与合成 v1 预算不同，v3 的 `budget` 是：

```json
{
  "mode": "allocation_framework",
  "pricing_complete": false,
  "budget_cap_cny": 2400,
  "estimated_total_cny": null,
  "remaining_cny": null,
  "summary_label": "预算上限",
  "total_label": "预算上限"
}
```

这表示项目只将用户输入的预算分配为住宿、餐饮、交通、体验和机动预留，不能被当作实时价格、报价或预订承诺。`validation.passed` 会保持 `false`，直到价格、营业状态、交通和预约由人工在原始来源页核验。完整配置与公共访问边界见 [联网检索说明](live-retrieval.md)。

## `POST /api/v1/tickets`

创建模拟人工跟进工单，供前端或规划接口的“交接人工”分支调用。

### 请求体

```json
{
  "title": "预算确认请求",
  "description": "仅用于本地演示的工单内容",
  "contact_name": "演示用户",
  "priority": "normal"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 3–160 字符的演示标题 |
| `description` | 是 | 3–2,000 字符的待跟进描述；不得放入敏感数据 |
| `contact_name` | 否 | 本地演示名，不是认证身份 |
| `priority` | 否 | `low` / `normal` / `high`，默认 `normal` |
| `source_plan_id` | 否 | 若由规划流程创建，用于关联演示 plan ID |
| `metadata` | 否 | 结构化演示上下文；禁止放敏感数据 |

成功响应状态为 `201`，包含 `ticket_id`、`status`、`priority`、`created_at`、`updated_at` 及请求字段。它绝不代表真实客服已接单。

当 `TRAVELOPS_PUBLIC_DEMO_MODE=true` 时，本节的创建、按 ID 查询和列表查询接口均固定返回 `403`，响应说明工单流程已在公开演示中关闭。该边界避免无鉴权公共服务持久化访客提交的内容。

## `GET /api/v1/tickets/{ticket_id}`

按 ID 返回前述模拟工单。未知 ID 应返回语义明确的错误状态，而不应伪造成功记录。

## `GET /api/v1/tickets`

查询本地 SQLite 模拟工单。它不会访问真实 CRM。

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `status` | 否 | `open` / `in_progress` / `resolved` |
| `contact_name` | 否 | 演示联系人名筛选，最多 80 字符 |
| `limit` | 否 | 1–100，默认 `20` |

成功响应为工单记录数组，按创建时间倒序排列。测试和演示完成后可以删除本地运行时数据库；不要把真实用户信息放入其中。

## 错误格式建议

框架的标准校验错误即可使用；如服务有业务错误包装，建议至少包含：

```json
{
  "detail": "可读的错误说明",
  "code": "OPTIONAL_MACHINE_READABLE_CODE"
}
```

客户端应根据 HTTP 状态码和 `detail` 处理错误，不应靠解析自然语言文案做业务判断。
