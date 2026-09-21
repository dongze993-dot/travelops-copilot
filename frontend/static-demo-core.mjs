/**
 * Browser-only deterministic planner used by the optional static public demo.
 *
 * This module deliberately has no provider, ticket, storage, or network API
 * dependency.  The adapter supplies only the checked-in synthetic catalogue.
 */

export const STATIC_DEMO_FALLBACK_CODE = "static_demo_no_model";

const STYLE_COSTS = Object.freeze({
  budget: { roomPerNight: 150, foodPerDay: 75 },
  balanced: { roomPerNight: 260, foodPerDay: 110 },
  comfort: { roomPerNight: 420, foodPerDay: 170 },
});

function roundCny(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

export function normalise(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function normaliseRequest(payload = {}) {
  const rawInterests = Array.isArray(payload.interests) ? payload.interests : [];
  const interests = [...new Set(rawInterests.map(normalise).filter(Boolean))];
  const travelStyle = Object.hasOwn(STYLE_COSTS, payload.travel_style)
    ? payload.travel_style
    : "balanced";

  return {
    destination: String(payload.destination ?? "").trim(),
    days: boundedInteger(payload.days, 3, 1, 14),
    travelers: boundedInteger(payload.travelers, 2, 1, 10),
    total_budget_cny: boundedNumber(payload.total_budget_cny, 5000, 0.01, 100000),
    interests: interests.length ? interests : ["城市漫游", "人文"],
    travel_style: travelStyle,
    start_date: payload.start_date || null,
  };
}

function recordHaystack(record) {
  return normalise([
    record.name,
    record.city,
    record.category,
    record.summary,
    ...(Array.isArray(record.tags) ? record.tags : []),
  ].join(" "));
}

/**
 * Match a destination first, then use interests as deterministic ordering.
 * A city gate is intentional: the static demonstration must never turn an
 * unrecognised city into a plan for another city.
 */
export function searchAttractions(records, destination, interests = [], limit = 8) {
  const cityQuery = normalise(destination);
  const interestTerms = interests.map(normalise).filter(Boolean);
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 8, 20));

  if (!cityQuery || !Array.isArray(records)) return [];

  return records
    .map((record) => {
      const city = normalise(record.city);
      const matchesCity = city && (city.includes(cityQuery) || cityQuery.includes(city));
      if (!matchesCity) return null;
      const haystack = recordHaystack(record);
      const interestScore = interestTerms.reduce(
        (score, term) => score + (haystack.includes(term) ? 3 : 0),
        0,
      );
      return { record, score: 10 + interestScore };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.score - left.score
      || Number(left.record.price_cny) - Number(right.record.price_cny)
      || String(left.record.id).localeCompare(String(right.record.id), "zh-CN")
    ))
    .slice(0, cappedLimit)
    .map(({ record }) => record);
}

export function citationsFor(records, interests = []) {
  const interestLabel = interests.join("、") || "目的地匹配";
  const seen = new Set();
  return records.flatMap((record) => {
    if (!record?.id || seen.has(record.id)) return [];
    seen.add(record.id);
    return [{
      source_id: record.id,
      title: record.source_title || "本地合成示例资料",
      uri: record.source_url || "",
      excerpt: record.summary || "",
      relevance: `用于 ${interestLabel} 的本地资料检索`,
    }];
  });
}

function selectAttractions(records, days, conservative = false) {
  if (!records.length) return [];
  const desiredCount = Math.min(records.length, Math.max(days, days * (conservative ? 1 : 2)));
  const ordered = conservative
    ? [...records].sort((left, right) => (
      Number(left.price_cny) - Number(right.price_cny)
      || String(left.id).localeCompare(String(right.id), "zh-CN")
    ))
    : records;
  const selected = ordered.slice(0, desiredCount);
  while (selected.length < days) {
    selected.push(ordered[selected.length % ordered.length]);
  }
  return selected;
}

