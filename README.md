# TravelOps Copilot

> 面向旅行运营场景的 AI 应用工程 PoC：把**行程知识检索、约束校验、可解释行程草案与模拟工单流转**串成一个可本地运行、可审计的工作流。

> **项目状态：v0.3 / 已完成一次受控真实 API 评测，并提供免费公开资料查询演示。** 仓库内 v1/v2 的景点、价格、营业时间、来源与联系人均为作者原创的虚构/合成示例。Netlify v3 只读查询中文维基导游和中文维基百科，不需要账号、绑卡或 API Key；它不等同于实时票务、报价、地图导航、预订、CRM 或支付服务，任何结果均需在原始来源页核验。

> **关于 AI 的真实边界：** `/api/v1/plans` 是可复跑的确定性基线。`/api/v2/plans` 支持可选 DeepSeek 模型调用，但仅用于解释已校验的合成候选；模型不能改写来源、预算、行程和模拟工单。仓库保留了一次固定合成测试集上的真实 API 原始报告；该报告只说明本次配置下的接口、结构化输出和受控来源校验，不代表模型整体能力、真实旅游准确率、生产 SLA、成本或真实业务效果。

## 为什么做这个项目

旅行运营团队常需要在有限预算、天数、兴趣偏好与服务问题之间给出可追溯的建议。这个项目刻意将一个抽象的“大模型聊天”需求拆成可验证的工程问题：

1. 从受控知识库中筛选候选内容，并保留来源标识；
2. 根据天数、人数、预算与偏好生成行程草案；
3. 返回预算与约束校验，而不是只给一段自然语言；
4. 当用户需要人工跟进时，通过结构化 API 创建**模拟工单**；
5. 用版本化评测集验证接口契约、预算约束与可追溯字段。

项目重点不是把“AI”当作黑盒，而是将需求拆解、API 对接、JSON 数据契约、数据边界、部署与验收做成可审查的工程链路。

## 演示范围与边界

**可演示：** 检索虚构目的地条目、生成结构化行程草案、预算/约束检查、引用合成来源、创建和查询模拟工单。

**不声称具备：** 真实订单履约、已核验的实时价格/营业时间、地图导航/航班、真实 CRM 授权、生产级安全审计、医疗/安全建议或用户个人信息处理。

这一区分很重要：它是“本地 PoC / 模拟业务接口”，不应描述为已上线的真实旅游服务。

**公共主机边界：** 当 `TRAVELOPS_PUBLIC_DEMO_MODE=true` 时，页面会隐藏模拟工单入口，所有工单读取/创建接口以及任何带 `create_follow_up_ticket=true` 的规划请求都会返回 `403`。公开实例保持无状态，不应接收个人信息；`/health` 会返回 `public_demo_mode` 供外部验收。

## 技术栈

| 层 | 当前实现 | 能说明什么 |
| --- | --- | --- |
| API | Python、FastAPI、Pydantic | 请求校验、OpenAPI、结构化 JSON 契约 |
| 工作流 | LangGraph `StateGraph` | 显式状态、分支、一次受控修订和执行轨迹 |
| 模型适配（v2 可选） | DeepSeek Chat Completions HTTP API、JSON 输出、版本化提示词 | 真实 API 对接、结构化输出、token/延迟元数据、失败降级 |
| 知识层 | 本地 JSON、可追溯的合成来源 ID | 受控检索、来源返回与空覆盖降级 |
| 免费公开资料查询（Netlify v3） | 中文维基导游 / 中文维基百科只读查询、服务端来源清洗、短时缓存与函数限流 | 无 Key 的公开资料查询、来源 URL/获取时间、敏感字段最小化与诚实降级 |
| 集成模拟 | SQLite 模拟 CRM 工单 | 创建/查询接口、字段映射、人工跟进边界 |
| 交付 | Docker Compose、健康检查、README、API 文档 | 可本地复现的 PoC 交付 |
| 质量 | HTTP 黑盒评测、版本化 JSONL 用例 | 从公开接口验证，不依赖内部函数 |

## 快速开始

### 方式 A：本机运行

```bash
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

默认状态下，v2 也会安全地保持确定性，不会发送任何模型请求。要做真实 API 评测时，复制 `.env.example` 为 `.env`，仅在本机填写 `DEEPSEEK_API_KEY` 与控制台显示的模型标识，再将 `TRAVELOPS_LLM_ENABLED=true`。密钥绝不应进入 Git、聊天、截图、前端代码或 CI。详见 [模型评测规范](docs/model-evaluation.md)。

打开 `http://127.0.0.1:8000/docs` 查看交互式 API 文档，或执行：

```bash
curl http://127.0.0.1:8000/health
```

### 方式 B：容器运行

```bash
docker compose up --build
```

容器启动后仍可访问 `http://127.0.0.1:8000/docs`。若本仓库的容器配置与本文不同，以 `docker-compose.yml` 和服务日志为准。

