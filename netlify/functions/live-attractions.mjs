import {
  jsonResponse,
  methodGuard,
  readLiveAttractionQuery,
} from "../serverless-api-core.mjs";
import {
  liveRetrievalErrorPayload,
  retrieveLiveTravelSources,
} from "../live-retrieval-core.mjs";

/**
 * GET is intentionally query-only: it can receive CDN caching without storing
 * free-text notes or a request body. The provider key remains server-only.
 */
export default async function liveAttractions(request) {
  const guard = methodGuard(request, ["GET"]);
  if (guard) return guard;
  try {
    const payload = readLiveAttractionQuery(new URL(request.url));
    if (payload instanceof Response) return payload;
    const retrieval = await retrieveLiveTravelSources({
      destination: payload.destination,
      interests: payload.interests,
      requested_limit: payload.requested_limit,
    });
    const items = retrieval.sources.map((source) => ({
      id: source.source_id,
      name: source.title,
      summary: source.excerpt,
      source_url: source.uri,
      source_title: source.title,
      price_cny: null,
      query_destination: retrieval.destination,
      live_web: true,
    }));
    return jsonResponse({
      destination: retrieval.destination,
      items,
      citations: retrieval.sources,
      retrieval: {
        mode: retrieval.mode,
        provider: retrieval.provider,
        status: retrieval.status,
        retrieved_at: retrieval.retrieved_at,
        cache_age_seconds: retrieval.cache_age_seconds,
        source_count: retrieval.source_count,
        notices: retrieval.notices,
      },
    }, 200, {
      // Netlify's durable CDN cache applies only to this idempotent, query-only
      // endpoint; the POST planner remains no-store.
      "netlify-cdn-cache-control": "public, durable, max-age=300, stale-while-revalidate=300",
    });
  } catch (error) {
    const handled = liveRetrievalErrorPayload(error);
    return jsonResponse(handled.body, handled.status);
  }
}

export const config = {
  path: "/api/v3/live-attractions",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
