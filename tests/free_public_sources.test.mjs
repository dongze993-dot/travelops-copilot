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

function sourcePages(hostname) {
  const uri = hostname === "zh.wikivoyage.org"
    ? "https://zh.wikivoyage.org/wiki/%E4%B8%89%E6%B8%85%E5%B1%B1"
    : "https://zh.wikipedia.org/wiki/%E7%81%B5%E5%B1%B1_(%E4%B8%8A%E9%A5%B6)";
  const title = hostname === "zh.wikivoyage.org" ? "三清山" : "灵山（上饶）";
  return {
    1: {
      index: 1,
      title,
      extract: title + "位于江西省上饶市，适合作为自然风光候选。",
      fullurl: uri,
    },
    2: {
      index: 2,
      title: "不相关条目",
      extract: "这里没有可用的目的地资料。",
      fullurl: "https://" + hostname + "/wiki/irrelevant",
    },
    3: {
      index: 3,
      title: "不安全链接",
      extract: "上饶测试资料。",
      fullurl: "https://evil.example/wiki/unsafe",
    },
    4: {
      index: 4,
      title: "上饶轨道交通体系",
      extract: "上饶相关交通规划，不应作为游玩候选。",
      fullurl: "https://" + hostname + "/wiki/transport",
    },
    5: {
      index: 5,
      title: "上饶区",
      extract: "上饶相关行政区划，不应作为游玩候选。",
      fullurl: "https://" + hostname + "/wiki/administrative-area",
    },
  };
}

function fakePublicSources(captured) {
  return async (url, init) => {
    captured.push({ url, init });
    const hostname = new URL(url).hostname;
    return providerResponse(sourcePages(hostname));
  };
}

test("free public retrieval sends only a destination query and returns safe, cited sources for 上饶", async () => {
  const captured = [];
  const retrieval = await retrieveFreePublicTravelSources({
    ...planningPayload(),
    notes: "private-contact@example.invalid must never leave the service",
  }, {
    cache: new Map(),
    now: () => Date.UTC(2026, 8, 22, 12, 0, 0),
    fetchImpl: fakePublicSources(captured),
  });

  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((call) => new URL(call.url).hostname), ["zh.wikivoyage.org", "zh.wikipedia.org"]);
  assert.ok(captured.every((call) => new URL(call.url).searchParams.get("gsrsearch") === "上饶 旅游"));
  assert.ok(captured.every((call) => call.init.method == null));
  assert.ok(captured.every((call) => !Object.hasOwn(call.init.headers, "Authorization")));
  assert.equal(JSON.stringify(captured).includes("private-contact"), false);
  assert.equal(retrieval.mode, "free_public_sources");
  assert.equal(retrieval.status, "public_sources");
  assert.equal(retrieval.destination, "上饶");
  assert.equal(retrieval.source_count, 2);
  assert.ok(retrieval.sources.every((source) => source.uri.startsWith("https://zh.")));
  assert.ok(retrieval.sources.every((source) => source.source_id.startsWith("zh-")));
  assert.equal(retrieval.sources.some((source) => source.title.includes("轨道交通")), false);
  assert.equal(retrieval.sources.some((source) => source.title.endsWith("区")), false);
  assert.equal(JSON.stringify(retrieval).includes("private-contact"), false);
});

test("free public retrieval caches results without a second public-source request", async () => {
  const cache = new Map();
  const captured = [];
  let clock = Date.UTC(2026, 8, 22, 12, 0, 0);
  const options = {
    cache,
    now: () => clock,
    fetchImpl: fakePublicSources(captured),
  };

  const first = await retrieveFreePublicTravelSources(planningPayload(), options);
  clock += 17_000;
  const second = await retrieveFreePublicTravelSources(planningPayload(), options);

  assert.equal(captured.length, 2);
  assert.equal(first.status, "public_sources");
  assert.equal(second.status, "cache_hit");
  assert.equal(second.cache_age_seconds, 17);
});

test("free public retrieval deduplicates the same attraction returned by both public sources", async () => {
  const retrieval = await retrieveFreePublicTravelSources(planningPayload(), {
    cache: new Map(),
    fetchImpl: async (url) => {
      const hostname = new URL(url).hostname;
      return providerResponse({
        1: {
          index: 1,
          title: "三清山",
          extract: "三清山位于上饶市，适合作为自然风光候选。",
          fullurl: "https://" + hostname + "/wiki/%E4%B8%89%E6%B8%85%E5%B1%B1",
        },
      });
    },
  });
  assert.equal(retrieval.source_count, 1);
  assert.equal(retrieval.sources[0].title, "三清山");
});

test("free public retrieval returns an honest empty result and safe source failures", async () => {
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
      "仅查询目的地；选中的偏好只用于本次方案结构。不要输入个人信息。",
    ],
  });
});

test("free-source plan retains citations and limits its budget to in-destination play", () => {
  const retrieval = {
    mode: "free_public_sources",
    provider: "中文维基导游 / 中文维基百科",
    status: "public_sources",
    retrieved_at: "2026-09-22T12:00:00.000Z",
    cache_age_seconds: 0,
    source_count: 2,
    notices: ["行前核验。"],
    sources: [
      { source_id: "zh-wikivoyage-A", title: "上饶候选一", uri: "https://zh.wikivoyage.org/wiki/A", excerpt: "来源一" },
      { source_id: "zh-wikipedia-B", title: "上饶候选二", uri: "https://zh.wikipedia.org/wiki/B", excerpt: "来源二" },
    ],
  };
  const plan = buildFreePublicSourcePlan(planningPayload(), retrieval);

  assert.match(plan.plan_id, /^FREE-SOURCES-/);
  assert.equal(plan.request_summary.mock_mode, false);
  assert.equal(plan.request_summary.data_mode, "free_public_sources");
  assert.equal(plan.itinerary.length, 2);
  assert.ok(plan.itinerary.flatMap((day) => day.items).every((item) => item.estimated_cost_cny === null));
  assert.equal(plan.budget.mode, "rough_estimate");
  assert.equal(plan.budget.pricing_complete, false);
  assert.ok(plan.budget.estimated_total_cny > 0);
  assert.match(plan.budget.scope, /不含往返交通与住宿/);
  assert.ok(plan.budget.recommended_range_cny.minimum < plan.budget.estimated_total_cny);
  assert.ok(plan.budget.recommended_range_cny.maximum > plan.budget.estimated_total_cny);
  assert.equal(plan.budget.line_items.some((item) => item.category.includes("住宿")), false);
  assert.equal(plan.validation.passed, false);
  assert.deepEqual(
    new Set(plan.itinerary.flatMap((day) => day.items.map((item) => item.source_id))),
    new Set(["zh-wikivoyage-A", "zh-wikipedia-B"]),
  );
  assert.ok(plan.workflow_trace.some((entry) => entry.step === "retrieve_free_public_sources"));
});

test("free public API routes accept safe inputs, block notes, and keep rate limits", async () => {
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
    assert.equal(attractionsResponse.headers.get("netlify-cdn-cache-control"), "public, durable, max-age=300, stale-while-revalidate=300");
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
