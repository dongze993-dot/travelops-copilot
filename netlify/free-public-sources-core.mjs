/**
 * Credential-free public-source retrieval for the Netlify demo.
 *
 * This is deliberately a small, read-only lookup over Chinese Wikivoyage and
 * Chinese Wikipedia. It is not a general web crawler, it does not scrape
 * pages, and it does not call a model or a paid search service.
 */

const PUBLIC_SOURCES = Object.freeze([
  {
    id: "zh-wikivoyage",
    label: "中文维基导游",
    api: "https://zh.wikivoyage.org/w/api.php",
    hostname: "zh.wikivoyage.org",
  },
  {
    id: "zh-wikipedia",
    label: "中文维基百科",
    api: "https://zh.wikipedia.org/w/api.php",
    hostname: "zh.wikipedia.org",
  },
]);

const DEFAULT_TIMEOUT_MS = 3_500;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_CACHE_TTL_SECONDS = 600;
const MAX_INTERESTS = 8;
const MAX_INTEREST_LENGTH = 40;
const MAX_DESTINATION_LENGTH = 80;
const processCache = new Map();

export class FreePublicSourceError extends Error {
  constructor(code, detail, status = 503) {
    super(detail);
    this.name = "FreePublicSourceError";
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maximumLength);
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

function destinationNeedle(destination) {
  return String(destination || "")
    .trim()
    .replace(/(自治州|自治县|地区|市|县|区|盟)$/, "");
}

function pageMatchesDestination(page, destination) {
  const needle = destinationNeedle(destination);
  if (!needle) return false;
  const text = cleanText(String(page?.title || "") + " " + String(page?.extract || ""), 8_000);
  return text.includes(destination) || (needle.length >= 2 && text.includes(needle));
}

function safeSourceUrl(value, provider) {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== provider.hostname
      || parsed.username
      || parsed.password
    ) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
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

function makeSearchUrl(provider, input) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: input.destination + " 旅游",
    gsrnamespace: "0",
    gsrlimit: String(Math.min(12, Math.max(4, input.maxResults * 2))),
    prop: "extracts|info",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    origin: "*",
  });
  return provider.api + "?" + params.toString();
}

function normalisePages(body, provider, input) {
  const pages = Object.values(body?.query?.pages || {})
    .filter((page) => pageMatchesDestination(page, input.destination))
    .sort((left, right) => Number(left?.index || Number.MAX_SAFE_INTEGER) - Number(right?.index || Number.MAX_SAFE_INTEGER));
  const seen = new Set();

  return pages.flatMap((page) => {
    const uri = safeSourceUrl(page?.fullurl || page?.canonicalurl, provider);
    if (!uri || seen.has(uri)) return [];
    seen.add(uri);

    const title = cleanText(page?.title, 160) || new URL(uri).pathname;
    const excerpt = cleanText(page?.extract, 360);
    return [{
      source_id: provider.id + "-" + stableHash(uri),
      title,
      uri,
      excerpt,
      provider: provider.label,
      relevance: provider.label + "公开资料，请打开原页面核验。",
    }];
  });
}

function publicNotices(sourceCount) {
  const notices = [
    "本功能只查询免费公开资料页，不需要账号、绑卡或 API Key。",
    "景点开放状态、票价、餐饮价格和预约要求会变化；请在出行前打开来源页核验。",
    "本功能不调用 DeepSeek、不抓取网页全文、不办理预订，也不把摘要当作实时报价。",
  ];
  if (!sourceCount) {
    notices.unshift("未找到能与该目的地对应的公开资料页；系统没有借用其他城市或编造景点。");
  }
  return notices;
}

function cachedResult(entry, nowMs) {
  const ageSeconds = Math.max(0, Math.floor((nowMs - entry.storedAt) / 1_000));
  return {
    ...entry.result,
    status: entry.result.source_count ? "cache_hit" : "no_results",
    cache_age_seconds: ageSeconds,
  };
}

function providerError(status) {
  if (status === 429) {
    return new FreePublicSourceError("public_source_rate_limited", "公开资料站点暂时限流，请稍后再试。", 429);
  }
  if (status >= 500) {
    return new FreePublicSourceError("public_source_unavailable", "公开资料站点暂时不可用，请稍后再试。", 503);
  }
  return new FreePublicSourceError("public_source_request_failed", "公开资料查询未成功，请稍后再试。", 502);
}

