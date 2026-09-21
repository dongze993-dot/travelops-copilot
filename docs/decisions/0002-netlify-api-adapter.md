# ADR-0002：Netlify 使用确定性 API 适配层

- 状态：已接受
- 日期：2026-09-21

## 背景

TravelOps Copilot 的规范实现是 Python/FastAPI 服务：它通过 LangGraph 编排规划流程，并在本地使用 SQLite 模拟工单。部分静态托管平台不能原样运行这套服务，但仍需要一个能让前端发起真实 HTTP 请求、返回可验证 JSON 的公开演示形态。

公开演示也不应暴露个人模型密钥或让未鉴权访问者写入模拟工单。因此，不能把现有 Python 服务、SQLite 或 DeepSeek 调用直接搬到这个轻量部署中。

## 决策

根目录的 `netlify.toml` 将：

1. 通过 `node scripts/build_netlify_demo.mjs` 构建静态前端，并发布 `dist-netlify-demo`；
2. 将 `netlify/functions/` 作为 Node.js Serverless Functions 源码目录；
3. 让函数复用仓库内的合成景点 JSON 和确定性规划规则；
4. 暴露 `/health`、景点检索、v1 规划和 v2 规划路由；
5. 固定关闭模型调用。v2 返回带 `llm_disabled` 的确定性降级元数据，而不是发送供应商请求；
6. 固定拒绝所有模拟工单读写及自动建单请求，返回 `403`；
7. 在 `/health` 标记 `public_demo_mode: true`、`deployment: "netlify_functions"` 和 `model_calls_enabled: false`，让前端和验收方识别该形态。

此适配层不启动 Python、FastAPI、LangGraph 或 SQLite，也不提供 OpenAPI `/docs`。它是与完整应用并存的公开 API 演示，而不是替代实现或生产迁移。

## 后果

- 访问者可以从网页或 HTTP 客户端验证 JSON 契约、同城合成检索、确定性预算与引用，以及公开模式下的工单关闭边界；
- v2 接口仍保留形状稳定的 `generation` 字段，但不能证明模型调用、模型质量、供应商可用性或性能；
- 完整 FastAPI/LangGraph/SQLite 行为仍应通过本机运行或 Docker Web Service 验证；
- Netlify 站点无需配置 API Key 或数据库相关环境变量，也不应接收个人信息；
- 构建和函数契约由自动化测试覆盖；部署后的人工验收步骤见 [公共演示部署说明](../deployment.md#netlify-functions-api-演示)。

## 验证入口

- `tests/netlify_api.test.mjs`
- `scripts/build_netlify_demo.mjs`
- `GET /health`、`POST /api/v1/plans`、`POST /api/v2/plans` 与工单 `403` 检查
- [公共演示部署说明](../deployment.md#netlify-functions-api-演示)
