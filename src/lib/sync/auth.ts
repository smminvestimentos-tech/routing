import "server-only";
import type { NextRequest } from "next/server";

// Shared bearer-token check for the /api/sync/* endpoints. A request is
// authorized if its `Authorization: Bearer <token>` matches either:
//   - SYNC_SECRET           — used by the GitHub Actions workflows
//   - CRON_EXTERNAL_SECRET   — used by the external scheduler (cron-job.org)
// If neither env var is set the endpoints are open (local dev only).
export function isSyncAuthorized(request: NextRequest): boolean {
  const accepted = [
    process.env.SYNC_SECRET,
    process.env.CRON_EXTERNAL_SECRET,
  ].filter((s): s is string => !!s);

  if (accepted.length === 0) return true;

  const header = request.headers.get("authorization");
  return accepted.some((secret) => header === `Bearer ${secret}`);
}
