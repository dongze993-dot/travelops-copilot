/**
 * Durable, global daily reservation slots for live web search.
 *
 * A mutable "count" document would be vulnerable to lost updates under
 * concurrency. Instead, each query reserves exactly one immutable slot with
 * Netlify Blobs' atomic `onlyIfNew` condition. The date/key contains no user
 * data and old daily slots may be cleaned up independently. This is an
 * availability guard for a demo, not a financial-spend guarantee.
 */

const DEFAULT_DAILY_QUOTA = 15;
const MAX_DAILY_QUOTA = 100;
const STORE_NAME = "travelops-live-search-quota";

export class LiveQueryQuotaError extends Error {
  constructor(code, detail, status = 503) {
    super(detail);
    this.name = "LiveQueryQuotaError";
    this.code = code;
    this.status = status;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export function liveQueryQuotaConfig(env = process.env) {
  return {
    dailyQuota: boundedInteger(
      env.TRAVELOPS_LIVE_RETRIEVAL_DAILY_QUOTA,
      DEFAULT_DAILY_QUOTA,
      1,
      MAX_DAILY_QUOTA,
    ),
  };
}

export function utcDayKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function slotKey(day, slot) {
  return `daily-slots/${day}/${String(slot).padStart(3, "0")}.json`;
}

async function runtimeStoreFactory(options) {
  // Dynamic import keeps the offline Node tests independent from the Netlify
  // runtime package. Netlify installs the declared package before a deploy.
  const { getStore } = await import("@netlify/blobs");
  return getStore(options);
}

function wasReserved(result) {
  return result?.modified === true && typeof result.etag === "string" && result.etag.length > 0;
}

/**
 * Reserve one of N daily slots. Store errors deny the request, so an unknown
 * quota state can never result in a paid provider call.
 */
export async function reserveLiveSearchQuota({
  env = process.env,
  now = () => Date.now(),
  random = Math.random,
  storeFactory = runtimeStoreFactory,
} = {}) {
  const { dailyQuota } = liveQueryQuotaConfig(env);
  const timestampMs = now();
  const day = utcDayKey(timestampMs);
  let store;
  try {
    store = await storeFactory({ name: STORE_NAME, consistency: "strong" });
  } catch {
    throw new LiveQueryQuotaError(
      "live_search_quota_unavailable",
      "联网检索额度保护暂时不可用，为避免意外消耗额度已暂停请求。",
      503,
    );
  }

  const initialSlot = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * dailyQuota);
  for (let offset = 0; offset < dailyQuota; offset += 1) {
    const slot = (initialSlot + offset) % dailyQuota;
    try {
      const result = await store.setJSON(slotKey(day, slot), {
        schema_version: 1,
        reserved_at: new Date(timestampMs).toISOString(),
      }, { onlyIfNew: true });
      if (wasReserved(result)) {
        return { status: "reserved", day, slot, daily_quota: dailyQuota };
      }
      if (result?.modified !== false) {
        throw new LiveQueryQuotaError(
          "live_search_quota_unavailable",
          "联网检索额度保护暂时不可用，为避免意外消耗额度已暂停请求。",
          503,
        );
      }
    } catch {
      throw new LiveQueryQuotaError(
        "live_search_quota_unavailable",
        "联网检索额度保护暂时不可用，为避免意外消耗额度已暂停请求。",
        503,
      );
    }
  }

  throw new LiveQueryQuotaError(
    "live_search_demo_quota_exhausted",
    "本演示今日的联网检索额度已用完，请明天再试或由部署管理员调整额度。",
    429,
  );
}
