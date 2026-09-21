import {
  createNetlifyPlan,
  internalError,
  jsonResponse,
  readPublicPlanPayload,
} from "../serverless-api-core.mjs";

export default async function planV1(request) {
  try {
    const payload = await readPublicPlanPayload(request);
    return payload instanceof Response ? payload : jsonResponse(createNetlifyPlan(payload));
  } catch {
    return internalError();
  }
}

export const config = { path: ["/api/v1/plans", "/api/plan"] };
