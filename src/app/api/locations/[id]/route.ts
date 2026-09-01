import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateLocationInput } from "@/lib/locations/validate";

// Internal tool, no auth yet — see ../route.ts.
export const dynamic = "force-dynamic";

const COLUMNS =
  "id, code, arp2_code, name, type, address, locality, time_window, latitude, longitude, radius_meters, updated_at";

const UNIQUE_VIOLATION = "23505";

// PATCH /api/locations/[id] — update an existing location. The form always
// sends the full record, so the whole payload is validated and written.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const parsed = validateLocationInput(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.errors[0].message, errors: parsed.errors },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("locations")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        {
          error: `Já existe uma location com o código «${parsed.value.code}».`,
          errors: [{ field: "code", message: "Código já existente." }],
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `Falha ao gravar: ${error.message}` },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Location não encontrada." },
      { status: 404 },
    );
  }

  return NextResponse.json({ location: data });
}
