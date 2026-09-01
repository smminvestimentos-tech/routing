import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARGIN_MIN, MARGIN_MAX, parseMargin } from "@/lib/margins";

// Internal tool, no auth yet — see ../route-margins/route.ts.
export const dynamic = "force-dynamic";

// PATCH /api/dashboard-settings — update the single settings row.
export async function PATCH(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }
  const b = (raw ?? {}) as Record<string, unknown>;

  const margin = parseMargin(b.default_margin_percent);
  if (margin == null) {
    return NextResponse.json(
      {
        error: `default_margin_percent tem de ser um número entre ${MARGIN_MIN} e ${MARGIN_MAX}.`,
      },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("dashboard_settings")
    .upsert(
      {
        id: true,
        default_margin_percent: margin,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("default_margin_percent")
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Falha ao gravar: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ settings: data });
}
