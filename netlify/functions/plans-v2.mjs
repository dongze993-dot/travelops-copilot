import {
  createNetlifyPlan,
  internalError,
  jsonResponse,
  readPublicPlanPayload,
} from "../serverless-api-core.mjs";

export default async function planV2(request) {
  try {
    const payload = await readPublicPlanPayload(request);
    return payload instanceof Response
      ? payload
      : jsonResponse(createNetlifyPlan(payload, { modelAssisted: true }));
  } catch {
    return internalError();
  }
}

export const config = { path: "/api/v2/plans" };
