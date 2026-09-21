import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveWebPlan } from "../netlify/live-plan-core.mjs";
import {
  LiveRetrievalError,
  liveRetrievalConfig,
  publicLiveRetrievalStatus,
  retrieveLiveTravelSources,
} from "../netlify/live-retrieval-core.mjs";
import liveAttractions, { config as liveAttractionsConfig } from "../netlify/functions/live-attractions.mjs";
import livePlan, { config as livePlanConfig } from "../netlify/functions/live-plans.mjs";

const ORIGIN = "https://travelops-netlify.example";

function enabledEnvironment(overrides = {}) {
  return {
    TRAVELOPS_LIVE_RETRIEVAL_ENABLED: "true",
    TAVILY_API_KEY: "test-tavily-secret",
    TRAVELOPS_LIVE_RETRIEVAL_MAX_RESULTS: "6",
    TRAVELOPS_LIVE_RETRIEVAL_TIMEOUT_MS: "4000",
    TRAVELOPS_LIVE_RETRIEVAL_CACHE_TTL_SECONDS: "600",
    ...overrides,
  };
}

function planningPayload(overrides = {}) {
  return {
    destination: "上饶",
    days: 2,
    travelers: 2,
    total_budget_cny: 2400,
    interests: ["自然", "文化"],
    travel_style: "balanced",
    ...overrides,
  };
}

