import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("public travel page defaults to the free source route and hides engineering status", async () => {
  const [html, app] = await Promise.all([
    readFile(resolve(projectRoot, "frontend/index.html"), "utf8"),
    readFile(resolve(projectRoot, "frontend/app.js"), "utf8"),
  ]);

  assert.match(html, /生成旅行计划/);
  assert.match(html, /每天怎么安排/);
  assert.match(html, /游玩预算参考/);
  assert.match(html, /本计划参考资料/);
  assert.doesNotMatch(html, /工作流轨迹|人工复核|运营方案|创建演示工单/);

  assert.match(app, /const isNetlifySite/);
  assert.match(app, /if \(isNetlifySite\) setPublicCopy\(\)/);
  assert.match(app, /const useFreeRoute = useFreePublicSources/);
  assert.match(app, /useFreeRoute \? API\.freePlan : API\.plan/);
  assert.doesNotMatch(app, /modelPlan|workflow-trace|人工复核|ticketForm/);
});
