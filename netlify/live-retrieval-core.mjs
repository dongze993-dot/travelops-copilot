/**
 * Server-side adapter for the explicitly opt-in live web retrieval mode.
 *
 * The browser never sees a provider credential. Only a small, allowlisted
 * request (destination + selected interests) reaches Tavily, and only safe
 * result fields return to the browser. This module intentionally does not
 * scrape result pages or turn snippets into verified prices, hours, or
 * availability.
 */

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_CACHE_TTL_SECONDS = 600;
const MAX_INTERESTS = 8;
const MAX_INTEREST_LENGTH = 40;
const MAX_DESTINATION_LENGTH = 80;

// Netlify Functions may reuse an isolate, but do not rely on this cache for
// durable quota protection. It is only a short best-effort reduction in
// duplicate outbound calls. Public exposure needs a durable rate limit.
const processCache = new Map();

export class LiveRetrievalError extends Error {
  constructor(code, detail, status = 503) {
    super(detail);
    this.name = "LiveRetrievalError";
    this.code = code;
    this.status = status;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function truthy(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function safeHttpsUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function stableHash(text) {
  let hash = 2166136261;
  for (const character of String(text)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0");
}

function normaliseInterests(interests) {
  if (!Array.isArray(interests)) return [];
  return [...new Set(interests
    .map((item) => cleanText(item, MAX_INTEREST_LENGTH))
    .filter(Boolean))]
    .slice(0, MAX_INTERESTS);
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function cacheKeyFor(input) {
  return JSON.stringify({
    destination: input.destination,
    interests: input.interests,
    maxResults: input.maxResults,
  });
}

function normaliseTavilyResults(results) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();

  return results.flatMap((result) => {
    const uri = safeHttpsUrl(result?.url);
    if (!uri || seen.has(uri)) return [];
    seen.add(uri);

    const title = cleanText(result?.title, 160) || new URL(uri).hostname;
    const excerpt = cleanText(result?.content, 360);
    const publishedDate = cleanText(result?.published_date, 40);
    return [{
      source_id: `tavily-${stableHash(uri)}`,
      title,
      uri,
      excerpt,
      relevance: "联网网页检索结果，请打开原始来源核验",
      ...(publishedDate ? { published_date: publishedDate } : {}),
    }];
  });
}

function publicNotices(sourceCount) {
  const base = [
    "网页检索结果会随时间变化；请打开来源页核验开放状态、票价、交通和预约要求。",
    "本功能不抓取页面全文、不办理预订，也不把网页摘要当作已核验的事实。",
  ];
  if (!sourceCount) base.unshift("本次未找到可展示的网页来源，未生成替代城市或虚构景点。");
  return base;
}

export function liveRetrievalConfig(env = process.env) {
  const apiKey = typeof env.TAVILY_API_KEY === "string" ? env.TAVILY_API_KEY.trim() : "";
  const requested = truthy(env.TRAVELOPS_LIVE_RETRIEVAL_ENABLED);
  return {
    enabled: requested && Boolean(apiKey),
    requested,
    apiKey,
    timeoutMs: boundedInteger(env.TRAVELOPS_LIVE_RETRIEVAL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 8_000),
    maxResults: boundedInteger(env.TRAVELOPS_LIVE_RETRIEVAL_MAX_RESULTS, DEFAULT_MAX_RESULTS, 1, 8),
    cacheTtlSeconds: boundedInteger(
      env.TRAVELOPS_LIVE_RETRIEVAL_CACHE_TTL_SECONDS,
      DEFAULT_CACHE_TTL_SECONDS,
      60,
      3_600,
    ),
  };
}

/** A safe configuration projection suitable for the public /health route. */
export function publicLiveRetrievalStatus(env = process.env) {
  const config = liveRetrievalConfig(env);
  return {
    enabled: config.enabled,
    mode: "live_web",
    provider: config.enabled ? "tavily" : null,
    credential_exposed_to_browser: false,
    notes: config.enabled
      ? ["联网模式仅向检索服务发送目的地和选择的偏好；请勿输入个人信息。"]
      : ["联网检索尚未配置；当前仅可使用本地合成演示。"],
  };
}

/**
 * Keep the query intentionally small and auditable. Notes, contact details,
 * budget and any unknown request fields are never included.
 */
export function makeTravelSearchInput(payload, config = liveRetrievalConfig()) {
  const destination = cleanText(payload?.destination, MAX_DESTINATION_LENGTH);
  if (!destination) {
    throw new LiveRetrievalError("invalid_destination", "destination 必须是 1 到 80 个字符。", 422);
  }
  const interests = normaliseInterests(payload?.interests);
  const interestText = interests.length ? interests.join(" ") : "旅行";
  const requestedLimit = Number(payload?.requested_limit);
  const maxResults = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, config.maxResults))
    : config.maxResults;
  return {
    destination,
    interests,
    maxResults,
    query: `${destination} ${interestText} 旅游景点 出行参考`,
  };
}

function safeProviderError(responseStatus) {
  if (responseStatus === 401 || responseStatus === 403) {
    return new LiveRetrievalError("live_provider_auth_failed", "联网检索服务鉴权未通过，请由部署管理员检查服务器配置。", 503);
  }
  if (responseStatus === 429) {
    return new LiveRetrievalError("live_provider_rate_limited", "联网检索服务暂时限流，请稍后重试。", 429);
  }
  if (responseStatus === 432 || responseStatus === 433) {
    return new LiveRetrievalError("live_provider_quota_exhausted", "联网检索服务本期可用额度已用完，请稍后由部署管理员处理。", 429);
  }
  if (responseStatus >= 500) {
    return new LiveRetrievalError("live_provider_unavailable", "联网检索服务暂时不可用，请稍后重试。", 503);
  }
  return new LiveRetrievalError("live_provider_request_failed", "联网检索请求未成功，请稍后重试。", 502);
}

function safeNetworkError(error) {
  if (error?.name === "AbortError") {
    return new LiveRetrievalError("live_provider_timeout", "联网检索超时，请稍后重试。", 504);
  }
  return new LiveRetrievalError("live_provider_network_error", "联网检索网络暂不可用，请稍后重试。", 503);
}

function cachedResult(entry, nowMs) {
  const ageSeconds = Math.max(0, Math.floor((nowMs - entry.storedAt) / 1_000));
  return {
    ...entry.result,
    status: entry.result.source_count ? "cache_hit" : "no_results",
    cache_age_seconds: ageSeconds,
  };
}

/**
 * Retrieve a small source list with a Tavily-compatible provider response.
 * Dependency injection keeps CI fully offline: tests supply a fake fetch.
 */
export async function retrieveLiveTravelSources(payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cache = processCache,
} = {}) {
  const config = liveRetrievalConfig(env);
  if (!config.enabled) {
    throw new LiveRetrievalError(
      "live_retrieval_not_configured",
      "联网检索尚未配置。请由部署管理员在函数环境变量中启用后重试。",
      503,
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new LiveRetrievalError("live_provider_unavailable", "联网检索运行环境不可用，请稍后重试。", 503);
  }

  const input = makeTravelSearchInput(payload, config);
  const key = cacheKeyFor(input);
  const nowMs = now();
  const cached = cache.get(key);
  if (cached && nowMs - cached.storedAt < config.cacheTtlSeconds * 1_000) {
    return cachedResult(cached, nowMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        topic: "general",
        country: "china",
        language: "zh-cn",
        filter_by_language: true,
        search_depth: "basic",
        max_results: input.maxResults,
        chunks_per_source: 2,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
        include_usage: true,
        safe_search: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw safeNetworkError(error);
  } finally {
    clearTimeout(timer);
  }

  if (!response?.ok) throw safeProviderError(Number(response?.status));

  let body;
  try {
    body = await response.json();
  } catch {
    throw new LiveRetrievalError("live_provider_invalid_response", "联网检索服务返回了无法处理的数据，请稍后重试。", 502);
  }

  const sources = normaliseTavilyResults(body?.results).slice(0, input.maxResults);
  const result = {
    mode: "live_web",
    provider: "tavily",
    status: sources.length ? "live" : "no_results",
    destination: input.destination,
    retrieved_at: isoTime(nowMs),
    cache_age_seconds: 0,
    source_count: sources.length,
    sources,
    notices: publicNotices(sources.length),
  };
  cache.set(key, { storedAt: nowMs, result });
  return result;
}

export function liveRetrievalErrorPayload(error) {
  if (error instanceof LiveRetrievalError) {
    return { status: error.status, body: { detail: error.message, code: error.code } };
  }
  return {
    status: 500,
    body: { detail: "公开演示暂时无法处理联网检索请求，请稍后重试。", code: "live_retrieval_internal_error" },
  };
}
