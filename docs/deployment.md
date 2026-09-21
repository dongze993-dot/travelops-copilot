# 公共演示部署说明

本仓库提供三种刻意区分的演示形态。部署前先选择要验证的范围，不要把较轻量的演示描述为完整 Python 服务的线上运行。

| 形态 | 入口配置 | 实际运行内容 | 适合验证 | 明确不包含 |
| --- | --- | --- | --- | --- |
| Docker Web Service | `render.yaml` / `Dockerfile` | 当前 Python、FastAPI、LangGraph 与 SQLite 模拟工单 | 完整 HTTP API、`/docs`、公开模式下的工单关闭边界 | 真实 CRM、实时旅游数据、公开模型调用 |
| 浏览器静态预览 | `render-static.yaml` | 访问者浏览器中的确定性 JavaScript | 页面交互、合成检索、预算与引用展示 | HTTP API、Python、LangGraph、SQLite、DeepSeek |
| Netlify Functions API 演示 | `netlify.toml` | 静态前端 + Node.js Serverless Functions | 前端通过 HTTP 调用公开、无状态的合成 API | Python、FastAPI、LangGraph、SQLite、DeepSeek、`/docs` |

三个形态都只使用仓库中的合成数据。它们都不是订票、支付、CRM 或真实旅游信息服务。

## Docker Web Service 的部署范围

- 公共 URL 提供前端、v1/v2 接口文档和合成数据的确定性演示；
- `TRAVELOPS_LLM_ENABLED=false`，因此公开服务不会向 DeepSeek 发送请求；
- `TRAVELOPS_PUBLIC_DEMO_MODE=true`，因此公开服务拒绝所有模拟工单读写和自动建单请求，页面也不显示工单表单；
- `/health` 会返回 `public_demo_mode: true`，可用于确认上述边界已生效；
- 不包含真实客户资料、订单、支付、地图、实时旅游数据或任何生产承诺。

这样做是有意的安全边界：当前公开接口没有用户鉴权、限流或单用户额度控制。若直接启用带有个人 Key 的模型路径，任何访问者都可能消耗账户额度。真实 DeepSeek 接入和评测的代码与去敏报告仍保留在仓库，供实现审查。

## Render Docker Web Service 部署步骤

