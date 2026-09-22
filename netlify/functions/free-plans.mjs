import {
  jsonResponse,
  readFreePublicPlanPayload,
} from "../serverless-api-core.mjs";
import {
  freePublicSourceErrorPayload,
  retrieveFreePublicTravelSources,
} from "../free-public-sources-core.mjs";
import { buildFreePublicSourcePlan } from "../free-public-plan-core.mjs";

export default async function freePlan(request) {
  try {
    const payload = await readFreePublicPlanPayload(request);
    if (payload instanceof Response) return payload;
    const retrieval = await retrieveFreePublicTravelSources(payload);
    return jsonResponse(buildFreePublicSourcePlan(payload, retrieval));
  } catch (error) {
    const handled = freePublicSourceErrorPayload(error);
    return jsonResponse(handled.body, handled.status);
  }
}

export const config = {
  path: "/api/v3/free-plans",
  rateLimit: {
    windowLimit: 3,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
