# HTTP API 契约（v1）

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
  "knowledge_records": 12
}
```

`knowledge_records` 为当前加载的合成资料条数，随数据版本变化；调用方不应把健康检查视为真实外部服务可用性的证明。

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
