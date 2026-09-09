import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSyncAuthorized } from "@/lib/sync/auth";
import { getConfiguredAccounts } from "@/lib/trackit/client";

// detect_stops() is a single set-returning PL/pgSQL call per account: it walks
// each vehicle's pings from where that vehicle's last stop left off, so the
// work per run is bounded by "pings since last run", not full history. Still,
// give it the full budget — the vehicle count (and now the account count) is
// unbounded.
export const maxDuration = 300;

type DetectStopsRow = {
  vehicle_id: number;
  stops_upserted: number;
  still_open: boolean;
};

type AccountResult = {
  trackitAccount: string;
  vehiclesProcessed?: number;
  stopsUpsertedTotal?: number;
  vehiclesStillOpen?: number;
  perVehicle?: DetectStopsRow[];
  error?: string;
};

async function detectStopsForAccount(
  accountId: string,
  supabase: ReturnType<typeof createAdminClient>,
): Promise<AccountResult> {
  const { data, error } = await supabase.rpc("detect_stops", {
    p_trackit_account: accountId,
  });

  if (error) {
    return {
      trackitAccount: accountId,
      error: `detect_stops failed: ${error.message}`,
    };
  }

  const rows = (data ?? []) as DetectStopsRow[];
  return {
    trackitAccount: accountId,
    vehiclesProcessed: rows.length,
    stopsUpsertedTotal: rows.reduce((sum, r) => sum + r.stops_upserted, 0),
    vehiclesStillOpen: rows.filter((r) => r.still_open).length,
    perVehicle: rows,
  };
}

export async function POST(request: NextRequest) {
  if (!isSyncAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const accounts = getConfiguredAccounts();
  if (accounts.length === 0) {
    return NextResponse.json(
      { error: "no TRACKiT account configured (set TRACKIT_USER / TRACKIT_PASS)" },
      { status: 500 },
    );
  }

  const supabase = createAdminClient();

  // detect_stops touches only this codebase's own tables (no TRACKiT calls),
  // scoped per trackit_account, so the accounts are independent and run
  // concurrently.
  const accountResults = await Promise.all(
    accounts.map((account) => detectStopsForAccount(account.id, supabase)),
  );

  const allFailed = accountResults.every((r) => r.error);
  return NextResponse.json(
    { accounts: accountResults },
    { status: allFailed ? 500 : 200 },
  );
}
