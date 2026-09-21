import {
  jsonResponse,
  readLivePlanPayload,
} from "../serverless-api-core.mjs";
import {
  liveRetrievalErrorPayload,
  retrieveLiveTravelSources,
} from "../live-retrieval-core.mjs";
import { buildLiveWebPlan } from "../live-plan-core.mjs";

export default async function livePlan(request) {
  try {
    const payload = await readLivePlanPayload(request);
    if (payload instanceof Response) return payload;
    const retrieval = await retrieveLiveTravelSources(payload);
    return jsonResponse(buildLiveWebPlan(payload, retrieval));
  } catch (error) {
    const handled = liveRetrievalErrorPayload(error);
    return jsonResponse(handled.body, handled.status);
  }
}

export const config = {
  path: "/api/v3/live-plans",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
