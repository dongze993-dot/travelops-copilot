import {
  internalError,
  jsonResponse,
  methodGuard,
  searchPublicAttractions,
} from "../serverless-api-core.mjs";

export default async function attractions(request) {
  const guard = methodGuard(request, ["GET"]);
  if (guard) return guard;
  try {
    const result = searchPublicAttractions(new URL(request.url));
    return result instanceof Response ? result : jsonResponse(result);
  } catch {
    return internalError();
  }
}

export const config = { path: "/api/v1/attractions" };
