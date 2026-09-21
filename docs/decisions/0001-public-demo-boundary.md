# ADR-0001：公开演示使用无状态规划边界

- 状态：已接受
- 日期：2026-09-21

## 背景

TravelOps Copilot 的本地 PoC 包含 SQLite 模拟工单，用来验证规划工作流与业务交接的接口契约。公开部署时，该接口没有登录、用户隔离、速率限制或生产级个人信息治理能力。若保持工单读写开放，访问者可能提交不应存储的内容。

公开实例同样不应使用个人 DeepSeek API Key。无鉴权的模型接口会暴露账户额度消耗面。

## 决策

公开服务设置：

```text
TRAVELOPS_PUBLIC_DEMO_MODE=true
TRAVELOPS_LLM_ENABLED=false
```

在这一模式下：

1. `POST /api/v1/tickets`、`GET /api/v1/tickets` 与按 ID 查询均返回 `403`；
2. v1/v2 规划请求若传入 `create_follow_up_ticket=true`，在工作流创建工单前返回 `403`；
3. `/health` 返回 `public_demo_mode: true`；
4. 前端根据 `/health` 隐藏工单入口，并展示不提交个人信息的提示；
5. 本地默认仍为 `false`，以保留模拟 CRM 的开发与契约测试路径。

## 后果

- 公开站可演示受控检索、规划、校验、引用和模型关闭时的降级行为；
- 公开站不演示工单持久化，任何真实 CRM 接入须另行设计鉴权、最小权限、审计、限流与数据保留策略；
- 此开关是演示范围控制，不构成生产访问控制方案；
- Docker CI 会构建镜像、启动公开模式容器，断言健康字段和工单 `403` 行为。

## 验证入口

- `tests/test_api.py::test_public_demo_blocks_ticket_workflows_but_keeps_planning_available`
- `.github/workflows/ci.yml` 的 `Docker public-demo smoke` 任务
- [公共演示部署说明](../deployment.md)
