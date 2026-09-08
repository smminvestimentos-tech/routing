// Shared validation for the `fleet_trucks` reference table. Pure, no framework
// imports — used by the /api/fleet-trucks route handlers and mirrored by the
// /dashboard/camioes form. Same pattern as lib/locations/validate.ts, but there
// are only two fields.

export type FleetTruckInput = {
  truck_number: string;
  plate: string | null;
};

export type FieldError = { field: string; message: string };

export type ValidationResult =
  | { ok: true; value: FleetTruckInput }
  | { ok: false; errors: FieldError[] };

// Uppercased, everything that isn't a letter or digit stripped — the same shape
// the TFS-sheet matcher normalises plates to, so what you type here compares
// cleanly against vehicle_pings.plate (which carries hyphens).
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function validateFleetTruckInput(raw: unknown): ValidationResult {
  const errors: FieldError[] = [];
  const body = (raw ?? {}) as Record<string, unknown>;

  const truck_number =
    typeof body.truck_number === "string" ? body.truck_number.trim() : "";
  if (truck_number === "") {
    errors.push({
      field: "truck_number",
      message: "O nº do camião é obrigatório.",
    });
  } else if (truck_number.length > 40) {
    errors.push({ field: "truck_number", message: "Máximo 40 caracteres." });
  }

  const rawPlate = body.plate == null ? "" : String(body.plate).trim();
  const plate = rawPlate === "" ? null : rawPlate.toUpperCase();
  if (plate !== null && plate.length > 20) {
    errors.push({ field: "plate", message: "Máximo 20 caracteres." });
  }
  if (plate !== null && normalizePlate(plate) === "") {
    errors.push({
      field: "plate",
      message: "Matrícula sem letras nem números.",
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { truck_number, plate } };
}
