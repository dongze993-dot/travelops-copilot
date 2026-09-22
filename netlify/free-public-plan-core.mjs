/**
 * Planner for results retrieved from free public information pages.
 *
 * Source summaries suggest a visit order. They never become a claim that a
 * venue has a current price, opening time or reservable inventory.
 */

const STYLE_ALLOCATIONS = Object.freeze({
  budget: [
    ["景区与体验", 0.35],
    ["餐饮", 0.35],
    ["市内短途出行", 0.12],
    ["小额伴手礼", 0.08],
    ["机动预留", 0.10],
  ],
  balanced: [
    ["景区与体验", 0.40],
    ["餐饮", 0.34],
    ["市内短途出行", 0.10],
    ["小额伴手礼", 0.08],
    ["机动预留", 0.08],
  ],
  comfort: [
    ["景区与体验", 0.46],
    ["餐饮", 0.31],
    ["市内短途出行", 0.10],
    ["小额伴手礼", 0.07],
    ["机动预留", 0.06],
  ],
});

const STYLE_DAILY_RANGES = Object.freeze({
  budget: { minimum: 200, maximum: 360 },
  balanced: { minimum: 300, maximum: 520 },
  comfort: { minimum: 450, maximum: 760 },
});

function roundCny(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function stableHash(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0");
}

function trace(step, detail, warning = false) {
  return { step, status: warning ? "warning" : "completed", detail };
}

function titleForSource(source) {
  return String(source?.title || source?.source_id || "待核验公开资料").trim();
}

function makeEmptyItinerary(request) {
  return Array.from({ length: request.days }, (_, index) => ({
    day: index + 1,
    theme: request.destination + " 第 " + (index + 1) + " 天：等待公开资料补充",
    items: [{
      slot: "待补充",
      title: "未找到能对应目的地的公开资料",
      description: "系统没有借用其他城市或编造景点；请稍后重试、使用更具体的县市名称，或直接打开本地旅游部门的官方页面核验。",
      estimated_duration_minutes: null,
      estimated_cost_cny: null,
      source_id: "free-public-source-no-result",
    }],
  }));
}

function makeItinerary(request, sources) {
  if (!sources.length) return makeEmptyItinerary(request);
  const slots = ["上午", "下午"];
  const perDay = Math.max(1, Math.min(2, Math.ceil(sources.length / request.days)));
  let cursor = 0;

  return Array.from({ length: request.days }, (_, dayIndex) => {
    const daySources = Array.from({ length: perDay }, () => {
      const source = sources[cursor % sources.length];
      cursor += 1;
      return source;
    });
    const reused = dayIndex * perDay >= sources.length;
    return {
      day: dayIndex + 1,
      theme: request.destination + " 第 " + (dayIndex + 1) + " 天：公开资料候选安排",
      items: daySources.map((source, itemIndex) => ({
        slot: slots[itemIndex] || "备选",
        title: titleForSource(source),
        description: (source.excerpt || "公开资料未提供可展示摘要。") + " 请打开来源页核验地点、开放状态、交通与预约要求。" + (reused ? " 该条目因资料数少于天数而作为延展备选重复展示，并非新增地点。" : ""),
        estimated_duration_minutes: null,
        estimated_cost_cny: null,
        source_id: source.source_id,
      })),
    };
  });
}

function buildBudgetFramework(request) {
  const style = Object.hasOwn(STYLE_ALLOCATIONS, request.travel_style)
    ? request.travel_style
    : "balanced";
  const travelersDays = request.days * request.travelers;
  const dailyRange = STYLE_DAILY_RANGES[style];
  const referenceMinimum = roundCny(travelersDays * dailyRange.minimum);
  const referenceMaximum = roundCny(travelersDays * dailyRange.maximum);
  const referenceEstimate = roundCny((referenceMinimum + referenceMaximum) / 2);
  let distributed = 0;
  const lineItems = STYLE_ALLOCATIONS[style].map(([category, ratio], index, entries) => {
    const amount = index === entries.length - 1
      ? roundCny(referenceEstimate - distributed)
      : roundCny(referenceEstimate * ratio);
    distributed = roundCny(distributed + amount);
    return {
      category,
      amount_cny: amount,
      assumption: "按 " + style + " 风格的参考游玩估算分配 " + Math.round(ratio * 100) + "%；不含往返交通与住宿，非实时价格。",
    };
  });

  return {
    currency: "CNY",
    mode: "rough_estimate",
    pricing_complete: false,
    budget_cap_cny: roundCny(request.total_budget_cny),
    line_items: lineItems,
    estimated_total_cny: referenceEstimate,
    recommended_range_cny: { minimum: referenceMinimum, maximum: referenceMaximum },
    remaining_cny: roundCny(request.total_budget_cny - referenceEstimate),
    summary_label: "参考游玩预算",
    total_label: "参考游玩预算",
    scope: "景区、餐饮、市内短途出行和小额伴手礼；不含往返交通与住宿。",
    notice: "按 " + request.days + " 天、" + request.travelers + " 人和 " + style + " 风格生成的粗略区间为 ¥" + referenceMinimum + "–¥" + referenceMaximum + "。你填写的预算上限为 ¥" + roundCny(request.total_budget_cny) + "；这不是实时票价、菜单价格或预订报价。",
  };
}

function buildValidation(retrieval, budget) {
  const coverageOk = retrieval.source_count > 0;
  const issues = [
    "票价、营业时间、餐饮价格、交通和预约信息需要在原始来源页或官方渠道人工核验。",
  ];
  if (budget.budget_cap_cny < budget.recommended_range_cny.minimum) {
    issues.unshift("你的游玩预算上限低于该人数、天数和节奏的粗略参考区间，请减少景点或调整预算。");
  } else if (budget.budget_cap_cny < budget.estimated_total_cny) {
    issues.unshift("你的游玩预算上限低于参考中位估算，建议优先确认景区与餐饮支出。");
  }
  if (!coverageOk) {
    issues.unshift("未找到能对应本次目的地的公开资料，系统没有生成替代城市或虚构景点。");
  }
  return {
    passed: false,
    within_budget: null,
    coverage_ok: coverageOk,
    pricing_complete: false,
    issues,
    revision_count: 0,
  };
}

export function buildFreePublicSourcePlan(payload, retrieval) {
  const request = {
    destination: String(payload.destination || "").trim(),
    days: Number(payload.days),
    travelers: Number(payload.travelers),
    total_budget_cny: Number(payload.total_budget_cny),
    interests: Array.isArray(payload.interests) ? payload.interests : [],
    travel_style: payload.travel_style || "balanced",
  };
  const sources = Array.isArray(retrieval?.sources) ? retrieval.sources : [];
  const itinerary = makeItinerary(request, sources);
  const budget = buildBudgetFramework(request);
  const validation = buildValidation(retrieval || { source_count: 0 }, budget);
  const identity = JSON.stringify({
    request,
    sourceIds: sources.map((source) => source.source_id),
    mode: retrieval?.mode,
  });
  const sourceCount = Number(retrieval?.source_count) || 0;

  return {
    plan_id: "FREE-SOURCES-" + stableHash(identity),
    request_summary: {
      destination: request.destination,
      days: request.days,
      travelers: request.travelers,
      interests: request.interests,
      travel_style: request.travel_style,
      mock_mode: false,
      data_mode: "free_public_sources",
    },
    itinerary,
    budget,
    citations: sources,
    retrieval: {
      mode: "free_public_sources",
      provider: retrieval?.provider || "中文维基导游 / 中文维基百科",
      status: retrieval?.status || "unavailable",
      retrieved_at: retrieval?.retrieved_at || null,
      cache_age_seconds: Number(retrieval?.cache_age_seconds) || 0,
      source_count: sourceCount,
      notices: Array.isArray(retrieval?.notices) ? retrieval.notices : [],
    },
    validation,
    workflow_trace: [
      trace("parse", "已保留目的地用于免费公开资料查询；" + request.interests.length + " 项偏好只用于本次方案结构。"),
      trace(
        "retrieve_free_public_sources",
        sourceCount
          ? "从 " + retrieval.provider + " 返回 " + sourceCount + " 条可打开的公开资料（状态：" + retrieval.status + "）。"
          : "未找到能对应目的地的公开资料，未生成替代城市或虚构景点。",
        !sourceCount,
      ),
      trace(
        "plan",
        sourceCount
          ? "已按公开资料顺序组织候选日程；每项均保留来源 ID。"
          : "因缺少资料，仅保留待补充状态。",
        !sourceCount,
      ),
      trace("budget", "已按天数、人数和节奏生成不含往返交通与住宿的参考游玩预算；所有金额都需要行前核验。", true),
      trace("finalize", "已输出免费、可追溯的资料查询结果；未调用模型、付费搜索、工单、FastAPI 或订票服务。"),
    ],
    ticket: null,
  };
}