function makeItinerary(selected, days, conservative = false) {
  if (!selected.length) {
    return Array.from({ length: days }, (_, index) => ({
      day: index + 1,
      theme: "自由活动与人工确认",
      items: [{
        slot: "全天",
        title: "待人工确认的本地活动",
        description: "本地合成资料未返回同城可引用点位，建议人工补充资料后再生成方案。",
        estimated_duration_minutes: 180,
        estimated_cost_cny: 0,
        source_id: "manual-review",
      }],
    }));
  }

  return Array.from({ length: days }, (_, dayIndex) => {
    let dayRecords = selected.filter((_, index) => index % days === dayIndex);
    if (!dayRecords.length) dayRecords = [selected[dayIndex % selected.length]];
    return {
      day: dayIndex + 1,
      theme: `${dayRecords[0].category || "旅行"}主题（第 ${dayIndex + 1} 天）`,
      items: dayRecords.map((record, itemIndex) => ({
        slot: ["上午", "下午", "傍晚"][Math.min(itemIndex, 2)],
        title: record.name,
        description: `${record.summary || "本地合成资料条目。"}（${conservative ? "预算优先的修订建议" : "初版建议"}）`,
        estimated_duration_minutes: itemIndex < 2 ? 120 : 90,
        estimated_cost_cny: Number(record.price_cny) || 0,
        source_id: record.id,
      })),
    };
  });
}

function calculateBudget(selected, request, conservative = false) {
  const costs = STYLE_COSTS[conservative ? "budget" : request.travel_style];
  const rooms = Math.ceil(request.travelers / 2);
  const attractions = roundCny(
    selected.reduce((sum, item) => sum + (Number(item.price_cny) || 0), 0) * request.travelers,
  );
  const lodging = roundCny(costs.roomPerNight * rooms * request.days);
  const food = roundCny(costs.foodPerDay * request.travelers * request.days);
  const localTransport = roundCny(Math.max(request.days - 1, 0) * 25 * request.travelers + 15 * request.travelers);
  const preContingency = attractions + lodging + food + localTransport;
  const contingency = roundCny(preContingency * 0.08);
  const estimatedTotal = roundCny(preContingency + contingency);
  const style = conservative ? "budget" : request.travel_style;

  return {
    currency: "CNY",
    budget_cap_cny: roundCny(request.total_budget_cny),
    line_items: [
      { category: "景点与体验", amount_cny: attractions, assumption: "按每位旅客参与所选本地合成点位估算" },
      { category: "住宿", amount_cny: lodging, assumption: `${rooms} 间房 × ${request.days} 晚 × ${costs.roomPerNight} 元（${style} 示例标准）` },
      { category: "餐饮", amount_cny: food, assumption: `${request.travelers} 人 × ${request.days} 天 × ${costs.foodPerDay} 元（示例标准）` },
      { category: "市内交通", amount_cny: localTransport, assumption: "示例地铁/打车组合，不含抵离目的地的大交通" },
      { category: "预留金", amount_cny: contingency, assumption: "以上可见成本的 8%" },
    ],
    estimated_total_cny: estimatedTotal,
    remaining_cny: roundCny(request.total_budget_cny - estimatedTotal),
  };
}

function validatePlan({ itinerary, budget, retrieved, days, revisionCount, revised = false }) {
  const withinBudget = budget.remaining_cny >= 0;
  const coverageOk = itinerary.length === days && itinerary.every((day) => day.items?.length) && retrieved.length > 0;
  const issues = [];
  if (!withinBudget) {
    issues.push(revised
      ? "在一次预算优先修订后，示例基础成本仍超过预算；请提高预算或减少天数/人数。"
      : `初版估算超出预算 ${Math.abs(budget.remaining_cny).toFixed(2)} 元，触发一次预算优先修订。`);
  }
  if (!coverageOk) {
    issues.push(revised
      ? "修订后仍缺少完整同城资料，需人工补充资料。"
      : "行程缺少同城可引用资料；需要人工确认。"
    );
  }
  return {
    passed: withinBudget && coverageOk,
    within_budget: withinBudget,
    coverage_ok: coverageOk,
    issues,
    revision_count: revisionCount,
  };
}

function trace(step, detail, warning = false) {
  return { step, status: warning ? "warning" : "completed", detail };
}

function staticPlanId(request) {
  const text = JSON.stringify(request);
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `STATIC-DEMO-${(hash >>> 0).toString(36).toUpperCase().padStart(6, "0")}`;
}

