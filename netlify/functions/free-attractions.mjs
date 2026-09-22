import {
  jsonResponse,
  methodGuard,
  readFreePublicAttractionQuery,
} from "../serverless-api-core.mjs";
import {
  freePublicSourceErrorPayload,
  retrieveFreePublicTravelSources,
} from "../free-public-sources-core.mjs";

/**
 * Query-only route: it never accepts notes or personal information. Netlify
 * may cache this GET response briefly to reduce repeated requests to the
 * free public sources.
 */
export default async function freeAttractions(request) {
  const guard = methodGuard(request, ["GET"]);
  if (guard) return guard;
  try {
    const payload = readFreePublicAttractionQuery(new URL(request.url));
    if (payload instanceof Response) return payload;
    const retrieval = await retrieveFreePublicTravelSources({
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
      free_public_source: true,
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
      "netlify-cdn-cache-control": "public, durable, max-age=300, stale-while-revalidate=300",
    });
  } catch (error) {
    const handled = freePublicSourceErrorPayload(error);
    return jsonResponse(handled.body, handled.status);
  }
}

export const config = {
  path: "/api/v3/free-attractions",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
