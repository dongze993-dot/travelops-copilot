import { internalError, jsonResponse, methodGuard, recordCount } from "../serverless-api-core.mjs";
import { publicLiveRetrievalStatus } from "../live-retrieval-core.mjs";

export default async function health(request) {
  const guard = methodGuard(request, ["GET"]);
  if (guard) return guard;
  try {
    return jsonResponse({
      status: "ok",
      mode: "deterministic_mock",
      knowledge_records: recordCount(),
      public_demo_mode: true,
      deployment: "netlify_functions",
      model_calls_enabled: false,
      live_retrieval: publicLiveRetrievalStatus(),
    });
  } catch {
    return internalError();
  }
}

export const config = { path: "/health" };
