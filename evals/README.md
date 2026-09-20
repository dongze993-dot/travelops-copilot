# 评测集说明

`v1.jsonl` 是 TravelOps Copilot 的版本化 HTTP 黑盒评测集。每一行是一个 JSON 对象，代表一个可独立审查的用例，而不是一份提前填好的成绩单。

`v2-llm.jsonl` 是模型增强路径的独立测试集。它不能替代 v1：v1 保护确定性 API，v2 仅在显式真实 API 运行时记录模型 JSON、来源白名单、逐日覆盖与降级行为。详见 [模型评测规范](../docs/model-evaluation.md)。

## 运行

先启动服务，再运行：

```bash
python scripts/run_eval.py --base-url http://127.0.0.1:8000 --suite evals/v1.jsonl
```

评测器只通过公开 HTTP API 访问服务，不导入 `app/` 中的函数。运行后的 JSON 报告默认写入 `reports/`，包含请求状态、断言、耗时和 suite 哈希。报告未生成前，请不要在简历或 README 中写通过率。

## 用例覆盖（v1）

| 维度 | 内容 | 数量 |
| --- | --- | ---: |
| 服务与知识检索 | 健康检查、城市/兴趣过滤、空覆盖与分页边界 | 10 |
| 正常规划 | 行程结构、默认偏好、预算、引用和工作流轨迹 | 11 |
| 输入边界 | 天数、人数、预算、枚举、空字符串、长度 | 9 |
| 模拟工单 | 自动建单、手动建单、查询、列表与错误处理 | 8 |
| 数据边界 | 合成来源 URI、引用结构、非实时数据标识 | 4 |
| **合计** |  | **42** |

## 用例覆盖（v2）

| 维度 | 内容 | 数量 |
| --- | --- | ---: |
| 可调用模型的正常请求 | 9 个演示城市、多天/多人、兴趣与预算档位 | 18 |
| 预算降级 | 极低预算时不把不合格方案交给模型 | 6 |
| 知识空覆盖降级 | 未知城市不交给模型、不伪造来源 | 6 |
| **合计** |  | **30** |

真实模型运行方式：

```bash
python scripts/run_model_eval.py --base-url http://127.0.0.1:8000 --suite evals/v2-llm.jsonl --require-llm
```

不要把 API Key 写入测试集或 CI。省略 `--require-llm` 时，脚本可用于验证模型关闭时的降级契约，但该结果不是模型效果报告。

## 用例结构

```json
{
  "case_id": "V1-001",
  "version": "v1",
  "title": "健康检查返回确定性 mock 模式",
  "automatable": true,
  "request": {
    "method": "GET",
    "path": "/health"
  },
  "assertions": [
    {"op": "status_code", "value": 200},
    {"op": "path_equals", "path": "status", "value": "ok"}
  ],
  "tags": ["contract", "health"],
  "source_scope": "no external data"
}
```

### 断言操作

| `op` | 用途 |
| --- | --- |
| `status_code` | 比对 HTTP 状态码 |
| `path_exists` / `path_is_null` / `path_not_null` | 检查 JSON 路径存在或空值状态 |
| `path_equals` / `path_type` | 比对字段值或 JSON 类型 |
| `path_length_eq` / `path_length_gte` | 检查数组/字符串/对象长度 |
| `path_gte` / `path_lte` | 数值比较 |
| `path_contains` / `path_starts_with` | 字符串或数组成员比较 |
| `array_contains_path` | 数组中是否有元素的子字段等于给定值 |
| `array_all_path_starts_with` | 数组中每个元素的子字段是否拥有预期前缀 |

路径用点号表示，例如 `validation.passed`、`itinerary.0.items.0.source_id`。数组下标从 0 开始。

## 动态夹具

部分用例先创建模拟工单，再在下一条用例中查询。创建用例通过：

```json
"captures": {"fixture_ticket_id": "ticket_id"}
```

保存返回值；后续路径可写为 `/api/v1/tickets/{{fixture_ticket_id}}`。这只是本地演示数据库中的临时记录，不使用或产生真实客服数据。

## 维护规则

1. 修改 API 的公开字段、状态码或输入范围时，同时更新对应评测；
2. 新增功能前先补一条成功用例和一条失败/边界用例；
3. 不将 API Key、真实姓名、电话、订单、真实 URL 参数或客户文本写入用例；
4. 不为了让评测通过而删除失败用例；应记录原因、修复后复跑；
5. 如结果依赖随机模型，记录模型/提示词/温度，并将确定性契约断言与人工质量评审分开。