1. 注册或登录 [Render](https://render.com)，并连接 GitHub 账号；
2. 可以选择 **New → Blueprint** 让 Render 读取根目录的 `render.yaml`；也可以选择 **New → Web Service**，选择本仓库 `dongze993-dot/travelops-copilot` 的 `main` 分支与 Docker 运行时；
3. 确认服务名、区域和可用套餐后创建。若使用 Web Service 表单，按 `render.yaml` 配置 `TRAVELOPS_LLM_ENABLED=false`、`TRAVELOPS_PUBLIC_DEMO_MODE=true` 与健康检查路径 `/health`；
4. 等待构建完成。健康检查路径是 `/health`；
5. 打开 Render 分配的 `https://<服务名>.onrender.com/`，再检查 `/health` 和 `/docs`。

Render 从 Git 仓库构建 Docker 镜像并为 Web Service 提供公开子域名；服务必须绑定到 `0.0.0.0` 和平台提供的端口。当前 Dockerfile 已兼容 `PORT` 环境变量。详见 [Render Web Services 文档](https://render.com/docs/web-services) 与 [Render Blueprint 规范](https://render.com/docs/blueprint-spec)。

## Netlify Functions API 演示

Netlify 不是本项目 Python/FastAPI 服务的运行环境。本仓库的 [`netlify.toml`](../netlify.toml) 会构建一个静态前端，并把 `netlify/functions/` 中的 Node.js 函数映射为公开 API。函数只读取仓库内的合成景点 JSON 并执行确定性规则；没有模型供应商请求、没有 SQLite，也没有模拟工单持久化。

### 在 Netlify 创建站点

1. 登录 Netlify，选择 **Add new site → Import an existing project → GitHub**；
2. 选择仓库 `dongze993-dot/travelops-copilot`，分支选择 `main`；
3. 保持根目录为空。Netlify 检测到根目录的 `netlify.toml` 后，确认以下配置；若界面要求手填，就按下表填写：

| 表单字段 | 填写值 |
| --- | --- |
| Base directory / Root directory | 留空 |
| Build command | `node scripts/build_netlify_demo.mjs` |
| Publish directory | `dist-netlify-demo` |
| Functions directory | `netlify/functions`（由 `netlify.toml` 设置） |
| Environment variables | 不添加 |

4. 不要填入 `DEEPSEEK_API_KEY`、模型名、SQLite 路径或任何个人数据。此适配层固定关闭模型调用；
5. 点击部署，等待构建完成。部署成功后站点地址通常形如 `https://<site-name>.netlify.app/`。

本仓库的发布目录不是常见的 `_site`、`dist` 或 `public`。必须使用 `dist-netlify-demo`，因为构建脚本会把前端资源复制并重写为 Netlify 可发布的相对路径。`netlify/functions` 是函数源码目录，不是静态网页的发布目录。

### Netlify API 范围

| 方法 | 路径 | 预期行为 |
| --- | --- | --- |
| `GET` | `/health` | 返回 `public_demo_mode: true`、`deployment: "netlify_functions"`、`model_calls_enabled: false` |
| `GET` | `/api/v1/attractions` | 使用 `destination`、可选 `interests` 和 `limit` 查询合成数据 |
| `POST` | `/api/v1/plans` | 返回确定性行程、预算、引用和 Netlify Function 执行轨迹 |
| `POST` | `/api/v2/plans` | 返回同一确定性结果，并含 `generation.mode: "deterministic_fallback"`、`fallback_code: "llm_disabled"` |
| `GET` / `POST` | `/api/v1/tickets`、`/api/v1/tickets/*` | 固定返回 `403`，不读写工单 |

`/api/plan` 是 v1 规划接口的兼容路径；`/api/tickets` 与 `/api/tickets/*` 是工单关闭边界的兼容路径。页面在读取 `/health` 后会显示“Netlify API 公开演示”，隐藏模型和工单入口，也不会发送备注字段。不要把这个适配层称为 FastAPI、LangGraph 或 DeepSeek 的线上部署。

### Netlify 部署后验收

将 `<site>` 换成实际公开地址。以下命令可在任意 HTTP 客户端中执行；Windows PowerShell 建议使用 `curl.exe`：

```bash
curl.exe -sS https://<site>.netlify.app/health
```

预期 JSON 至少含有：

```json
{
  "status": "ok",
  "public_demo_mode": true,
  "deployment": "netlify_functions",
  "model_calls_enabled": false
}
```

随后验证 v1 规划接口。示例只含合成请求字段，不能替换为真实联系人或个人备注：

```bash
curl.exe -sS -X POST "https://<site>.netlify.app/api/v1/plans" -H "content-type: application/json" -d '{"destination":"杭州","days":2,"travelers":2,"total_budget_cny":1200,"interests":["自然","文化"],"travel_style":"balanced","create_follow_up_ticket":false}'
```

响应应包含 `plan_id`、`itinerary`、`budget`、`citations`、`validation` 和 `workflow_trace`，且引用 URI 以 `synthetic://` 开头。再检查两个公开边界：

```bash
curl.exe -sS -X POST "https://<site>.netlify.app/api/v2/plans" -H "content-type: application/json" -d '{"destination":"杭州","days":2,"travelers":2,"total_budget_cny":1200,"interests":["自然"],"travel_style":"balanced"}'

curl.exe -i https://<site>.netlify.app/api/v1/tickets
```

第一条应返回 `200`，且 `generation` 明确为 `deterministic_fallback` / `llm_disabled`；第二条应返回 `403`。打开首页后，确认页面顶部标明 Netlify API 公开演示。`/docs` 不属于此部署形态；需要 OpenAPI 页面、原始 Python 工作流或本地模型评测时，请运行 Docker Web Service 或本机服务。

## Render Static Site：浏览器内确定性预览

如果账户无法创建 Web Service，也可以部署根目录的 `render-static.yaml` 对应的静态版本。它是一个真实可交互的网页，但工作发生在访问者浏览器内：网页只加载仓库中的合成景点 JSON，并在本地执行确定性检索、预算和一次受控修订。它**不**运行 FastAPI、LangGraph、DeepSeek、SQLite 或模拟工单接口。

在 Render 选择 **New → Static Site** 后填写：

| 字段 | 填写值 |
| --- | --- |
| Source repository | `dongze993-dot/travelops-copilot` |
| Name | `travelops-static-demo-dongze` |
| Branch | `main` |
| Root Directory | 留空 |
| Build Command | `node scripts/build_static_demo.mjs` |
| Publish Directory | `dist-static-demo` |
| Environment Variables | 不添加 |

部署完成后，页面顶部会显示“静态浏览器演示”，并明确说明不应输入个人信息。工单、模型开关和补充说明输入均会隐藏；未知城市不会借用其他城市的条目，也不会伪造引用。若需要验证完整 HTTP API、LangGraph 或本地可选模型路径，请使用前一节的 Docker Web Service 或本机运行方式。

## 上线验收记录模板

部署后，在 GitHub 新增一笔只包含真实信息的提交或 issue，记录：

- 部署日期、公开 URL、对应 Git commit；
- `/health` 的 HTTP 状态和返回字段；
- Docker Web Service 时：首页与 `/docs` 是否可访问；静态预览和 Netlify 形态不应记录为提供 `/docs`；
- 本次公开实例是否保持模型关闭和 `public_demo_mode=true`（Netlify 还应记录 `deployment: "netlify_functions"`）；
- 已知限制，例如免费实例冷启动、合成数据与公共工单流程已关闭。

不要记录 API Key、内部日志、真实联系人或任何未授权数据。
