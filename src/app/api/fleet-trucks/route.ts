import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateFleetTruckInput } from "@/lib/fleet/validate";

// Internal tool, no auth yet — same stance as /api/locations. Writes go through
// createAdminClient() (service role). No DELETE for now (see the request).
export const dynamic = "force-dynamic";

const COLUMNS = "id, truck_number, plate, updated_at";

// Postgres unique_violation — here it can only be the `truck_number` unique index.
const UNIQUE_VIOLATION = "23505";

// POST /api/fleet-trucks — create a new truck.
export async function POST(request: NextRequest) {
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
    .insert(parsed.value)
    .select(COLUMNS)
    .single();

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
      { error: `Falha ao criar: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ truck: data }, { status: 201 });
}
