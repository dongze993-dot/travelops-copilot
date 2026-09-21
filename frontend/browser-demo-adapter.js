import { createStaticDemoApi } from "./static-demo-core.mjs";

async function loadSyntheticRecords() {
  const response = await fetch("./data/attractions.json", { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`静态合成资料加载失败（HTTP ${response.status}）。`);
  }
  const records = await response.json();
  if (!Array.isArray(records)) {
    throw new Error("静态合成资料格式无效。");
  }
  return records;
}

// app.js awaits this object only when the static build sets its runtime flag.
globalThis.TravelOpsStaticDemo = createStaticDemoApi(loadSyntheticRecords);
