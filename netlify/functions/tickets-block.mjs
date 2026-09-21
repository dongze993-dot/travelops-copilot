import { methodGuard, publicDemoBlocked } from "../serverless-api-core.mjs";

export default async function ticketsBlock(request) {
  const guard = methodGuard(request, ["GET", "POST"]);
  return guard || publicDemoBlocked();
}

export const config = {
  path: [
    "/api/v1/tickets",
    "/api/v1/tickets/*",
    "/api/tickets",
    "/api/tickets/*",
  ],
};
