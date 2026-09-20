# TravelOps Copilot

> 面向旅行运营场景的 AI 应用工程 PoC：把**行程知识检索、约束校验、可解释行程草案与模拟工单流转**串成一个可本地运行、可审计的工作流。

> **项目状态：v0.2 / 模型增强路径已实现，等待真实 API 验证。** 仓库内的景点、价格、营业时间、来源与联系人均为作者原创的虚构/合成示例，不能用于订票、出行、安全或商业决策；项目不连接真实票务、CRM、支付或第三方地图服务。

> **关于 AI 的真实边界：** `/api/v1/plans` 是可复跑的确定性基线。`/api/v2/plans` 支持可选 DeepSeek 模型调用，但仅用于解释已校验的合成候选；模型不能改写来源、预算、行程和模拟工单。真实 API 的首次评测报告尚未生成，因此本仓库不声称任何模型通过率、延迟、token、成本或真实业务效果。

## 为什么做这个项目

旅行运营团队常需要在有限预算、天数、兴趣偏好与服务问题之间给出可追溯的建议。这个项目刻意将一个抽象的“大模型聊天”需求拆成可验证的工程问题：

1. 从受控知识库中筛选候选内容，并保留来源标识；
2. 根据天数、人数、预算与偏好生成行程草案；
3. 返回预算与约束校验，而不是只给一段自然语言；
4. 当用户需要人工跟进时，通过结构化 API 创建**模拟工单**；
5. 用版本化评测集验证接口契约、预算约束与可追溯字段。

它适合作为 AI 应用开发 / FDE / 解决方案交付方向的作品集：重点不是把“AI”当作黑盒，而是展示需求拆解、API 对接、JSON 数据契约、数据边界、部署与验收意识。

## 能力映射

| 岗位常见要求 | 本项目中的可审查证据 |
| --- | --- |
| Python 与后端 API | FastAPI 服务、请求模型、JSON 响应与健康检查 |
| AI 应用 / 受控检索思路 | 受控知识检索、来源引用、无证据时的降级提示（不把合成数据包装成事实） |
| Workflow / 结构化工具适配 | LangGraph 的 `parse → retrieve → plan → validate → revise_once? → finalize` 工作流，以及类型化的模拟工单工具边界 |
| 企业系统对接意识 | 模拟 CRM 工单 API、优先级/联系人等结构化字段；真实系统对接不在本 PoC 范围内 |
| Docker 与交付 | 本地容器化启动说明、健康检查、接口文档与可复现实验入口 |
| 质量与复盘 | 版本化评测用例、原始 JSON 报告、指标定义与复跑入口 |

## 演示范围与边界

**可演示：** 检索虚构目的地条目、生成结构化行程草案、预算/约束检查、引用合成来源、创建和查询模拟工单。

**不声称具备：** 真实订单履约、实时价格/营业时间、真实地图/航班、真实 CRM 授权、生产级安全审计、医疗/安全建议或用户个人信息处理。

这一区分很重要：在简历或面试中，请称它为“本地 PoC / 模拟业务接口”，不要称作已上线的真实旅游服务。

## 技术栈

| 层 | 当前实现 | 能说明什么 |
| --- | --- | --- |
| API | Python、FastAPI、Pydantic | 请求校验、OpenAPI、结构化 JSON 契约 |
| 工作流 | LangGraph `StateGraph` | 显式状态、分支、一次受控修订和执行轨迹 |
| 模型适配（v2 可选） | DeepSeek Chat Completions HTTP API、JSON 输出、版本化提示词 | 真实 API 对接、结构化输出、token/延迟元数据、失败降级 |
| 知识层 | 本地 JSON、可追溯的合成来源 ID | 受控检索、来源返回与空覆盖降级 |
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

## 主要 API（v1）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 服务存活检查 |
| `GET` | `/api/v1/attractions` | 按目的地、兴趣查询合成知识库 |
| `POST` | `/api/v1/plans` | 生成结构化行程草案及校验结果 |
| `POST` | `/api/v2/plans` | 在 v1 基线之上返回经过 JSON/来源白名单校验的可选模型说明 |
| `POST` | `/api/v1/tickets` | 创建模拟人工跟进工单 |
| `GET` | `/api/v1/tickets/{ticket_id}` | 查询模拟工单 |
| `GET` | `/api/v1/tickets` | 按状态或合成联系人查询模拟工单 |

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
- [演示验收清单](docs/demo-checklist.md)：录屏、面试与交付前自查。

