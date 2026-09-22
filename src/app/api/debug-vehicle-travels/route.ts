import { NextRequest, NextResponse } from "next/server";
import { isSyncAuthorized } from "@/lib/sync/auth";
import { getAccountCredentials, getVehicleTravels } from "@/lib/trackit/http";
import { createAdminClient } from "@/lib/supabase/admin";

// TEMPORARY, one-off debug route — investigating whether the 30m radius on
// locations 7001/7005 (migration 0040) is excluding genuine stops, not just
// the ambiguity it was meant to remove. Auth-gated same as /api/sync/*.
// Deleted once the investigation is done — not meant to stay in production.
export const maxDuration = 60;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(request: NextRequest) {
  if (!isSyncAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("account") ?? "azambuja";
  const vehicleId = Number(searchParams.get("vehicleId"));
  const dateBegin = searchParams.get("dateBegin") ?? "";
  const dateEnd = searchParams.get("dateEnd") ?? "";
  if (!vehicleId || !dateBegin || !dateEnd) {
    return NextResponse.json({ error: "vehicleId, dateBegin, dateEnd required" }, { status: 400 });
  }

  let account;
  try {
    account = getAccountCredentials(accountId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const supabase = createAdminClient();
  const { data: refLocations } = await supabase
    .from("locations")
    .select("code, name, latitude, longitude, radius_meters")
    .in("code", ["7001", "7005"]);

  let travels;
  try {
    travels = await getVehicleTravels(account, vehicleId, dateBegin, dateEnd);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const sorted = [...travels]
    .filter((t: any) => t.ini?.timestampUTC && t.end?.timestampUTC)
    .sort((a: any, b: any) => String(a.ini.timestampUTC).localeCompare(String(b.ini.timestampUTC)));

  const gaps = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur: any = sorted[i];
    const next: any = sorted[i + 1];
    const arr = { lat: cur.end?.lat, lng: cur.end?.lng, ts: cur.end?.timestampUTC };
    const dep = { lat: next.ini?.lat, lng: next.ini?.lng, ts: next.ini?.timestampUTC };
    const distTo = (loc: { latitude: number; longitude: number }) =>
      arr.lat != null && arr.lng != null ? haversineMeters(arr.lat, arr.lng, loc.latitude, loc.longitude) : null;
    const distToRefs = (refLocations ?? []).map((l) => ({
      code: l.code,
      radius_m: l.radius_meters,
      dist_arrival_m: distTo(l),
      dist_departure_m:
        dep.lat != null && dep.lng != null ? haversineMeters(dep.lat, dep.lng, l.latitude, l.longitude) : null,
    }));
    gaps.push({ arrival: arr, departure: dep, distanceToRefLocations: distToRefs });
  }

  return NextResponse.json({
    vehicleId,
    account: accountId,
    dateBegin,
    dateEnd,
    travelsCount: travels.length,
    refLocations,
    gaps,
  });
}