function networkError(error) {
  if (error?.name === "AbortError") {
    return new FreePublicSourceError("public_source_timeout", "公开资料查询超时，请稍后再试。", 504);
  }
  return new FreePublicSourceError("public_source_network_error", "公开资料网络暂不可用，请稍后再试。", 503);
}

async function fetchProviderPages(provider, input, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(makeSearchUrl(provider, input), {
      headers: {
        Accept: "application/json",
        "User-Agent": "TravelOpsCopilot/1.0 (+https://github.com/dongze993-dot/travelops-copilot)",
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw networkError(error);
  } finally {
    clearTimeout(timer);
  }

  if (!response?.ok) throw providerError(Number(response?.status));
  try {
    return await response.json();
  } catch {
    throw new FreePublicSourceError("public_source_invalid_response", "公开资料站点返回了无法处理的数据，请稍后再试。", 502);
  }
}

/**
 * No environment variable is needed. This projection is returned from
 * /health so the browser can distinguish it from the local synthetic demo.
 */
export function freePublicSourceConfig() {
  return {
    enabled: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResults: DEFAULT_MAX_RESULTS,
    cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
  };
}

export function publicFreePublicSourceStatus() {
  return {
    enabled: true,
    mode: "free_public_sources",
    provider: "中文维基导游 / 中文维基百科",
    credential_exposed_to_browser: false,
    requires_api_key: false,
    notes: [
      "联网资料查询已启用：无需账号、绑卡或 API Key。",
      "仅查询目的地；选中的偏好只用于本次方案结构。不要输入个人信息。",
    ],
  };
}

export function makeTravelSearchInput(payload, config = freePublicSourceConfig()) {
  const destination = cleanText(payload?.destination, MAX_DESTINATION_LENGTH);
  if (!destination) {
    throw new FreePublicSourceError("invalid_destination", "destination 必须是 1 到 80 个字符。", 422);
  }
  const interests = normaliseInterests(payload?.interests);
  const requestedLimit = Number(payload?.requested_limit);
  const maxResults = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, config.maxResults))
    : config.maxResults;
  return { destination, interests, maxResults };
}

/**
 * Search two free, read-only Chinese Wikimedia endpoints. The request contains
 * only the validated destination and never sends a key, notes or budget.
 * Dependency injection keeps CI fully offline.
 */
export async function retrieveFreePublicTravelSources(payload, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cache = processCache,
} = {}) {
  const config = freePublicSourceConfig();
  if (typeof fetchImpl !== "function") {
    throw new FreePublicSourceError("public_source_unavailable", "公开资料查询运行环境不可用，请稍后再试。", 503);
  }

  const input = makeTravelSearchInput(payload, config);
  const key = cacheKeyFor(input);
  const nowMs = now();
  const cached = cache.get(key);
  if (cached && nowMs - cached.storedAt < config.cacheTtlSeconds * 1_000) {
    return cachedResult(cached, nowMs);
  }

  const sourceMap = new Map();
  const failures = [];
  for (const provider of PUBLIC_SOURCES) {
    try {
      const body = await fetchProviderPages(provider, input, { fetchImpl, timeoutMs: config.timeoutMs });
      for (const source of normalisePages(body, provider, input)) {
        if (sourceMap.size >= input.maxResults) break;
        sourceMap.set(source.uri, source);
      }
    } catch (error) {
      failures.push(error);
    }
    if (sourceMap.size >= input.maxResults) break;
  }

  if (!sourceMap.size && failures.length === PUBLIC_SOURCES.length) {
    throw failures[0];
  }

  const sources = [...sourceMap.values()];
  const result = {
    mode: "free_public_sources",
    provider: "中文维基导游 / 中文维基百科",
    status: sources.length ? "public_sources" : "no_results",
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

export function freePublicSourceErrorPayload(error) {
  if (error instanceof FreePublicSourceError) {
    return { status: error.status, body: { detail: error.message, code: error.code } };
  }
  return {
    status: 500,
    body: { detail: "公开演示暂时无法处理资料查询请求，请稍后再试。", code: "free_public_source_internal_error" },
  };
}