运行评测（服务启动后）：

```bash
python scripts/run_eval.py --base-url http://127.0.0.1:8000 --suite evals/v1.jsonl
```

脚本会将带时间戳的**原始报告**写到 `reports/`（若目录不存在会创建）。任何简历中的指标都应引用某一次已保存、可复跑的报告，并写明运行日期、数据版本、用例数和环境。

### 当前可复验证据

本仓库保留了一份本地基线报告：[eval-v0.1-final.json](reports/eval-v0.1-final.json)。它于 `2026-09-20` 在 Windows 11 / Python 3.12.14 环境中，以本仓库 `synthetic-v1`（12 条合成知识记录）和 `evals/v1`（42 条 HTTP 契约用例）运行：**42/42 条用例通过**。本次成功请求的本地延迟 P50 为 `5.19 ms`、P95 为 `16.05 ms`，仅用于后续本机回归对比。

这个数字仅表示该次本地运行中，合成数据下的 API 契约、输入边界、工作流字段和模拟工单接口符合用例预期；不表示真实旅游信息准确、真实订单可用、真实 CRM 已集成或存在用户业务效果。报告中保留了 suite 哈希、执行环境、逐条断言和复跑入口。

### v2 当前离线证据（不是模型效果）

[`model-eval-v2-disabled-local.json`](reports/model-eval-v2-disabled-local.json) 记录了 v2 在模型明确关闭时的 30/30 条合成场景回归：18 条未来可调用模型的正常请求、6 条低预算降级、6 条未知城市降级均符合接口预期。该次 `llm_augmented=0`，因此它只能证明模型关闭/降级路径与评测器可复跑；它**不能**用于宣传 DeepSeek 模型效果。真实模型指标必须通过 `scripts/run_model_eval.py --require-llm` 生成新报告。

## 推荐的 GitHub 迭代节奏

不要一次性把项目“堆完”再上传。较可信的节奏是每完成一个可运行的切片就提交一次，例如：

1. `chore: initialize FastAPI service and health check`
2. `feat: add synthetic travel knowledge retrieval`
3. `feat: add structured itinerary planning and validation`
4. `feat: add simulated follow-up ticket workflow`
5. `test: add versioned API and constraint evaluation suite`
6. `docs: add architecture, data provenance, and demo guide`

提交信息应对应实际变化。不要为了作品集伪造提交时间、线上客户、用户数、节省工时或评测通过率。

## 如何把它写进简历（完成并验证后）

下面的表述是**待替换模板**，中括号内必须填入本项目真实生成的报告或实现细节：

> **TravelOps Copilot｜个人 AI 应用工程 PoC**  
> - 使用 Python / FastAPI 实现面向旅行运营的结构化行程规划 API，覆盖受控知识检索、预算约束校验与可选模拟工单创建。  
> - 设计 JSON 契约与工作流追踪字段，将“查询知识—生成草案—验证约束—人工跟进”拆分为可审查步骤；知识库为原创合成数据，未接入真实业务系统。  
> - 建立 `evals/v1` 版本化评测集（42 条 HTTP 契约用例），在 Windows 11 / Python 3.12.14 本地环境生成原始 JSON 报告并通过 42/42 条；该指标仅覆盖合成数据和 API 契约，不代表真实旅游业务效果。

当且仅当完成 v2 的真实 `--require-llm` 运行并保留报告后，才可追加“接入 DeepSeek、模型名、评测集版本、实际通过率、来源白名单率、P50/P95、token 口径”等**报告中的真实数字**。在此之前，不应写成“模型已稳定上线”或杜撰指标。

面试时建议主动说清楚：哪些是你亲自实现的，哪些是借助文档或 AI 编程工具完成的，哪些数据和接口是模拟的。能解释、能复跑、能根据追问修改，远比夸大经历更有说服力。

## 仓库结构

```text
app/                 # 服务与工作流实现
data/                # 原创合成知识数据及来源/使用说明
docs/                # 架构、API、指标与演示文档
evals/               # 版本化评测用例
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
