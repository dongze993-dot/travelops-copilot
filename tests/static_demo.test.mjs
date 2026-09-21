import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STATIC_DEMO_FALLBACK_CODE,
  buildStaticPlan,
  createStaticDemoApi,
  searchAttractions,
} from "../frontend/static-demo-core.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = JSON.parse(await readFile(resolve(projectRoot, "data", "attractions.json"), "utf8"));

test("static search stays in the requested city and returns synthetic sources", () => {
  const results = searchAttractions(catalogue, "成都", ["文化", "自然"], 4);
  assert.ok(results.length >= 1);
  assert.ok(results.every((item) => item.city === "成都"));
  assert.ok(results.every((item) => item.source_url.startsWith("synthetic://")));
});

test("static plan produces a compatible deterministic itinerary and budget", () => {
  const plan = buildStaticPlan({
    destination: "成都",
    days: 2,
    travelers: 2,
    total_budget_cny: 2500,
    interests: ["文化", "自然"],
    travel_style: "balanced",
  }, catalogue);

  assert.match(plan.plan_id, /^STATIC-DEMO-/);
  assert.equal(plan.ticket, null);
  assert.equal(plan.itinerary.length, 2);
  assert.ok(plan.citations.length >= 1);
  assert.ok(plan.budget.estimated_total_cny > 0);
  assert.ok(plan.workflow_trace.some((entry) => entry.step === "finalize"));
  assert.ok(plan.validation.revision_count <= 1);
});

test("static plan never invents citations for an unknown city", () => {
  const plan = buildStaticPlan({
    destination: "不存在的城市",
    days: 2,
    travelers: 1,
    total_budget_cny: 2000,
    interests: ["文化"],
    travel_style: "budget",
  }, catalogue);

  assert.equal(plan.citations.length, 0);
  assert.equal(plan.validation.coverage_ok, false);
  assert.ok(plan.validation.issues.some((item) => item.includes("同城")));
});

test("static adapter blocks tickets and labels v2 as a local fallback", async () => {
  const api = createStaticDemoApi(async () => catalogue);
  await assert.rejects(
    () => api.postJson("/api/v1/tickets", { title: "x" }),
    /不提供工单读写/,
  );
  const plan = await api.postJson("/api/v2/plans", {
    destination: "成都",
    days: 1,
    travelers: 1,
    total_budget_cny: 2000,
    travel_style: "budget",
  });
  assert.equal(plan.generation.mode, "deterministic_fallback");
  assert.equal(plan.generation.fallback_code, STATIC_DEMO_FALLBACK_CODE);
  assert.equal(plan.narrative, null);
});
