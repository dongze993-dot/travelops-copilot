# 公共演示部署说明

本仓库包含 `render.yaml`，用于将当前提交部署为 Render Docker Web Service。该配置的目标是让访问者能够打开页面、查看 `/docs` 和验证 `/health`，不是把个人 DeepSeek API Key 暴露给公开互联网。

## 部署范围

- 公共 URL 提供前端、v1/v2 接口文档和合成数据的确定性演示；
- `TRAVELOPS_LLM_ENABLED=false`，因此公开服务不会向 DeepSeek 发送请求；
- `TRAVELOPS_PUBLIC_DEMO_MODE=true`，因此公开服务拒绝所有模拟工单读写和自动建单请求，页面也不显示工单表单；
- `/health` 会返回 `public_demo_mode: true`，可用于确认上述边界已生效；
- 不包含真实客户资料、订单、支付、地图、实时旅游数据或任何生产承诺。

这样做是有意的安全边界：当前公开接口没有用户鉴权、限流或单用户额度控制。若直接启用带有个人 Key 的模型路径，任何访问者都可能消耗账户额度。真实 DeepSeek 接入和评测的代码与去敏报告仍保留在仓库，供实现审查。

## Render 部署步骤

1. 注册或登录 [Render](https://render.com)，并连接 GitHub 账号；
2. 可以选择 **New → Blueprint** 让 Render 读取根目录的 `render.yaml`；也可以选择 **New → Web Service**，选择本仓库 `dongze993-dot/travelops-copilot` 的 `main` 分支与 Docker 运行时；
3. 确认服务名、区域和可用套餐后创建。若使用 Web Service 表单，按 `render.yaml` 配置 `TRAVELOPS_LLM_ENABLED=false`、`TRAVELOPS_PUBLIC_DEMO_MODE=true` 与健康检查路径 `/health`；
4. 等待构建完成。健康检查路径是 `/health`；
5. 打开 Render 分配的 `https://<服务名>.onrender.com/`，再检查 `/health` 和 `/docs`。

Render 从 Git 仓库构建 Docker 镜像并为 Web Service 提供公开子域名；服务必须绑定到 `0.0.0.0` 和平台提供的端口。当前 Dockerfile 已兼容 `PORT` 环境变量。详见 [Render Web Services 文档](https://render.com/docs/web-services) 与 [Render Blueprint 规范](https://render.com/docs/blueprint-spec)。

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
- 首页与 `/docs` 是否可访问；
- 本次公开实例是否保持模型关闭和 `public_demo_mode=true`；
- 已知限制，例如免费实例冷启动、合成数据与公共工单流程已关闭。

不要记录 API Key、内部日志、真实联系人或任何未授权数据。
