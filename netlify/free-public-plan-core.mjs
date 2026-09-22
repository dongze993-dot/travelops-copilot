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
  return String(source?.title || source?.source_id || "公开资料中的地点").trim();
}

function sourceExcerpt(source) {
  const excerpt = String(source?.excerpt || "").trim();
  return excerpt || "公开资料页没有可展示的摘要。";
}

function attractionItem(slot, source) {
  const title = titleForSource(source);
  return {
    slot,
    title: "游览：" + title,
    description: sourceExcerpt(source) + " 建议把它安排为当天" + slot + "的主要游览内容；出发前请打开资料页确认开放状态、预约要求、路线和实际花费。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
    source_id: source.source_id,
  };
}

function lunchItem() {
  return {
    slot: "中午",
    title: "就近安排当地餐饮",
    description: "按上午活动所在区域选择正餐或当地小吃。本计划不指定餐厅，也不虚构菜单和价格，请以现场信息与个人口味为准。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function flexibleMorningItem() {
  return {
    slot: "上午",
    title: "暂不推荐具体景点",
    description: "这一天没有查到与目的地对应的公开资料，因此不推荐其他城市的景点。可先留作休息、就近慢游，或换用更具体的县市名称重新生成。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function flexibleAfternoonItem() {
  return {
    slot: "下午",
    title: "慢游与弹性调整",
    description: "可在上午景点附近继续慢游、休息，或根据天气和体力调整。没有查到可确认的第二个景点时，系统不会用不相关地点补足。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function eveningItem() {
  return {
    slot: "晚上",
    title: "夜间散步与自由觅食",
    description: "在住宿附近或当天活动区域步行、用餐或选购小纪念品；请以当天营业状态和实际预算为准。",
    estimated_duration_minutes: null,
    estimated_cost_cny: null,
  };
}

function extraSourceItems(sources) {
  return sources.map((source) => ({
    ...attractionItem("可选加项", source),
    title: "可选加项：" + titleForSource(source),
    description: sourceExcerpt(source) + " 如当天体力、天气和开放条件合适，可把它加入行程或替换下午的慢游安排；出发前请打开资料页确认细节。",
  }));
}

function sourcesByDay(sources, days) {
  const buckets = Array.from({ length: days }, () => []);
  sources.forEach((source, index) => {
    buckets[index % days].push(source);
  });
  return buckets;
}

function dayTheme(request, dayIndex, sources) {
  const first = sources[0];
  if (first) return request.destination + " · 第 " + (dayIndex + 1) + " 天：从 " + titleForSource(first) + " 开始";
  return request.destination + " · 第 " + (dayIndex + 1) + " 天：慢游与当地餐饮安排";
}

function makeItinerary(request, sources) {
  const daySources = sourcesByDay(sources, request.days);

  return Array.from({ length: request.days }, (_, dayIndex) => {
    const candidates = daySources[dayIndex];
    const [morningSource, afternoonSource, ...extras] = candidates;
    return {
      day: dayIndex + 1,
      theme: dayTheme(request, dayIndex, candidates),
      items: [
        morningSource ? attractionItem("上午", morningSource) : flexibleMorningItem(),
        lunchItem(),
        afternoonSource ? attractionItem("下午", afternoonSource) : flexibleAfternoonItem(),
        eveningItem(),
        ...extraSourceItems(extras),
      ],
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
  const withinBudget = budget.budget_cap_cny >= budget.recommended_range_cny.minimum;
  const issues = ["票价、营业时间、餐饮价格、交通和预约信息请在出行前通过资料页或官方渠道确认。"];
  if (budget.budget_cap_cny < budget.recommended_range_cny.minimum) {
    issues.unshift("你的游玩预算上限低于该人数、天数和节奏的粗略参考区间，请减少景点或调整预算。");
  } else if (budget.budget_cap_cny < budget.estimated_total_cny) {
    issues.unshift("你的游玩预算上限低于参考中位估算，建议优先确认景区与餐饮支出。");
  }
  if (!coverageOk) {
    issues.unshift("未找到能对应本次目的地的公开资料，系统没有生成替代城市或虚构景点。");
  }
  return {
    passed: coverageOk,
    within_budget: withinBudget,
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
      trace("parse", "已读取目的地、天数、同行人数和旅行偏好。"),
      trace(
        "retrieve_free_public_sources",
        sourceCount
          ? "找到 " + sourceCount + " 条可打开的公开资料。"
          : "暂未找到与目的地对应的公开资料，因此没有加入替代城市或虚构景点。",
        !sourceCount,
      ),
      trace(
        "plan",
        sourceCount
          ? "已将资料中提及的地点放入上午或下午，并补齐餐饮、慢游和晚间安排。"
          : "已保留完整的早、中、晚时间框架，等待找到对应地点后再推荐具体景点。",
        !sourceCount,
      ),
      trace("budget", "已按天数、人数和节奏生成不含往返交通与住宿的参考游玩预算；实际金额请出行前确认。", true),
      trace("finalize", "已生成带公开资料链接的旅行计划。"),
    ],
    ticket: null,
  };
}
