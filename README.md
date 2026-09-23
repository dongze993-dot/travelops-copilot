# TravelOps Copilot · 旅行计划助手

一个可运行的旅行计划项目：输入中国城市、县城或景区名称，查询公开资料后生成一张按天阅读的游玩计划表，并把地点与费用依据链接保留下来。

公开页面在 Netlify 上运行：[打开在线页面](https://travelops-api-demo-dongze.netlify.app/)。它不需要账号、绑卡、付款或 API Key。

## 在线页面能做什么

1. 填写目的地、游玩天数、人数、游玩预算、偏好和节奏；
2. 免费查询可打开的中文维基导游与中文维基百科公开页面；
3. 按早、中、下午、晚整理每天的资料地点与可自行调整的时间段；
4. 展示公开资料中明确出现的费用原文，并只对计价方式明确且可安全相加的部分做小计；
5. 在计划末尾保留本次使用的资料链接，方便出发前自行确认。

填写的预算是计划上限，不含往返交通与住宿。页面不把没有出处的餐饮、市内出行或伴手礼编成“实时预算”；同一原文里的通票和单票等可选价格也不会相加。票价、营业时间、预约要求会变化，出行前应打开资料来源或官方渠道确认。若公开资料不足，页面会如实提示，而不会编造景点、餐厅或价格。

## 两套运行形态

| 形态 | 实际运行内容 | 适合说明的内容 |
| --- | --- | --- |
| 本地核心项目 | Python、FastAPI、Pydantic、LangGraph、受控合成数据与 SQLite 模拟工单 | API 契约、输入校验、状态编排、预算约束和本地可复现测试 |
| Netlify 公开页面 | 静态前端 + Node.js Netlify Functions + 免费公开资料查询 | 面向游客的按日计划、来源链接和可核验的费用依据 |

两者不是同一个运行时：Netlify 不会启动 Python、FastAPI、LangGraph、SQLite 或 DeepSeek。它是为公开演示准备的轻量适配层，`/api/v3/free-*` 路由只读取免费中文公开资料；本地 Python 服务仍是项目的核心实现。

## 本地运行核心项目

```bash
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

启动后可打开 `http://127.0.0.1:8000/docs` 查看本地 API 文档，或访问：

```bash
curl http://127.0.0.1:8000/health
```

也可以使用容器运行：

```bash
docker compose up --build
```

## Netlify 公开演示

仓库根目录的 [`netlify.toml`](netlify.toml) 已定义构建方式：

```bash
node scripts/build_netlify_demo.mjs
```

构建产物为 `dist-netlify-demo/`。公开页面不需要配置环境变量，也不会调用需要付费或个人密钥的服务。部署和验收说明见 [docs/deployment.md](docs/deployment.md)。

公开演示可核验的路由：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 查看公开演示状态 |
| `GET` | `/api/v3/free-attractions?destination=上饶` | 查询本次可用的公开资料卡片 |
| `POST` | `/api/v3/free-plans` | 根据目的地、天数、人数、预算与偏好生成旅行计划 |

## 项目边界

- 不提供订票、支付、地图导航、实时库存、真实 CRM 或客服服务；
- 不收集个人联系方式，也不向公开页面写入工单；
- 本地核心项目中的景点与工单样例为受控合成数据，不能当作真实旅游资料；
- 免费资料查询不是全网搜索，来源范围、缓存与隐私边界见 [docs/live-retrieval.md](docs/live-retrieval.md)。

## 代码与文档

```text
app/                 # Python/FastAPI/LangGraph 核心实现
frontend/            # 面向游客的页面
netlify/             # Netlify Functions 公开演示适配层
data/                # 受控合成数据及说明
tests/               # 自动化测试
docs/                # 架构、API、部署与资料边界说明
```

- [架构说明](docs/architecture.md)
- [API 契约](docs/api-contract.md)
- [数据说明](data/README.md)
- [部署说明](docs/deployment.md)
- [免费公开资料说明](docs/live-retrieval.md)
