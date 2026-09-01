import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARGIN_MIN, MARGIN_MAX, UUID_RE, parseMargin } from "@/lib/margins";

// Internal tool, no auth yet — same stance as the /dashboard pages that call
// this. Writes go through createAdminClient() (service role).
export const dynamic = "force-dynamic";

// PATCH /api/route-margins — upsert the margin override for one (origin,
// destination) pair.
export async function PATCH(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }
  const b = (raw ?? {}) as Record<string, unknown>;

  const origin =
    typeof b.origin_location_id === "string" ? b.origin_location_id : "";
  const dest =
    typeof b.destination_location_id === "string"
      ? b.destination_location_id
      : "";
  if (!UUID_RE.test(origin) || !UUID_RE.test(dest)) {
    return NextResponse.json(
      { error: "origin_location_id / destination_location_id inválidos." },
      { status: 422 },
    );
  }
  if (origin === dest) {
    return NextResponse.json(
      { error: "Origem e destino têm de ser diferentes." },
      { status: 422 },
    );
  }

  const margin = parseMargin(b.margin_percent);
  if (margin == null) {
    return NextResponse.json(
      {
        error: `margin_percent tem de ser um número entre ${MARGIN_MIN} e ${MARGIN_MAX}.`,
      },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("route_margins")
    .upsert(
      {
        origin_location_id: origin,
        destination_location_id: dest,
        margin_percent: margin,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "origin_location_id,destination_location_id" },
    )
    .select("origin_location_id, destination_location_id, margin_percent")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Falha ao gravar: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ margin: data });
}
