import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateLocationInput } from "@/lib/locations/validate";

// Internal tool, no auth yet — same stance as the /dashboard pages that call
// this. Writes go through createAdminClient() (service role), like the sync
// endpoints.
export const dynamic = "force-dynamic";

const COLUMNS =
  "id, code, arp2_code, name, type, address, locality, time_window, latitude, longitude, radius_meters, updated_at";

// Postgres unique_violation — here it can only be the `code` unique index.
const UNIQUE_VIOLATION = "23505";

// POST /api/locations — create a new location.
export async function POST(request: NextRequest) {
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
    .insert(parsed.value)
    .select(COLUMNS)
    .single();

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
      { error: `Falha ao criar: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ location: data }, { status: 201 });
}