### 公共演示部署

仓库根目录的 [`render.yaml`](render.yaml) 已为 Render Docker Web Service 准备好 Blueprint，Docker 镜像也会读取平台提供的 `PORT`。公共实例刻意将模型调用保持关闭，并启用 `TRAVELOPS_PUBLIC_DEMO_MODE=true`，避免未鉴权公开接口消耗个人 API 额度或写入工单内容；真实 DeepSeek 接入与评测证据保留在本仓库中。完整注册、部署和验收步骤见 [公共演示部署说明](docs/deployment.md)。

如果托管平台只提供静态站点，可使用独立的 [`render-static.yaml`](render-static.yaml)。它构建一个**浏览器内确定性预览**：只加载本仓库的合成 JSON，在访问者浏览器内生成结果；它不运行 FastAPI、LangGraph、DeepSeek 或 SQLite 模拟工单。该部署形式适合演示页面交互，不应描述为完整后端的线上运行。

也可以使用根目录的 [`netlify.toml`](netlify.toml) 部署 **Netlify Functions API 演示**。它会构建静态前端，并提供下列无服务器 HTTP 路由：

| 路由 | Netlify 演示行为 |
| --- | --- |
| `GET /health` | 返回公开演示状态、合成资料条数和 `deployment: "netlify_functions"` |
| `GET /api/v1/attractions` | 查询同一份合成景点 JSON |
| `POST /api/v1/plans` | 返回确定性行程、预算、引用和执行轨迹 |
| `POST /api/v2/plans` | 返回确定性结果，并明确标记 `llm_disabled` 降级 |
| `GET /api/v3/free-attractions` | 免费公开资料来源卡片；无需账号、绑卡或 API Key |
| `POST /api/v3/free-plans` | 以同次免费公开资料组织候选日程与粗略游玩预算区间；不把摘要伪装成实时报价 |
| `/api/v1/tickets` 与兼容旧路径 | 固定返回 `403`，不写入任何工单 |