/** Build a response compatible with the existing plan renderer. */
export function buildStaticPlan(payload, catalogue) {
  const request = normaliseRequest(payload);
  const traceEntries = [
    trace("parse", `已在浏览器内标准化 ${request.destination || "未填写目的地"}、${request.days} 天、${request.travelers} 位旅客的需求。`),
  ];
  const retrieved = searchAttractions(catalogue, request.destination, request.interests, Math.max(4, request.days * 3));
  const citations = citationsFor(retrieved, request.interests);
  traceEntries.push(trace(
    "retrieve",
    retrieved.length
      ? `从本地合成资料检索到 ${retrieved.length} 个可引用点位。`
      : "未找到同城合成资料，已停止生成无来源的候选点位。",
    !retrieved.length,
  ));

  let selected = selectAttractions(retrieved, request.days);
  let itinerary = makeItinerary(selected, request.days);
  let budget = calculateBudget(selected, request);
  let validation = validatePlan({
    itinerary,
    budget,
    retrieved,
    days: request.days,
    revisionCount: 0,
  });
  traceEntries.push(trace("plan", "已在浏览器内生成初版日程和逐项预算估算。"));
  traceEntries.push(trace(
    "validate",
    validation.passed ? "预算与日程覆盖校验通过。" : "发现需要人工确认的预算或资料覆盖问题。",
    !validation.passed,
  ));

  if (!validation.passed) {
    selected = selectAttractions(retrieved, request.days, true);
    itinerary = makeItinerary(selected, request.days, true);
    budget = calculateBudget(selected, request, true);
    validation = validatePlan({
      itinerary,
      budget,
      retrieved,
      days: request.days,
      revisionCount: 1,
      revised: true,
    });
    traceEntries.push(trace(
      "revise_once",
      "已按低价点位和 budget 示例标准完成唯一一次浏览器内修订。",
      !validation.passed,
    ));
  }

  traceEntries.push(trace("finalize", "已输出浏览器内确定性预览；未调用模型、工单或后端 API。"));
  return {
    plan_id: staticPlanId(request),
    request_summary: {
      destination: request.destination,
      days: request.days,
      travelers: request.travelers,
      interests: request.interests,
      travel_style: request.travel_style,
      mock_mode: true,
    },
    itinerary,
    budget,
    citations,
    validation,
    workflow_trace: traceEntries,
    ticket: null,
  };
}

function staticDemoError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Provide the tiny API surface consumed by frontend/app.js without issuing
 * API requests. The only fetch in the browser is the same-origin JSON source.
 */
export function createStaticDemoApi(loadRecords) {
  let recordPromise;
  const records = async () => {
    if (!recordPromise) {
      recordPromise = Promise.resolve(loadRecords()).then((value) => (
        Array.isArray(value) ? value : []
      ));
    }
    return recordPromise;
  };
  const pathnameFor = (url) => new URL(url, "https://travelops-static.example").pathname;

  return {
    async getJson(url) {
      const parsed = new URL(url, "https://travelops-static.example");
      if (parsed.pathname === "/health") {
        return {
          status: "ok",
          mode: "deterministic_mock",
          knowledge_records: (await records()).length,
          public_demo_mode: true,
          static_browser_demo: true,
        };
      }
      if (parsed.pathname === "/api/v1/attractions") {
        const interests = (parsed.searchParams.get("interests") || "").split(",").filter(Boolean);
        const items = searchAttractions(
          await records(),
          parsed.searchParams.get("destination") || "",
          interests,
          Number(parsed.searchParams.get("limit")) || 8,
        );
        return {
          destination: parsed.searchParams.get("destination") || "",
          items,
          citations: citationsFor(items, interests),
        };
      }
      throw staticDemoError("静态演示不提供该读取接口。", 404);
    },

    async postJson(url, payload) {
      const pathname = pathnameFor(url);
      if (pathname === "/api/v1/plans") return buildStaticPlan(payload, await records());
      if (pathname === "/api/v2/plans") {
        return {
          ...buildStaticPlan(payload, await records()),
          generation: {
            mode: "deterministic_fallback",
            provider: "browser-only",
            model: null,
            prompt_version: "static-demo-v1",
            fallback_code: STATIC_DEMO_FALLBACK_CODE,
            attempts: 0,
            llm_latency_ms: null,
            usage: null,
          },
          narrative: null,
        };
      }
      if (pathname.startsWith("/api/v1/tickets")) {
        throw staticDemoError("静态公开演示不提供工单读写。", 403);
      }
      throw staticDemoError("静态演示不提供该接口。", 404);
    },
  };
}
