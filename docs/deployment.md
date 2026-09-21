# 公共演示部署说明

本仓库包含 `render.yaml`，用于将当前提交部署为 Render Docker Web Service。该配置的目标是让招聘方能够打开页面、查看 `/docs` 和验证 `/health`，不是把个人 DeepSeek API Key 暴露给公开互联网。

## 部署范围

- 公共 URL 提供前端、v1/v2 接口文档和合成数据的确定性演示；
- `TRAVELOPS_LLM_ENABLED=false`，因此公开服务不会向 DeepSeek 发送请求；
- 模拟 CRM 使用 `/tmp/travelops_mock_crm.db`，重启或重新部署后工单可能消失；
- 不包含真实客户资料、订单、支付、地图、实时旅游数据或任何生产承诺。

这样做是有意的安全边界：当前公开接口没有用户鉴权、限流或单用户额度控制。若直接启用带有个人 Key 的模型路径，任何访问者都可能消耗账户额度。真实 DeepSeek 接入和评测的代码与去敏报告仍保留在仓库，供技术面试检查。

## Render 部署步骤

1. 注册或登录 [Render](https://render.com)，并连接 GitHub 账号；
2. 选择 **New → Blueprint**，选择本仓库 `dongze993-dot/travelops-copilot` 的 `main` 分支；
3. Render 会读取根目录的 `render.yaml`。确认服务名、区域和可用套餐后创建；
4. 等待构建完成。健康检查路径是 `/health`；
5. 打开 Render 分配的 `https://<服务名>.onrender.com/`，再检查 `/health` 和 `/docs`。

Render 从 Git 仓库构建 Docker 镜像并为 Web Service 提供公开子域名；服务必须绑定到 `0.0.0.0` 和平台提供的端口。当前 Dockerfile 已兼容 `PORT` 环境变量。详见 [Render Web Services 文档](https://render.com/docs/web-services) 与 [Render Blueprint 规范](https://render.com/docs/blueprint-spec)。

## 上线验收记录模板

部署后，在 GitHub 新增一笔只包含真实信息的提交或 issue，记录：

- 部署日期、公开 URL、对应 Git commit；
- `/health` 的 HTTP 状态和返回字段；
- 首页与 `/docs` 是否可访问；
- 本次公开实例是否保持模型关闭；
- 已知限制，例如免费实例冷启动或临时 SQLite 数据。

不要记录 API Key、内部日志、真实联系人或任何未授权数据。
