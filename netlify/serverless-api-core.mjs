import catalogue from "../data/attractions.json" with { type: "json" };

import {
  buildDeterministicPlan,
  citationsFor,
  searchAttractions,
} from "../frontend/static-demo-core.mjs";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

const TRAVEL_STYLES = new Set(["budget", "balanced", "comfort"]);

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function publicDemoBlocked() {
  return jsonResponse(
    { detail: "公开演示已关闭模拟工单读写，请勿提交个人信息。" },
    403,
  );
}

export function methodGuard(request, allowedMethods) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { Allow: [...allowedMethods, "OPTIONS"].join(", ") },
    });
  }
  if (!allowedMethods.includes(request.method)) {
    return jsonResponse(
      { detail: `Method ${request.method} is not allowed.` },
      405,
      { Allow: [...allowedMethods, "OPTIONS"].join(", ") },
    );
  }
  return null;
}

export function internalError() {
  return jsonResponse({ detail: "公开演示暂时无法处理请求，请稍后重试。" }, 500);
}

export function recordCount() {
  return catalogue.length;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validatePlanningPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "请求体必须是 JSON 对象。";
  }
  if (typeof payload.destination !== "string" || !payload.destination.trim() || payload.destination.trim().length > 80) {
    return "destination 必须是 1 到 80 个字符。";
  }
  if (!Number.isInteger(payload.days) || payload.days < 1 || payload.days > 14) {
    return "days 必须是 1 到 14 的整数。";
  }
  if (!Number.isInteger(payload.travelers) || payload.travelers < 1 || payload.travelers > 10) {
    return "travelers 必须是 1 到 10 的整数。";
  }
  if (!isFiniteNumber(payload.total_budget_cny) || payload.total_budget_cny <= 0 || payload.total_budget_cny > 100000) {
    return "total_budget_cny 必须是 0 到 100000 之间的数字。";
  }
  if (payload.interests != null && (!Array.isArray(payload.interests)
    || payload.interests.length > 8
    || payload.interests.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 40))) {
    return "interests 必须是最多 8 项、每项 1 到 40 个字符的字符串数组。";
  }
  if (payload.travel_style != null && !TRAVEL_STYLES.has(payload.travel_style)) {
    return "travel_style 必须是 budget、balanced 或 comfort。";
  }
  if (payload.notes != null && (typeof payload.notes !== "string" || payload.notes.length > 500)) {
    return "notes 最多 500 个字符。";
  }
  return null;
}

export async function readPublicPlanPayload(request) {
  const guard = methodGuard(request, ["POST"]);
  if (guard) return guard;

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 20_000) {
    return jsonResponse({ detail: "请求体超过公开演示允许的大小。" }, 413);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ detail: "请求体必须是有效 JSON。" }, 400);
  }

  const issue = validatePlanningPayload(payload);
  if (issue) return jsonResponse({ detail: issue }, 422);
  if (payload.create_follow_up_ticket === true) return publicDemoBlocked();
  return payload;
}

/**
 * Live search has a smaller data boundary than the deterministic demo. This
 * projection ensures only the destination reaches the free public-source
 * endpoints. In particular, notes are never silently forwarded.
 */
export async function readFreePublicPlanPayload(request) {
  const payload = await readPublicPlanPayload(request);
  if (payload instanceof Response) return payload;
  if (typeof payload.notes === "string" && payload.notes.trim()) {
    return jsonResponse(
{ detail: "免费公开资料查询不接收补充说明；请勿输入个人信息。", code: "free_public_source_notes_not_allowed" },
      422,
    );
  }
  return {
    destination: payload.destination.trim(),
    ...(payload.start_date ? { start_date: payload.start_date } : {}),
    days: payload.days,
    travelers: payload.travelers,
    total_budget_cny: payload.total_budget_cny,
    interests: Array.isArray(payload.interests) ? payload.interests.map((item) => item.trim()) : [],
    travel_style: payload.travel_style || "balanced",
  };
}

export function readFreePublicAttractionQuery(url) {
  const destination = url.searchParams.get("destination")?.trim() || "";
  if (!destination || destination.length > 80) {
    return jsonResponse({ detail: "destination 必须是 1 到 80 个字符。" }, 422);
  }
  const interests = (url.searchParams.get("interests") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (interests.length > 8 || interests.some((item) => item.length > 40)) {
    return jsonResponse({ detail: "interests 最多 8 项，且每项最多 40 个字符。" }, 422);
  }
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit == null ? undefined : Number(rawLimit);
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 8)) {
    return jsonResponse({ detail: "limit 必须是 1 到 8 的整数。" }, 422);
  }
  return {
    destination,
    interests,
    ...(limit == null ? {} : { requested_limit: limit }),
  };
}

export function createNetlifyPlan(payload, { modelAssisted = false } = {}) {
  const plan = buildDeterministicPlan(payload, catalogue, { execution: "netlify_function" });
  if (!modelAssisted) return plan;
  return {
    ...plan,
    generation: {
      mode: "deterministic_fallback",
      provider: "netlify-functions",
      model: null,
      prompt_version: "netlify-api-v1",
      fallback_code: "llm_disabled",
      attempts: 0,
      llm_latency_ms: null,
      usage: null,
    },
    narrative: null,
  };
}

export function searchPublicAttractions(url) {
  const destination = url.searchParams.get("destination")?.trim() || "";
  if (!destination || destination.length > 80) {
    return jsonResponse({ detail: "destination 必须是 1 到 80 个字符。" }, 422);
  }
  const interests = (url.searchParams.get("interests") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit == null ? 8 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return jsonResponse({ detail: "limit 必须是 1 到 20 的整数。" }, 422);
  }
  const items = searchAttractions(catalogue, destination, interests, limit);
  return {
    destination,
    items,
    citations: citationsFor(items, interests),
  };
}