Netlify 版本**不是**当前 Python/FastAPI/LangGraph 服务的原样运行：它不启动 Python、LangGraph、SQLite、DeepSeek，也不提供 `/docs`。v1/v2 仅复用受控合成数据和确定性规划规则；v3 用免费、只读的中文维基导游和中文维基百科资料补充未知城市或县城。它不需要、也不会配置 DeepSeek API Key。选择、部署和验收的精确步骤见 [Netlify Functions API 演示](docs/deployment.md#netlify-functions-api-演示) 与 [免费公开资料说明](docs/live-retrieval.md)。

## 主要 API（v1）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 服务存活检查 |
| `GET` | `/api/v1/attractions` | 按目的地、兴趣查询合成知识库 |
| `POST` | `/api/v1/plans` | 生成结构化行程草案及校验结果 |
| `POST` | `/api/v2/plans` | 在 v1 基线之上返回经过 JSON/来源白名单校验的可选模型说明 |
| `GET` | `/api/v3/free-attractions` | 获取可打开、带获取时间的免费公开资料来源 |
| `POST` | `/api/v3/free-plans` | 以同次免费公开资料组织候选日程和粗略游玩预算区间，不作实时价格/可订性承诺 |
| `POST` | `/api/v1/tickets` | 创建本地模拟人工跟进工单；公共演示返回 `403` |
| `GET` | `/api/v1/tickets/{ticket_id}` | 查询本地模拟工单；公共演示返回 `403` |
| `GET` | `/api/v1/tickets` | 查询本地模拟工单；公共演示返回 `403` |

接口的输入、输出与字段语义请看 [API 契约](docs/api-contract.md)。以下是一个规划请求示例：

```json
{
  "destination": "杭州",
  "days": 2,
  "travelers": 2,
  "total_budget_cny": 1200,
  "interests": ["自然", "文化"],
  "travel_style": "balanced",
  "create_follow_up_ticket": true,
  "contact_name": "演示用户"
}
```

## 证据与评测

- [数据说明与来源清单](data/README.md)：说明为什么样例数据是虚构的、可如何安全替换；
- [架构说明](docs/architecture.md)：组件、数据流和失败边界；
- [评测说明](evals/README.md)：版本化用例、覆盖维度与运行方式；
- [指标口径](docs/metrics.md)：如何计算，而不是提前声称结果；
- [模型评测规范](docs/model-evaluation.md)：真实 API 接入后如何生成可复跑、去敏的模型证据；
- [架构决策 ADR-0001](docs/decisions/0001-public-demo-boundary.md)：公开演示为何关闭工单读写，以及如何验证该边界；
- [免费公开资料说明](docs/live-retrieval.md)：v3 的免费来源边界、隐私限制、缓存与验收方法；

运行评测（服务启动后）：

```bash
python scripts/run_eval.py --base-url http://127.0.0.1:8000 --suite evals/v1.jsonl
```

脚本会将带时间戳的**原始报告**写到 `reports/`（若目录不存在会创建）。引用任何指标时，都应保留对应报告，并写明运行日期、数据版本、用例数和环境。

### 当前可复验证据

本仓库保留了一份本地基线报告：[eval-v0.1-final.json](reports/eval-v0.1-final.json)。它于 `2026-09-20` 在 Windows 11 / Python 3.12.14 环境中，以本仓库 `synthetic-v1`（12 条合成知识记录）和 `evals/v1`（42 条 HTTP 契约用例）运行：**42/42 条用例通过**。本次成功请求的本地延迟 P50 为 `5.19 ms`、P95 为 `16.05 ms`，仅用于后续本机回归对比。

这个数字仅表示该次本地运行中，合成数据下的 API 契约、输入边界、工作流字段和模拟工单接口符合用例预期；不表示真实旅游信息准确、真实订单可用、真实 CRM 已集成或存在用户业务效果。报告中保留了 suite 哈希、执行环境、逐条断言和复跑入口。

### v2 当前离线证据（不是模型效果）

[`model-eval-v2-disabled-local.json`](reports/model-eval-v2-disabled-local.json) 记录了 v2 在模型明确关闭时的 30/30 条合成场景回归：18 条未来可调用模型的正常请求、6 条低预算降级、6 条未知城市降级均符合接口预期。该次 `llm_augmented=0`，因此它只能证明模型关闭/降级路径与评测器可复跑；它**不能**用于宣传 DeepSeek 模型效果。真实模型指标必须通过 `scripts/run_model_eval.py --require-llm` 生成新报告。

### v2 真实 API 受控评测（2026-09-20）

原始报告 [`model-eval-20260920T163704Z.json`](reports/model-eval-20260920T163704Z.json) 由 `scripts/run_model_eval.py --require-llm` 以 HTTP 黑盒方式生成，运行于 Windows 10 / Python 3.11.9，固定 `evals/v2-llm.jsonl`（30 条仓库自编合成案例）。当次返回的模型标识为 `deepseek-flash`，提示词版本为 `travelops-v2.0.0`：**30/30 条契约与受控来源断言通过**；18 条可调用模型案例均返回 `llm_augmented`；这 18 条的来源白名单与逐日覆盖均通过。成功请求端到端延迟 P50/P95 为 `4207.76 / 6540.23 ms`，供应商调用延迟 P50/P95 为 `4520.70 / 6530.00 ms`；18 条增强输出均返回 usage，合计 `9,932` 输入 token、`4,820` 输出 token。

这些数字只针对该次本地网络、该模型返回、该提示词和合成用例，且用例只验证 JSON 结构、来源白名单、逐日覆盖与降级分支；它们**不代表**真实旅行信息正确率、回答主观质量、生产性能、供应商 SLA、固定成本或用户效果。报告不含密钥、原始提示词内容或真实用户数据。

## 建议的提交粒度

不要一次性把项目“堆完”再上传。较可信的节奏是每完成一个可运行的切片就提交一次，例如：

1. `chore: initialize FastAPI service and health check`
2. `feat: add synthetic travel knowledge retrieval`
3. `feat: add structured itinerary planning and validation`
4. `feat: add simulated follow-up ticket workflow`
5. `test: add versioned API and constraint evaluation suite`
6. `docs: add architecture, data provenance, and demo guide`

提交信息应对应实际变化。不得伪造提交时间、线上客户、用户数、节省工时或评测通过率。

## 仓库结构

```text
app/                 # 服务与工作流实现
data/                # 原创合成知识数据及来源/使用说明
docs/                # 架构、API、指标与演示文档
evals/               # 版本化评测用例
netlify/             # Netlify Functions API 演示适配层（不运行 Python 服务）
scripts/             # 不依赖内部实现的 HTTP 评测工具
tests/               # 自动化测试（如有）
```

## 安全与隐私

- 不提交 API Key、令牌、真实联系人、真实订单或真实客户数据；
- 本项目的 `contact_name` 仅用于本地演示，不应被视作生产级个人信息处理；
- 若替换为公开数据，应先记录来源、许可、获取日期与变更方式；
- 若接入真实外部系统，应额外完成鉴权、最小权限、日志脱敏、速率限制、输入校验和人工审批设计。

## 下一步

在 PoC 跑通后，可以选择一个方向继续深化，而不是无边界加功能：

- 替换为经授权的公开旅游数据，并保留来源快照与许可记录；
- 为检索增加可观察性（命中来源、空结果、失败原因）；
- 为工单流转增加幂等键、审批状态和审计日志；
- 引入真实大模型前，增加提示词版本、输出约束、回归集与人工验收。

详见 [架构说明](docs/architecture.md) 与 [数据治理说明](docs/data-governance.md)。
