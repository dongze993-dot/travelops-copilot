/**
 * Credential-free public-source retrieval for the Netlify demo.
 *
 * This is deliberately a small, read-only lookup over Chinese Wikivoyage and
 * Chinese Wikipedia. It is not a general web crawler, it does not scrape
 * commercial pages, and it does not call a model or a paid search service.
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
const MAX_SEARCH_QUERIES_PER_PROVIDER = 4;
const MAX_ENRICHED_PAGES_PER_PROVIDER = 3;
const MAX_SOURCE_EXCERPT_LENGTH = 640;
const MAX_EXTRACT_CHARS = 1_200;
const MAX_PRICE_EVIDENCE_PER_SOURCE = 3;
const MAX_PRICE_EVIDENCE_DETAIL_LENGTH = 220;
const NON_VISIT_TITLE_PATTERN = /(轨道交通|交通体系|经济带|铁路|高速公路|规划|集中营|行政区划|学校|政府|公司|列表)/u;
const GENERIC_ADMIN_TITLE_PATTERN = /(自治州|自治县|市|区|县|地区|盟)$/u;
const CNY_AMOUNT_PATTERN = /(?:人民币\s*)?(?:[￥¥]\s*(\d{1,5}(?:\.\d{1,2})?)|(\d{1,5}(?:\.\d{1,2})?)\s*元)/gu;
const PER_PERSON_PATTERN = /(每人|每位|每名|\/\s*人|成人票|学生票|儿童票|全票|半票)/u;
const PRICE_KINDS = Object.freeze([
  { pattern: /(门票|票价|成人票|学生票|儿童票|通票|套票|联票|入场费|入园费|参观费|游览费)/u, label: "景点入场费用", admission: true },
  { pattern: /(索道票|观光车票|景区交通)/u, label: "景区交通费用", admission: false },
  { pattern: /(人均消费|餐饮|餐费|小吃|餐馆|饭店)/u, label: "餐饮价格", admission: false },
  { pattern: /(收费标准|收费|费用|价格)/u, label: "公开页面价格", admission: false },
]);
const INTEREST_SEARCH_TERMS = Object.freeze([
  { label: "自然风光", query: "自然风光", aliases: ["自然风光", "自然", "山水", "自然景观", "户外"] },
  { label: "人文历史", query: "人文历史", aliases: ["人文历史", "人文", "历史", "文化", "古迹", "博物馆"] },
  { label: "本地美食", query: "美食", aliases: ["本地美食", "美食", "小吃", "餐饮", "美食探索"] },
  { label: "亲子轻松", query: "亲子", aliases: ["亲子轻松", "亲子", "轻松", "家庭"] },
]);
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
  const submitted = interests
    .map((item) => cleanText(item, MAX_INTEREST_LENGTH).toLocaleLowerCase())
    .filter(Boolean)
    .slice(0, MAX_INTERESTS);
  return INTEREST_SEARCH_TERMS.filter((interest) => submitted.some((item) => (
    interest.aliases.some((alias) => item.includes(alias.toLocaleLowerCase()))
  )));
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

function isVisitCandidate(page, destination, provider) {
  const title = cleanText(page?.title, 160);
  return pageMatchesDestination(page, destination)
    && !NON_VISIT_TITLE_PATTERN.test(title)
    // On Wikivoyage, a title such as "玉山县" is often the travel guide for
    // that place rather than an administrative encyclopedia entry. Keep it so
    // a prefecture-level destination can surface its nearby county guides.
    && (provider.id === "zh-wikivoyage" || !GENERIC_ADMIN_TITLE_PATTERN.test(title))
    // District/city encyclopedia-style titles are not useful destination
    // stops even on Wikivoyage. County guides remain allowed above.
    && !(provider.id === "zh-wikivoyage" && /(市|区)$/u.test(title));
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

function sourceIdentity(source) {
  return cleanText(source?.title, 160)
    .replace(/[\s()（）]/g, "")
    .toLocaleLowerCase();
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function pageIdFor(page) {
  const pageId = Number(page?.pageid);
  return Number.isSafeInteger(pageId) && pageId > 0 ? String(pageId) : "";
}

function cacheKeyFor(input) {
  return JSON.stringify({
    destination: input.destination,
    queryTerms: input.queryTerms,
    maxResults: input.maxResults,
  });
}

function makeSearchQueries(input) {
  const focusTerms = input.interests.map((interest) => interest.query);
  const groupCount = Math.min(
    Math.max(0, MAX_SEARCH_QUERIES_PER_PROVIDER - 2),
    focusTerms.length,
  );
  const groups = Array.from({ length: groupCount }, () => []);
  for (const [index, term] of focusTerms.entries()) {
    if (groups.length) groups[index % groups.length].push(term);
  }
  return [
    { text: input.destination + " 旅游", interests: [] },
    { text: input.destination + " 景点", interests: [] },
    ...groups.map((terms) => ({
      text: input.destination + " " + terms.join(" "),
      interests: terms,
    })),
  ];
}

function makeSearchUrl(provider, input, query) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query.text,
    gsrnamespace: "0",
    gsrlimit: String(Math.min(8, Math.max(4, input.maxResults + 2))),
    prop: "extracts|info",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    exchars: "360",
    redirects: "1",
    origin: "*",
  });
  return provider.api + "?" + params.toString();
}

function makeExtractUrl(provider, candidate) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    pageids: candidate.pageId,
    prop: "extracts|info",
    inprop: "url",
    explaintext: "1",
    exchars: String(MAX_EXTRACT_CHARS),
    redirects: "1",
    origin: "*",
  });
  return provider.api + "?" + params.toString();
}

function priceKindFromContext(context, amountOffset) {
  const matches = [];
  for (const kind of PRICE_KINDS) {
    const pattern = new RegExp(kind.pattern.source, "gu");
    for (const match of context.matchAll(pattern)) {
      const start = Number(match.index || 0);
      const end = start + match[0].length;
      const distance = amountOffset < start
        ? start - amountOffset
        : amountOffset > end
          ? amountOffset - end
          : 0;
      matches.push({ kind, start, end, distance });
    }
  }
  matches.sort((left, right) => left.distance - right.distance || left.start - right.start);
  return matches[0] || null;
}

function priceEvidenceDetail(sentence, amountOffset) {
  if (sentence.length <= MAX_PRICE_EVIDENCE_DETAIL_LENGTH) return cleanText(sentence, MAX_PRICE_EVIDENCE_DETAIL_LENGTH);
  const start = Math.max(0, amountOffset - 90);
  const end = Math.min(sentence.length, amountOffset + 130);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < sentence.length ? "…" : "";
  return prefix + cleanText(sentence.slice(start, end), MAX_PRICE_EVIDENCE_DETAIL_LENGTH - 2) + suffix;
}

function extractPriceEvidence(extract, sourceUrl) {
  const text = cleanText(extract, MAX_EXTRACT_CHARS);
  if (!text || !sourceUrl) return [];
  const evidences = [];
  const seen = new Set();
  const sentences = text.match(/[^。！？；\n]+[。！？；]?/gu) || [];

  for (const sentence of sentences) {
    CNY_AMOUNT_PATTERN.lastIndex = 0;
    const amountMatches = [...sentence.matchAll(CNY_AMOUNT_PATTERN)];
    for (const match of amountMatches) {
      const amount = Number(match[1] || match[2]);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) continue;
      const amountOffset = Number(match.index || 0);
      const context = sentence.slice(
        Math.max(0, amountOffset - 56),
        Math.min(sentence.length, amountOffset + match[0].length + 56),
      );
      const contextAmountOffset = amountOffset - Math.max(0, amountOffset - 56);
      const priceMatch = priceKindFromContext(context, contextAmountOffset);
      if (!priceMatch) continue;

      const scopeContext = context.slice(
        Math.max(0, priceMatch.start - 20),
        Math.min(context.length, priceMatch.end + 40),
      );
      const perPerson = priceMatch.kind.admission && PER_PERSON_PATTERN.test(scopeContext);
      const detail = priceEvidenceDetail(sentence, amountOffset);
      const key = [amount, priceMatch.kind.label, detail].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      evidences.push({
        amount_cny: amount,
        detail,
        source_url: sourceUrl,
        pricing_scope: perPerson ? "per_person" : "unspecified",
        per_person: perPerson,
        // A sentence with several prices often describes mutually exclusive
        // ticket choices (for example, a pass and a single-attraction ticket).
        // Keep every source fact visible, but never add those choices together.
        aggregation_safe: amountMatches.length === 1,
      });
      if (evidences.length >= MAX_PRICE_EVIDENCE_PER_SOURCE) return evidences;
    }
  }
  return evidences;
}

function normaliseSearchPages(body, provider, input, query) {
  const pages = Object.values(body?.query?.pages || {})
    .filter((page) => isVisitCandidate(page, input.destination, provider))
    .sort((left, right) => Number(left?.index || Number.MAX_SAFE_INTEGER) - Number(right?.index || Number.MAX_SAFE_INTEGER));

  return pages.flatMap((page) => {
    const uri = safeSourceUrl(page?.fullurl || page?.canonicalurl, provider);
    if (!uri) return [];
    const title = cleanText(page?.title, 160) || new URL(uri).pathname;
    return [{
      pageId: pageIdFor(page),
      source: {
        source_id: provider.id + "-" + stableHash(uri),
        title,
        uri,
        excerpt: cleanText(page?.extract, MAX_SOURCE_EXCERPT_LENGTH),
        provider: provider.label,
        matched_interests: query.interests,
        price_evidence: [],
        relevance: provider.label + "公开资料，请打开原页面核验。",
      },
    }];
  });
}

function collectProviderCandidates(searchResults) {
  const candidateMap = new Map();
  for (const { body, query, provider, input } of searchResults) {
    for (const candidate of normaliseSearchPages(body, provider, input, query)) {
      const existing = candidateMap.get(candidate.source.uri);
      if (!existing) {
        candidateMap.set(candidate.source.uri, candidate);
        continue;
      }
      existing.source.matched_interests = [...new Set([
        ...existing.source.matched_interests,
        ...candidate.source.matched_interests,
      ])];
      if (!existing.pageId && candidate.pageId) existing.pageId = candidate.pageId;
    }
  }
  return [...candidateMap.values()];
}

function detailPageFor(body, pageId) {
  return Object.values(body?.query?.pages || {}).find((page) => pageIdFor(page) === pageId) || null;
}

function enrichCandidate(candidate, detailPage, provider) {
  if (!detailPage) return candidate.source;
  const uri = safeSourceUrl(detailPage?.fullurl || detailPage?.canonicalurl, provider) || candidate.source.uri;
  const title = cleanText(detailPage?.title, 160) || candidate.source.title;
  const extract = cleanText(detailPage?.extract, MAX_EXTRACT_CHARS);
  const excerpt = cleanText(extract || candidate.source.excerpt, MAX_SOURCE_EXCERPT_LENGTH);
  return {
    ...candidate.source,
    title,
    uri,
    excerpt,
    price_evidence: extractPriceEvidence(extract || candidate.source.excerpt, uri),
  };
}

function publicNotices(sourceCount) {
  const notices = [
    "本功能只查询免费公开资料页，不需要账号、绑卡或 API Key。",
    "仅向资料站发送目的地和经过固定映射的旅行偏好；不会发送备注、预算或个人信息。",
    "票价候选仅来自公开条目摘要中明确出现的中文金额和费用语境；它不是实时报价，也不会自动当作预算。",
    "景点开放状态、票价、餐饮价格和预约要求会变化；请在出行前打开来源页核验。",
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

async function fetchProviderJson(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
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

async function retrieveProviderSources(provider, input, { fetchImpl, timeoutMs }) {
  const queries = makeSearchQueries(input);
  const successfulSearches = [];
  const failures = [];
  // Free MediaWiki endpoints can reject a burst of same-host requests. Query
  // one term at a time and stop once we have enough distinct candidates. This
  // is slower only when the destination has sparse material, but much more
  // reliable than losing all but the first query to a rate limit.
  for (const query of queries) {
    try {
      successfulSearches.push({
        body: await fetchProviderJson(makeSearchUrl(provider, input, query), { fetchImpl, timeoutMs }),
        query,
        provider,
        input,
      });
      if (collectProviderCandidates(successfulSearches).length >= input.maxResults) break;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!successfulSearches.length) {
    throw failures[0]
      || new FreePublicSourceError("public_source_request_failed", "公开资料查询未成功，请稍后再试。", 502);
  }

  const candidates = collectProviderCandidates(successfulSearches);
  if (!candidates.length) return [];
  const toEnrich = candidates
    .filter((candidate) => candidate.pageId)
    .slice(0, Math.min(input.maxResults, MAX_ENRICHED_PAGES_PER_PROVIDER));
  const enrichments = await Promise.allSettled(toEnrich.map(async (candidate) => ({
    candidate,
    body: await fetchProviderJson(makeExtractUrl(provider, candidate), { fetchImpl, timeoutMs }),
  })));
  const enrichedByUri = new Map();
  for (const result of enrichments) {
    if (result.status !== "fulfilled") continue;
    const { candidate, body } = result.value;
    enrichedByUri.set(candidate.source.uri, enrichCandidate(candidate, detailPageFor(body, candidate.pageId), provider));
  }
  return candidates.map((candidate) => enrichedByUri.get(candidate.source.uri) || candidate.source);
}

function mergeProviderSources(providerSources, maxResults) {
  const sourceMap = new Map();
  for (let index = 0; sourceMap.size < maxResults; index += 1) {
    let foundNext = false;
    for (const sources of providerSources) {
      const source = sources[index];
      if (!source) continue;
      foundNext = true;
      const identity = sourceIdentity(source);
      if (!identity || sourceMap.has(identity)) continue;
      sourceMap.set(identity, source);
      if (sourceMap.size >= maxResults) break;
    }
    if (!foundNext) break;
  }
  return [...sourceMap.values()];
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
      "仅会发送目的地和固定映射后的旅行偏好；不会发送备注、预算或个人信息。",
    ],
  };
}

export function makeTravelSearchInput(payload, config = freePublicSourceConfig()) {
  const destination = cleanText(payload?.destination, MAX_DESTINATION_LENGTH);
  if (!destination) {
    throw new FreePublicSourceError("invalid_destination", "destination 必须是 1 到 80 个字符。", 422);
  }
  const selectedInterests = normaliseInterests(payload?.interests);
  const requestedLimit = Number(payload?.requested_limit);
  const maxResults = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, config.maxResults))
    : config.maxResults;
  return {
    destination,
    interests: selectedInterests,
    queryTerms: selectedInterests.map((interest) => interest.query),
    maxResults,
  };
}

/**
 * Search two free, read-only Chinese Wikimedia endpoints. Search requests
 * contain only a validated destination and controlled interest terms. Exact
 * page ids returned by those searches are then queried through the same API
 * for a bounded plaintext extract; no commercial page is crawled.
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

  const providerSettled = await Promise.allSettled(PUBLIC_SOURCES.map((provider) => (
    retrieveProviderSources(provider, input, { fetchImpl, timeoutMs: config.timeoutMs })
  )));
  const providerSources = providerSettled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const failures = providerSettled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  const sources = mergeProviderSources(providerSources, input.maxResults);
  if (!sources.length && failures.length === PUBLIC_SOURCES.length) {
    throw failures[0];
  }

  const result = {
    mode: "free_public_sources",
    provider: "中文维基导游 / 中文维基百科",
    status: sources.length ? "public_sources" : "no_results",
    destination: input.destination,
    search_interests: input.interests.map((interest) => interest.label),
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
