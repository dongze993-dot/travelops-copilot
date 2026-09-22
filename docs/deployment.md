# 公共演示部署说明

## 三种演示形态

| 形态 | 实际运行内容 | 能演示什么 | 不包含什么 |
| --- | --- | --- | --- |
| Docker Web Service | Python、FastAPI、LangGraph 与 SQLite 模拟工单 | 完整本地 API、接口文档与受控合成工作流 | 真实 CRM、实时旅游数据、公开模型调用 |
| 浏览器静态预览 | 浏览器内确定性 JavaScript | 页面交互、合成检索、预算与引用展示 | HTTP API、Python、免费公开资料查询 |
| Netlify Functions API 演示 | 静态前端 + Node.js Functions | 合成 API 与免费公开资料查询 | Python、FastAPI、LangGraph、SQLite、DeepSeek、接口文档页 |

Netlify v3 只读查询中文维基导游和中文维基百科，用来补充全国城市和县城资料。它不需要账号、绑卡、付款、DeepSeek Key 或任何新 API Key。

## Netlify Functions API 演示

### 在 Netlify 创建站点

1. 登录 Netlify，选择 Add new site，Import an existing project，GitHub；
2. 选择仓库 dongze993-dot/travelops-copilot，分支选择 main；
3. 保持根目录为空。若表单需要手填，使用下列值：

| 表单字段 | 填写值 |
| --- | --- |
| Base directory / Root directory | 留空 |
| Build command | node scripts/build_netlify_demo.mjs |
| Publish directory | dist-netlify-demo |
| Functions directory | netlify/functions |
| Environment variables | 不添加任何一项 |

4. 不要填写 DeepSeek Key、模型名、SQLite 路径、个人信息或任何其他 Key；
5. 点击部署。部署成功后地址通常形如 https://你的站点名.netlify.app/。

发布目录必须是 dist-netlify-demo。netlify/functions 是函数源码目录，不是发布目录。

## 更新部署

每次 GitHub main 分支有新提交后，Netlify 通常会自动构建。若没有自动触发，在项目的 Deploys 页面点击 Trigger deploy，再选择 Clear cache and deploy site。

这个项目不需要在 Netlify 配置环境变量。页面中的免费联网查找公开资料开关应自动可用。

## 验收

打开首页，输入上饶或任意城市/县城，勾选免费联网查找公开资料，填写游玩天数、人数和游玩预算，点击生成。预期看到：

- 候选日程包含可打开的中文维基导游或中文维基百科来源；
- 联网检索状态显示来源、条数、获取时间和缓存状态；
- 预算只展示景区与体验、餐饮、市内短途、小额伴手礼和机动预留；
- 页面明确该预算不含往返交通与住宿，且不是实时价格；
- 页面不要求输入卡、支付信息、API Key 或个人联系方式。

也可访问下列接口核验：

- GET /health
- GET /api/v3/free-attractions?destination=上饶
- POST /api/v3/free-plans

免费公开资料不是全网搜索。若某个县城没有足够公开条目，系统会如实提示资料不足，而不会编造景点或价格。行前请打开每条来源或官方页面确认票价、营业状态和预约要求。

## 公开边界

公共演示关闭模拟工单读写，关闭公开模型调用，不接收备注字段，也不应处理个人信息。项目不是订票、支付、CRM 或实时旅游服务。
