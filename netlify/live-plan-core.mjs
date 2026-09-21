/**
 * Source-grounded planner for the live-web route.
 *
 * It deliberately does not reuse the synthetic planner: web result snippets
 * are evidence candidates, not verified POI records with a price or opening
 * schedule. The output is renderer-compatible while retaining that boundary.
 */

const STYLE_ALLOCATIONS = Object.freeze({
  budget: [
    ["住宿预留", 0.34],
    ["餐饮预留", 0.25],
    ["市内交通预留", 0.16],
    ["景点与体验预留", 0.17],
    ["机动预留", 0.08],
  ],
  balanced: [
    ["住宿预留", 0.38],
    ["餐饮预留", 0.24],
    ["市内交通预留", 0.13],
    ["景点与体验预留", 0.17],
    ["机动预留", 0.08],
  ],
  comfort: [
    ["住宿预留", 0.46],
    ["餐饮预留", 0.22],
    ["市内交通预留", 0.1],
    ["景点与体验预留", 0.15],
    ["机动预留", 0.07],
  ],
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
  return String(source?.title || source?.source_id || "待核验网页来源").trim();
}

function makeEmptyItinerary(request) {
  return Array.from({ length: request.days }, (_, index) => ({
    day: index + 1,
    theme: `${request.destination} 第 ${index + 1} 天：等待联网来源补充`,
    items: [{
      slot: "待补充",
      title: "未检索到可展示的网页来源",
      description: "系统没有借用其他城市或编造景点；请稍后重试或缩短目的地名称后重新检索。",
      estimated_duration_minutes: null,
      estimated_cost_cny: null,
      source_id: "live-web-no-result",
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
      theme: `${request.destination} 第 ${dayIndex + 1} 天：网页来源候选安排`,
      items: daySources.map((source, itemIndex) => ({
        slot: slots[itemIndex] || "备选",
        title: titleForSource(source),
        description: `${source.excerpt || "网页来源未提供可展示摘要。"} 请打开来源页核验地点、开放状态、交通与预约要求。${reused ? " 该条目因来源数少于天数而作为延展备选重复展示，并非新增地点。" : ""}`,
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
  let distributed = 0;
  const lineItems = STYLE_ALLOCATIONS[style].map(([category, ratio], index, entries) => {
    const amount = index === entries.length - 1
      ? roundCny(request.total_budget_cny - distributed)
      : roundCny(request.total_budget_cny * ratio);
    distributed = roundCny(distributed + amount);
    return {
      category,
      amount_cny: amount,
      assumption: `按用户总预算的 ${Math.round(ratio * 100)}% 分配，仅为 ${style} 风格预算框架，非联网报价。`,
    };
  });

  return {
    currency: "CNY",
    mode: "allocation_framework",
    pricing_complete: false,
    budget_cap_cny: roundCny(request.total_budget_cny),
    line_items: lineItems,
    estimated_total_cny: null,
    remaining_cny: null,
    summary_label: "预算上限",
    total_label: "预算上限",
    notice: "联网网页检索没有提供完整、可核验的统一价格；上面的金额是总预算分配框架，不是实时花费或报价。",
  };
}

function buildValidation(retrieval) {
  const coverageOk = retrieval.source_count > 0;
  const issues = [
    "票价、营业时间、交通、预约和可订性未被当作已核验事实；请在出行前打开每条来源复核。",
  ];
  if (!coverageOk) {
    issues.unshift("未检索到可展示的同次网页来源，系统未生成替代城市或虚构景点。");
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

/**
 * Assemble a transparent plan from already normalized live source metadata.
 * No outbound request happens here, so it remains straightforward to test.
 */
export function buildLiveWebPlan(payload, retrieval) {
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
  const validation = buildValidation(retrieval || { source_count: 0 });
  const identity = JSON.stringify({
    request,
    sourceIds: sources.map((source) => source.source_id),
    mode: retrieval?.mode,
  });
  const sourceCount = Number(retrieval?.source_count) || 0;

  return {
    plan_id: `LIVE-WEB-${stableHash(identity)}`,
    request_summary: {
      destination: request.destination,
      days: request.days,
      travelers: request.travelers,
      interests: request.interests,
      travel_style: request.travel_style,
      mock_mode: false,
      data_mode: "live_web",
    },
    itinerary,
    budget,
    citations: sources,
    retrieval: {
      mode: "live_web",
      provider: retrieval?.provider || "tavily",
      status: retrieval?.status || "unavailable",
      retrieved_at: retrieval?.retrieved_at || null,
      cache_age_seconds: Number(retrieval?.cache_age_seconds) || 0,
      source_count: sourceCount,
      notices: Array.isArray(retrieval?.notices) ? retrieval.notices : [],
    },
    validation,
    workflow_trace: [
      trace("parse", `已在 Netlify Function 仅保留 ${request.destination} 与 ${request.interests.length} 项偏好用于联网检索。`),
      trace(
        "retrieve_live_web",
        sourceCount
          ? `从 ${retrieval.provider} 返回 ${sourceCount} 条可打开的网页来源（状态：${retrieval.status}）。`
          : "未检索到可展示的网页来源，未生成替代城市或虚构景点。",
        !sourceCount,
      ),
      trace(
        "plan",
        sourceCount
          ? "已按网页来源顺序组织候选日程；每项均保留来源 ID。"
          : "因缺少来源，仅保留待补充状态。",
        !sourceCount,
      ),
      trace("validate", "费用、开放状态、交通与预约信息需要在原始来源页人工核验。", true),
      trace("finalize", "已输出来源可追溯的联网检索结果；未调用模型、工单、FastAPI 或订票服务。"),
    ],
    ticket: null,
  };
}
