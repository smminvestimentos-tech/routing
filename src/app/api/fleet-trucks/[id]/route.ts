import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateFleetTruckInput } from "@/lib/fleet/validate";

// Internal tool, no auth yet — see ../route.ts.
export const dynamic = "force-dynamic";

const COLUMNS = "id, truck_number, plate, updated_at";

const UNIQUE_VIOLATION = "23505";

// PATCH /api/fleet-trucks/[id] — update an existing truck. The form always
// sends the full record.
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

  const parsed = validateFleetTruckInput(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.errors[0].message, errors: parsed.errors },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("fleet_trucks")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        {
          error: `Já existe um camião com o nº «${parsed.value.truck_number}».`,
          errors: [
            { field: "truck_number", message: "Nº de camião já existente." },
          ],
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
      { error: "Camião não encontrado." },
      { status: 404 },
    );
  }

  return NextResponse.json({ truck: data });
}
