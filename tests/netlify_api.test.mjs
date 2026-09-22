import assert from "node:assert/strict";
import test from "node:test";

import attractions from "../netlify/functions/attractions.mjs";
import health from "../netlify/functions/health.mjs";
import planV1 from "../netlify/functions/plans-v1.mjs";
import planV2 from "../netlify/functions/plans-v2.mjs";
import ticketsBlock from "../netlify/functions/tickets-block.mjs";

const ORIGIN = "https://travelops-netlify.example";

function request(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

async function jsonResponse(handler, path, init = {}) {
  const response = await handler(request(path, init));
  return { response, body: response.status === 204 ? null : await response.json() };
}

function planningPayload(overrides = {}) {
  return {
    destination: "成都",
    days: 2,
    travelers: 2,
    total_budget_cny: 2500,
    interests: ["文化", "自然"],
    travel_style: "balanced",
    ...overrides,
  };
}

function postPlan(handler, payload) {
  return jsonResponse(handler, "/api/v1/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("Netlify health endpoint describes the bounded public API mode", async () => {
  const { response, body } = await jsonResponse(health, "/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.status, "ok");
  assert.equal(body.mode, "deterministic_mock");
  assert.equal(body.knowledge_records, 12);
  assert.equal(body.public_demo_mode, true);
  assert.equal(body.deployment, "netlify_functions");
  assert.equal(body.model_calls_enabled, false);
  assert.equal(body.free_public_sources.enabled, true);
  assert.equal(body.free_public_sources.requires_api_key, false);
});

test("Netlify endpoints reject an unsupported HTTP method and answer CORS preflight", async () => {
  const wrongMethod = await jsonResponse(health, "/health", { method: "POST" });
  assert.equal(wrongMethod.response.status, 405);
  assert.match(wrongMethod.body.detail, /Method POST/);
  assert.equal(wrongMethod.response.headers.get("allow"), "GET, OPTIONS");

  const preflight = await health(request("/health", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("allow"), "GET, OPTIONS");
});

test("Netlify attraction search is city-bounded and cites only checked-in synthetic records", async () => {
  const { response, body } = await jsonResponse(
    attractions,
    "/api/v1/attractions?destination=%E6%88%90%E9%83%BD&interests=%E6%96%87%E5%8C%96,%E8%87%AA%E7%84%B6&limit=2",
  );

  assert.equal(response.status, 200);
  assert.equal(body.destination, "成都");
  assert.equal(body.items.length, 2);
  assert.ok(body.items.every((item) => item.city === "成都"));
  assert.ok(body.items.every((item) => item.source_url.startsWith("synthetic://")));
  assert.deepEqual(
    body.citations.map((citation) => citation.source_id).sort(),
    body.items.map((item) => item.id).sort(),
  );
  assert.ok(body.citations.every((citation) => citation.uri.startsWith("synthetic://")));

  const unknown = await jsonResponse(
    attractions,
    "/api/v1/attractions?destination=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E5%9F%8E%E5%B8%82",
  );
  assert.equal(unknown.response.status, 200);
  assert.deepEqual(unknown.body.items, []);
  assert.deepEqual(unknown.body.citations, []);
});

test("Netlify attraction search validates its public query boundary", async () => {
  const missingDestination = await jsonResponse(attractions, "/api/v1/attractions?limit=2");
  assert.equal(missingDestination.response.status, 422);
  assert.match(missingDestination.body.detail, /destination/);

  const badLimit = await jsonResponse(attractions, "/api/v1/attractions?destination=%E6%88%90%E9%83%BD&limit=0");
  assert.equal(badLimit.response.status, 422);
  assert.match(badLimit.body.detail, /limit/);
});

test("Netlify v1 plan is a deterministic, renderer-compatible public result", async () => {
  const privateNote = "private-contact@example.invalid";
  const { response, body: plan } = await postPlan(planV1, planningPayload({ notes: privateNote }));

  assert.equal(response.status, 200);
  assert.match(plan.plan_id, /^LOCAL-DEMO-/);
  assert.equal(plan.ticket, null);
  assert.equal(plan.request_summary.destination, "成都");
  assert.equal(plan.itinerary.length, 2);
  assert.ok(plan.itinerary.every((day, index) => day.day === index + 1 && day.items.length > 0));
  assert.ok(plan.citations.length >= 1);
  assert.ok(plan.citations.every((citation) => citation.uri.startsWith("synthetic://")));
  assert.ok(plan.workflow_trace.some((entry) => entry.step === "finalize" && entry.detail.includes("Netlify Function")));
  assert.ok(plan.workflow_trace.some((entry) => entry.step === "finalize" && entry.detail.includes("未调用模型、工单或 FastAPI")));
  assert.equal(plan.validation.revision_count <= 1, true);

  const lineItemTotal = plan.budget.line_items.reduce((total, item) => total + item.amount_cny, 0);
  assert.ok(Math.abs(plan.budget.estimated_total_cny - lineItemTotal) < 0.001);
  assert.ok(Math.abs(plan.budget.remaining_cny - (2500 - plan.budget.estimated_total_cny)) < 0.001);
  assert.equal(JSON.stringify(plan).includes(privateNote), false);
});

test("Netlify v2 declares a model-disabled fallback and makes no model network request", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("The Netlify public adapter must not call a model provider.");
  };

  try {
    const { response, body: plan } = await postPlan(planV2, planningPayload());

    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 0);
    assert.equal(plan.generation.mode, "deterministic_fallback");
    assert.equal(plan.generation.provider, "netlify-functions");
    assert.equal(plan.generation.model, null);
    assert.equal(plan.generation.fallback_code, "llm_disabled");
    assert.equal(plan.generation.attempts, 0);
    assert.equal(plan.generation.usage, null);
    assert.equal(plan.narrative, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Netlify public mode blocks both ticket routes and ticket creation from planning", async () => {
  for (const path of ["/api/v1/tickets", "/api/v1/tickets/demo-id", "/api/tickets"]) {
    const { response, body } = await jsonResponse(ticketsBlock, path, { method: "GET" });
    assert.equal(response.status, 403, path);
    assert.match(body.detail, /关闭模拟工单读写/);
  }

  const directPost = await jsonResponse(ticketsBlock, "/api/v1/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "do not store this" }),
  });
  assert.equal(directPost.response.status, 403);

  const v1 = await postPlan(planV1, planningPayload({ create_follow_up_ticket: true }));
  assert.equal(v1.response.status, 403);
  assert.match(v1.body.detail, /关闭模拟工单读写/);

  const v2 = await postPlan(planV2, planningPayload({ create_follow_up_ticket: true }));
  assert.equal(v2.response.status, 403);
});

test("Netlify plans reject malformed JSON, invalid input, and non-POST requests", async () => {
  const malformed = await jsonResponse(planV1, "/api/v1/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.response.status, 400);
  assert.match(malformed.body.detail, /有效 JSON/);

  const invalidPayload = await postPlan(planV1, planningPayload({ days: 0 }));
  assert.equal(invalidPayload.response.status, 422);
  assert.match(invalidPayload.body.detail, /days/);

  const invalidInterests = await postPlan(planV2, planningPayload({ interests: ["文化", 2] }));
  assert.equal(invalidInterests.response.status, 422);
  assert.match(invalidInterests.body.detail, /interests/);

  const wrongMethod = await jsonResponse(planV1, "/api/v1/plans", { method: "GET" });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "POST, OPTIONS");
});
