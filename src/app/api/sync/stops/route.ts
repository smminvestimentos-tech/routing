import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// detect_stops() is a single set-returning PL/pgSQL call: it walks each
// vehicle's pings from where that vehicle's last stop left off, so the work
// per run is bounded by "pings since last run", not full history. Still,
// give it the full budget — the vehicle count is unbounded.
export const maxDuration = 300;

const TRACKIT_ACCOUNT = "default";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.SYNC_SECRET;
  if (!secret) return true; // no secret configured: open (local dev only)
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

type DetectStopsRow = {
  vehicle_id: number;
  stops_upserted: number;
  still_open: boolean;
};

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("detect_stops", {
    p_trackit_account: TRACKIT_ACCOUNT,
  });

  if (error) {
    return NextResponse.json(
      { error: `detect_stops failed: ${error.message}` },
      { status: 500 },
    );
  }

  const rows = (data ?? []) as DetectStopsRow[];

  return NextResponse.json({
    trackitAccount: TRACKIT_ACCOUNT,
    vehiclesProcessed: rows.length,
    stopsUpsertedTotal: rows.reduce((sum, r) => sum + r.stops_upserted, 0),
    vehiclesStillOpen: rows.filter((r) => r.still_open).length,
    perVehicle: rows,
  });
}