function providerResponse(results) {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("live retrieval sends only bounded destination/interests and returns safe source citations for 上饶", async () => {
  const captured = [];
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  const retrieval = await retrieveLiveTravelSources({
    ...planningPayload(),
    notes: "private-contact@example.invalid must never leave the server",
  }, {
    env: enabledEnvironment(),
    cache: new Map(),
    now: () => now,
    fetchImpl: async (url, init) => {
      captured.push({ url, init });
      return providerResponse([
        {
          title: "上饶旅游出行参考",
          url: "https://example.com/shangrao-guide#ignored-fragment",
          content: "示例网页摘要：请在原页面核验开放时间与预约要求。",
          published_date: "2026-09-20",
        },
        {
          title: "重复链接应去重",
          url: "https://example.com/shangrao-guide#other-fragment",
          content: "重复结果。",
        },
        {
          title: "不安全协议不能展示",
          url: "javascript:alert(1)",
          content: "不应出现。",
        },
      ]);
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://api.tavily.com/search");
  assert.equal(captured[0].init.headers.Authorization, "Bearer test-tavily-secret");
  const sent = JSON.parse(captured[0].init.body);
  assert.match(sent.query, /上饶/);
  assert.match(sent.query, /自然/);
  assert.equal(sent.query.includes("private-contact"), false);
  assert.equal(sent.include_answer, false);
  assert.equal(sent.include_raw_content, false);
  assert.equal(sent.include_images, false);
  assert.equal(retrieval.status, "live");
  assert.equal(retrieval.source_count, 1);
  assert.equal(retrieval.destination, "上饶");
  assert.equal(retrieval.sources[0].uri, "https://example.com/shangrao-guide");
  assert.match(retrieval.sources[0].source_id, /^tavily-/);
  assert.equal(JSON.stringify(retrieval).includes("test-tavily-secret"), false);
  assert.equal(JSON.stringify(retrieval).includes("private-contact"), false);
});

test("live retrieval cache avoids a duplicate provider call and reports cache age", async () => {
  const cache = new Map();
  let calls = 0;
  let clock = Date.UTC(2026, 8, 21, 12, 0, 0);
  const options = {
    env: enabledEnvironment(),
    cache,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return providerResponse([{ title: "上饶来源", url: "https://example.com/shangrao", content: "检索摘要" }]);
    },
  };

  const first = await retrieveLiveTravelSources(planningPayload(), options);
  clock += 17_000;
  const second = await retrieveLiveTravelSources(planningPayload(), options);

  assert.equal(calls, 1);
  assert.equal(first.status, "live");
  assert.equal(second.status, "cache_hit");
  assert.equal(second.cache_age_seconds, 17);
});

test("live retrieval fails closed when no server-side key is configured", async () => {
  await assert.rejects(
    () => retrieveLiveTravelSources(planningPayload(), {
      env: { TRAVELOPS_LIVE_RETRIEVAL_ENABLED: "true" },
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    }),
    (error) => error instanceof LiveRetrievalError && error.code === "live_retrieval_not_configured" && error.status === 503,
  );

  assert.deepEqual(publicLiveRetrievalStatus({ TRAVELOPS_LIVE_RETRIEVAL_ENABLED: "true" }), {
    enabled: false,
    mode: "live_web",
    provider: null,
    credential_exposed_to_browser: false,
    notes: ["联网检索尚未配置；当前仅可使用本地合成演示。"],
  });
  assert.equal(liveRetrievalConfig({ TAVILY_API_KEY: "secret" }).enabled, false);
});

test("live retrieval returns safe provider failure codes without exposing a key or response body", async () => {
  await assert.rejects(
    () => retrieveLiveTravelSources(planningPayload(), {
      env: enabledEnvironment(),
      cache: new Map(),
      fetchImpl: async () => new Response("provider said test-tavily-secret", { status: 432 }),
    }),
    (error) => error instanceof LiveRetrievalError
      && error.code === "live_provider_quota_exhausted"
      && !error.message.includes("test-tavily-secret"),
  );

  await assert.rejects(
    () => retrieveLiveTravelSources(planningPayload(), {
      env: enabledEnvironment(),
      cache: new Map(),
      fetchImpl: async () => {
        const error = new Error("timeout");
        error.name = "AbortError";
        throw error;
      },
    }),
    (error) => error instanceof LiveRetrievalError && error.code === "live_provider_timeout" && error.status === 504,
  );
});

test("live web plan retains source IDs and labels prices as unverified rather than zero", () => {
  const retrieval = {
    mode: "live_web",
    provider: "tavily",
    status: "live",
    retrieved_at: "2026-09-21T12:00:00.000Z",
    cache_age_seconds: 0,
    source_count: 2,
    notices: ["行前核验。"],
    sources: [
      { source_id: "tavily-A", title: "上饶候选一", uri: "https://example.com/a", excerpt: "来源一" },
      { source_id: "tavily-B", title: "上饶候选二", uri: "https://example.com/b", excerpt: "来源二" },
    ],
  };
  const plan = buildLiveWebPlan(planningPayload(), retrieval);

  assert.match(plan.plan_id, /^LIVE-WEB-/);
  assert.equal(plan.request_summary.mock_mode, false);
  assert.equal(plan.request_summary.data_mode, "live_web");
  assert.equal(plan.itinerary.length, 2);
  assert.ok(plan.itinerary.flatMap((day) => day.items).every((item) => item.estimated_cost_cny === null));
  assert.equal(plan.budget.mode, "allocation_framework");
  assert.equal(plan.budget.pricing_complete, false);
  assert.equal(plan.budget.estimated_total_cny, null);
  assert.equal(plan.validation.passed, false);
  assert.deepEqual(
    new Set(plan.itinerary.flatMap((day) => day.items.map((item) => item.source_id))),
    new Set(["tavily-A", "tavily-B"]),
  );
  assert.ok(plan.workflow_trace.some((entry) => entry.step === "retrieve_live_web"));
});

test("live API routes fail closed without configuration and keep public rate limits", async () => {
  const request = new Request(`${ORIGIN}/api/v3/live-plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(planningPayload()),
  });
  const response = await livePlan(request);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "live_retrieval_not_configured");
  assert.equal(JSON.stringify(body).includes("TAVILY_API_KEY"), false);

  const notesResponse = await livePlan(new Request(`${ORIGIN}/api/v3/live-plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(planningPayload({ notes: "do not forward me" })),
  }));
  assert.equal(notesResponse.status, 422);

  const liveAttractionsResponse = await liveAttractions(new Request(`${ORIGIN}/api/v3/live-attractions?destination=%E4%B8%8A%E9%A5%B6`, {
    method: "GET",
  }));
  assert.equal(liveAttractionsResponse.status, 503);
  assert.equal(liveAttractionsResponse.headers.get("netlify-cdn-cache-control"), null);

  for (const routeConfig of [livePlanConfig, liveAttractionsConfig]) {
    assert.deepEqual(routeConfig.rateLimit, {
      windowLimit: 3,
      windowSize: 60,
      aggregateBy: ["ip", "domain"],
    });
  }
});
