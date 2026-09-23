import assert from "node:assert/strict";
import test from "node:test";

import { buildFreePublicSourcePlan } from "../netlify/free-public-plan-core.mjs";
import {
  FreePublicSourceError,
  freePublicSourceConfig,
  publicFreePublicSourceStatus,
  retrieveFreePublicTravelSources,
} from "../netlify/free-public-sources-core.mjs";
import freeAttractions, { config as freeAttractionsConfig } from "../netlify/functions/free-attractions.mjs";
import freePlan, { config as freePlanConfig } from "../netlify/functions/free-plans.mjs";

const ORIGIN = "https://travelops-netlify.example";

function planningPayload(overrides = {}) {
  return {
    destination: "上饶",
    days: 2,
    travelers: 2,
    total_budget_cny: 1200,
    interests: ["自然", "美食"],
    travel_style: "balanced",
    ...overrides,
  };
}

function providerResponse(pages) {
  return new Response(JSON.stringify({ query: { pages } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function searchPages(hostname) {
  const isVoyage = hostname === "zh.wikivoyage.org";
  return {
    1: {
      index: 1,
      pageid: 1,
      title: isVoyage ? "三清山" : "灵山（上饶）",
      extract: isVoyage ? "三清山位于江西省上饶市。" : "灵山位于江西省上饶市。",
      fullurl: `https://${hostname}/wiki/${isVoyage ? "%E4%B8%89%E6%B8%85%E5%B1%B1" : "%E7%81%B5%E5%B1%B1"}`,
    },
    2: {
      index: 2,
      pageid: 2,
      title: "上饶轨道交通体系",
      extract: "上饶相关交通规划，不是游玩地点。",
      fullurl: `https://${hostname}/wiki/transport`,
    },
    3: {
      index: 3,
      pageid: 3,
      title: "上饶区",
      extract: "上饶相关行政区划。",
      fullurl: `https://${hostname}/wiki/administrative-area`,
    },
    4: {
      index: 4,
      pageid: 4,
      title: "不安全链接",
      extract: "上饶测试资料。",
      fullurl: "https://evil.example/wiki/unsafe",
    },
  };
}

function detailPages(hostname, pageId) {
  const isVoyage = hostname === "zh.wikivoyage.org";
  const title = isVoyage ? "三清山" : "灵山（上饶）";
  const extract = isVoyage
    ? "三清山位于江西省上饶市，是自然风光候选。费用 ¥150。请以景区当天公告为准。"
    : "灵山位于江西省上饶市，是自然风光候选。成人票 ¥80。请以景区当天公告为准。";
  return {
    [pageId]: {
      pageid: Number(pageId),
      title,
      extract,
      fullurl: `https://${hostname}/wiki/${isVoyage ? "%E4%B8%89%E6%B8%85%E5%B1%B1" : "%E7%81%B5%E5%B1%B1"}`,
    },
  };
}

function fakePublicSources(captured) {
  return async (url, init = {}) => {
    captured.push({ url, init });
    const parsed = new URL(url);
    const pageId = parsed.searchParams.get("pageids");
    return providerResponse(pageId ? detailPages(parsed.hostname, pageId) : searchPages(parsed.hostname));
  };
}

test("free public retrieval sends only controlled destination and interest searches, then enriches sources", async () => {
  const captured = [];
  const retrieval = await retrieveFreePublicTravelSources({
    ...planningPayload(),
    notes: "private-contact@example.invalid must never leave the service",
  }, {
    cache: new Map(),
    now: () => Date.UTC(2026, 8, 22, 12, 0, 0),
    fetchImpl: fakePublicSources(captured),
  });

  const searchCalls = captured.filter((call) => !new URL(call.url).searchParams.has("pageids"));
  const detailCalls = captured.filter((call) => new URL(call.url).searchParams.has("pageids"));
  assert.equal(searchCalls.length, 8);
  assert.equal(detailCalls.length, 2);
  assert.deepEqual(
    [...new Set(searchCalls.map((call) => new URL(call.url).searchParams.get("gsrsearch")))].sort(),
    ["上饶 旅游", "上饶 景点", "上饶 美食", "上饶 自然风光"].sort(),
  );
  assert.ok(captured.every((call) => !Object.hasOwn(call.init.headers || {}, "Authorization")));
  assert.equal(JSON.stringify(captured).includes("private-contact"), false);
  assert.equal(retrieval.mode, "free_public_sources");
  assert.equal(retrieval.status, "public_sources");
  assert.equal(retrieval.destination, "上饶");
  assert.equal(retrieval.source_count, 2);
  assert.ok(retrieval.sources.every((source) => source.uri.startsWith("https://zh.")));
  assert.ok(retrieval.sources.every((source) => source.source_id.startsWith("zh-")));
  assert.equal(retrieval.sources.some((source) => source.title.includes("轨道交通")), false);
  assert.equal(retrieval.sources.some((source) => source.title.endsWith("区")), false);
  assert.equal(retrieval.sources[0].price_evidence[0].amount_cny, 150);
  assert.match(retrieval.sources[0].price_evidence[0].detail, /费用 ¥150/);
  assert.equal(retrieval.sources[0].price_evidence[0].aggregation_safe, true);
  assert.equal(JSON.stringify(retrieval).includes("private-contact"), false);
});

test("price extraction never treats a number without fee context as a price", async () => {
  const retrieval = await retrieveFreePublicTravelSources(planningPayload({ interests: [] }), {
    cache: new Map(),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const pageId = parsed.searchParams.get("pageids");
      if (!pageId) return providerResponse(searchPages(parsed.hostname));
      return providerResponse({
        [pageId]: {
          pageid: Number(pageId),
          title: "三清山",
          extract: "三清山位于上饶市，海拔 ¥150 的写法是无效测试数字。",
          fullurl: `https://${parsed.hostname}/wiki/%E4%B8%89%E6%B8%85%E5%B1%B1`,
        },
      });
    },
  });
  assert.ok(retrieval.sources.every((source) => source.price_evidence.length === 0));
});

test("free public retrieval caches the complete result without more source requests", async () => {
  const cache = new Map();
  const captured = [];
  let clock = Date.UTC(2026, 8, 22, 12, 0, 0);
  const options = { cache, now: () => clock, fetchImpl: fakePublicSources(captured) };
  const first = await retrieveFreePublicTravelSources(planningPayload(), options);
  const requestCount = captured.length;
  clock += 17_000;
  const second = await retrieveFreePublicTravelSources(planningPayload(), options);
  assert.ok(requestCount > 0);
  assert.equal(captured.length, requestCount);
  assert.equal(first.status, "public_sources");
  assert.equal(second.status, "cache_hit");
  assert.equal(second.cache_age_seconds, 17);
});

test("free public retrieval reports honest empty results and safe source failures", async () => {
  const noResults = await retrieveFreePublicTravelSources(planningPayload(), {
    cache: new Map(),
    fetchImpl: async () => providerResponse({}),
  });
  assert.equal(noResults.status, "no_results");
  assert.equal(noResults.source_count, 0);
  assert.ok(noResults.notices.some((notice) => notice.includes("没有借用其他城市")));

  await assert.rejects(
    () => retrieveFreePublicTravelSources(planningPayload(), {
      cache: new Map(),
      fetchImpl: async () => {
        const error = new Error("timeout");
        error.name = "AbortError";
        throw error;
      },
    }),
    (error) => error instanceof FreePublicSourceError && error.code === "public_source_timeout" && error.status === 504,
  );

  assert.deepEqual(freePublicSourceConfig(), {
    enabled: true,
    timeoutMs: 3500,
    maxResults: 6,
    cacheTtlSeconds: 600,
  });
  assert.deepEqual(publicFreePublicSourceStatus(), {
    enabled: true,
    mode: "free_public_sources",
    provider: "中文维基导游 / 中文维基百科",
    credential_exposed_to_browser: false,
    requires_api_key: false,
    notes: [
      "联网资料查询已启用：无需账号、绑卡或 API Key。",
      "仅会发送目的地和固定映射后的旅行偏好；不会发送备注、预算或个人信息。",
    ],
  });
});

function sourcedRetrieval() {
  return {
    mode: "free_public_sources",
    provider: "中文维基导游 / 中文维基百科",
    status: "public_sources",
    retrieved_at: "2026-09-22T12:00:00.000Z",
    cache_age_seconds: 0,
    source_count: 3,
    notices: ["行前核验。"],
    sources: [
      {
        source_id: "zh-wikivoyage-nature",
        title: "三清山",
        uri: "https://zh.wikivoyage.org/wiki/%E4%B8%89%E6%B8%85%E5%B1%B1",
        excerpt: "上饶市的自然风光候选。",
        matched_interests: ["自然风光"],
        price_evidence: [{ amount_cny: 150, detail: "费用 ¥150。", source_url: "https://zh.wikivoyage.org/wiki/%E4%B8%89%E6%B8%85%E5%B1%B1", pricing_scope: "unspecified" }],
      },
      {
        source_id: "zh-wikipedia-culture",
        title: "上饶博物馆",
        uri: "https://zh.wikipedia.org/wiki/%E4%B8%8A%E9%A5%B6",
        excerpt: "上饶市的人文历史候选。",
        matched_interests: ["人文历史"],
        price_evidence: [{ amount_cny: 80, detail: "成人票 ¥80。", source_url: "https://zh.wikipedia.org/wiki/%E4%B8%8A%E9%A5%B6", pricing_scope: "per_person", per_person: true }],
      },
      {
        source_id: "zh-wikivoyage-food",
        title: "上饶小吃",
        uri: "https://zh.wikivoyage.org/wiki/%E4%B8%8A%E9%A5%B6",
        excerpt: "上饶市的本地美食候选。",
        matched_interests: ["本地美食"],
        price_evidence: [],
      },
    ],
  };
}

test("source-backed plan builds an ordinary stay, food and local-travel range that reflects planning inputs", () => {
  const plan = buildFreePublicSourcePlan(planningPayload({
    start_date: "2026-09-29",
    interests: ["自然", "文化"],
  }), sourcedRetrieval());
  assert.match(plan.plan_id, /^FREE-SOURCES-/);
  assert.equal(plan.request_summary.mock_mode, false);
  assert.equal(plan.request_summary.data_mode, "free_public_sources");
  assert.deepEqual(plan.itinerary.map((day) => day.date_label), ["9月29日", "9月30日"]);
  assert.ok(plan.itinerary.flatMap((day) => day.items).some((item) => item.source_url));
  assert.equal(plan.workflow_trace, undefined);
  assert.equal(plan.budget.mode, "ordinary_travel_range");
  assert.equal(plan.budget.pricing_complete, false);
  assert.ok(plan.budget.recommended_range_cny.minimum > 0);
  assert.ok(plan.budget.recommended_range_cny.maximum > plan.budget.recommended_range_cny.minimum);
  assert.ok(plan.budget.estimated_total_cny > 0);
  assert.equal(plan.budget.total_is_complete_trip_budget, false);
  assert.ok(plan.budget.line_items.some((item) => item.category === "普通双人酒店"));
  assert.ok(plan.budget.line_items.some((item) => item.category === "早餐与平价小吃"));
  assert.ok(plan.budget.line_items.some((item) => item.category === "晚餐：当地家常菜 / 特色正餐"));
  assert.ok(plan.budget.line_items.some((item) => item.estimate_type === "source_fact" && item.evidence_url));
  assert.match(plan.budget.scope, /普通酒店、饮食、市内交通/);
  assert.equal(plan.validation.passed, true);

  const oneTraveler = buildFreePublicSourcePlan(planningPayload({ travelers: 1 }), sourcedRetrieval());
  const oneDay = buildFreePublicSourcePlan(planningPayload({ days: 1 }), sourcedRetrieval());
  const comfort = buildFreePublicSourcePlan(planningPayload({ days: 2, travel_style: "comfort" }), sourcedRetrieval());
  const culture = buildFreePublicSourcePlan(planningPayload({ days: 1, interests: ["文化"] }), sourcedRetrieval());
  assert.ok(oneTraveler.budget.recommended_range_cny.maximum < plan.budget.recommended_range_cny.maximum);
  assert.equal(oneDay.itinerary.length, 1);
  assert.ok(comfort.itinerary.every((day) => day.data_backed_place_count <= 1));
  assert.ok(culture.itinerary[0].items.some((item) => item.title.includes("上饶博物馆")));
  assert.ok(plan.itinerary.every((day) => day.items.at(-1).title.includes("晚餐")));
});

test("ordinary travel range still works without source prices and labels its assumptions", () => {
  const retrieval = sourcedRetrieval();
  retrieval.sources = retrieval.sources.map((source) => ({ ...source, price_evidence: [] }));
  const plan = buildFreePublicSourcePlan(planningPayload(), retrieval);
  assert.ok(plan.budget.estimated_total_cny > 0);
  assert.ok(plan.budget.recommended_range_cny.maximum > plan.budget.recommended_range_cny.minimum);
  assert.ok(plan.budget.line_items.some((item) => item.category === "未标价景点预留"));
  assert.equal(plan.budget.total_is_source_backed, false);
  assert.match(plan.budget.notice, /普通消费水平/);
});

test("alternative ticket prices in one source sentence stay visible but are never added together", () => {
  const retrieval = sourcedRetrieval();
  retrieval.sources = [{
    ...retrieval.sources[0],
    price_evidence: [
      { amount_cny: 210, detail: "通票210元/人/5天，单买60元一景点。", source_url: "https://zh.wikivoyage.org/wiki/%E5%A9%BA%E6%BA%90", pricing_scope: "per_person", per_person: true, aggregation_safe: false },
      { amount_cny: 60, detail: "通票210元/人/5天，单买60元一景点。", source_url: "https://zh.wikivoyage.org/wiki/%E5%A9%BA%E6%BA%90", pricing_scope: "per_person", per_person: true, aggregation_safe: false },
    ],
  }];
  retrieval.source_count = 1;
  const plan = buildFreePublicSourcePlan(planningPayload(), retrieval);
  const sourceFacts = plan.budget.line_items.filter((item) => item.estimate_type === "source_fact");
  const visitEstimate = plan.budget.line_items.find((item) => item.category === "资料地点的游玩费用");
  assert.equal(sourceFacts.length, 2);
  assert.ok(sourceFacts.every((item) => item.included_in_total === false));
  assert.deepEqual({ minimum: visitEstimate.minimum_cny, maximum: visitEstimate.maximum_cny }, { minimum: 120, maximum: 420 });
});

test("free public API routes accept safe inputs and keep the public rate limit", async () => {
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = fakePublicSources(captured);
  try {
    const response = await freePlan(new Request(ORIGIN + "/api/v3/free-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(planningPayload({ destination: "广丰区" })),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.request_summary.destination, "广丰区");
    assert.equal(body.request_summary.data_mode, "free_public_sources");

    const notesResponse = await freePlan(new Request(ORIGIN + "/api/v3/free-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(planningPayload({ destination: "玉山县", notes: "do not forward me" })),
    }));
    assert.equal(notesResponse.status, 422);

    const attractionsResponse = await freeAttractions(new Request(ORIGIN + "/api/v3/free-attractions?destination=%E4%B8%8A%E9%A5%B6", {
      method: "GET",
    }));
    const attractionsBody = await attractionsResponse.json();
    assert.equal(attractionsResponse.status, 200);
    assert.equal(attractionsBody.retrieval.mode, "free_public_sources");
  } finally {
    globalThis.fetch = originalFetch;
  }

  for (const routeConfig of [freePlanConfig, freeAttractionsConfig]) {
    assert.deepEqual(routeConfig.rateLimit, {
      windowLimit: 3,
      windowSize: 60,
      aggregateBy: ["ip", "domain"],
    });
  }
});
