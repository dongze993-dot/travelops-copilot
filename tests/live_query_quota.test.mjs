import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveQueryQuotaError,
  reserveLiveSearchQuota,
  utcDayKey,
} from "../netlify/live-query-quota.mjs";

function atomicFakeStore({ emptyEtag = false, fail = false } = {}) {
  const occupied = new Set();
  return {
    occupied,
    async setJSON(key, value, options) {
      assert.deepEqual(options, { onlyIfNew: true });
      assert.deepEqual(Object.keys(value).sort(), ["reserved_at", "schema_version"]);
      if (fail) throw new Error("store unavailable");
      if (occupied.has(key)) return { modified: false };
      occupied.add(key);
      return { modified: true, etag: emptyEtag ? "" : `etag-${occupied.size}` };
    },
  };
}

function quotaOptions(store, overrides = {}) {
  return {
    env: { TRAVELOPS_LIVE_RETRIEVAL_DAILY_QUOTA: "3" },
    now: () => Date.UTC(2026, 8, 21, 12, 0, 0),
    random: () => 0,
    storeFactory: async (config) => {
      assert.deepEqual(config, { name: "travelops-live-search-quota", consistency: "strong" });
      return store;
    },
    ...overrides,
  };
}

test("daily quota reserves immutable UTC slots without user data", async () => {
  const store = atomicFakeStore();
  const reservation = await reserveLiveSearchQuota(quotaOptions(store));

  assert.deepEqual(reservation, {
    status: "reserved",
    day: "2026-09-21",
    slot: 0,
    daily_quota: 3,
  });
  assert.deepEqual([...store.occupied], ["daily-slots/2026-09-21/000.json"]);
  assert.equal(utcDayKey(Date.UTC(2026, 8, 21, 12, 0, 0)), "2026-09-21");
});

test("daily quota never grants more requests than its fixed slots under concurrency", async () => {
  const store = atomicFakeStore();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => reserveLiveSearchQuota(quotaOptions(store))),
  );
  const granted = results.filter((result) => result.status === "fulfilled");
  const exhausted = results.filter((result) => result.status === "rejected"
    && result.reason instanceof LiveQueryQuotaError
    && result.reason.code === "live_search_demo_quota_exhausted");

  assert.equal(granted.length, 3);
  assert.equal(exhausted.length, 5);
  assert.equal(store.occupied.size, 3);
});

test("quota denies provider work when the store throws or reports an unsafe conditional-write outcome", async () => {
  await assert.rejects(
    () => reserveLiveSearchQuota(quotaOptions(atomicFakeStore({ fail: true }))),
    (error) => error instanceof LiveQueryQuotaError && error.code === "live_search_quota_unavailable" && error.status === 503,
  );
  await assert.rejects(
    () => reserveLiveSearchQuota(quotaOptions(atomicFakeStore({ emptyEtag: true }))),
    (error) => error instanceof LiveQueryQuotaError && error.code === "live_search_quota_unavailable" && error.status === 503,
  );
});
