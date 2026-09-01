// Shared validation for the `locations` master table. Pure, no framework
// imports — used by the /api/locations route handlers on the server and
// mirrored by the /dashboard/locations form on the client.

export const LOCATION_TYPES = [
  "loja",
  "armazem",
  "centro_distribuicao",
  "fornecedor",
  "oficina",
] as const;

export type LocationType = (typeof LOCATION_TYPES)[number];

// Plausible bounds for mainland Portugal (see the request). Coordinates
// outside this box are almost certainly a data-entry mistake.
export const PT_LAT = { min: 36, max: 42 } as const;
export const PT_LNG = { min: -9.5, max: -6 } as const;

// Guard rail — a stop-detection radius in the km range is a typo, not intent.
export const RADIUS_MIN = 1;
export const RADIUS_MAX = 100_000;

export type LocationInput = {
  code: string;
  arp2_code: string | null;
  name: string | null;
  type: LocationType | null;
  address: string | null;
  locality: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
};

export type FieldError = { field: string; message: string };

export type ValidationResult =
  | { ok: true; value: LocationInput }
  | { ok: false; errors: FieldError[] };

function asTrimmedOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Accepts a number, or a numeric string ("38,72" included), or null/empty.
// Returns `undefined` when the value is present but not a number.
function asNumberOrNull(v: unknown): number | null | undefined {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

export function validateLocationInput(raw: unknown): ValidationResult {
  const errors: FieldError[] = [];
  const body = (raw ?? {}) as Record<string, unknown>;

  // code — required, non-empty
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (code === "") {
    errors.push({ field: "code", message: "O código é obrigatório." });
  }

  // type — optional, but if set must be one of the five valid values
  let type: LocationType | null = null;
  const rawType = asTrimmedOrNull(body.type);
  if (rawType !== null) {
    if ((LOCATION_TYPES as readonly string[]).includes(rawType)) {
      type = rawType as LocationType;
    } else {
      errors.push({
        field: "type",
        message: `Tipo inválido. Usa um de: ${LOCATION_TYPES.join(", ")}.`,
      });
    }
  }

  // latitude / longitude — optional, numeric, within Portugal bounds
  const latitude = asNumberOrNull(body.latitude);
  if (latitude === undefined) {
    errors.push({ field: "latitude", message: "Latitude tem de ser numérica." });
  } else if (
    latitude !== null &&
    (latitude < PT_LAT.min || latitude > PT_LAT.max)
  ) {
    errors.push({
      field: "latitude",
      message: `Latitude fora dos limites de Portugal (${PT_LAT.min} a ${PT_LAT.max}).`,
    });
  }

  const longitude = asNumberOrNull(body.longitude);
  if (longitude === undefined) {
    errors.push({
      field: "longitude",
      message: "Longitude tem de ser numérica.",
    });
  } else if (
    longitude !== null &&
    (longitude < PT_LNG.min || longitude > PT_LNG.max)
  ) {
    errors.push({
      field: "longitude",
      message: `Longitude fora dos limites de Portugal (${PT_LNG.min} a ${PT_LNG.max}).`,
    });
  }

  // radius_meters — optional; NOT NULL default 150 in the schema
  let radius_meters = 150;
  const rawRadius = asNumberOrNull(body.radius_meters);
  if (rawRadius === undefined || (rawRadius !== null && !Number.isInteger(rawRadius))) {
    errors.push({
      field: "radius_meters",
      message: "O raio tem de ser um número inteiro.",
    });
  } else if (rawRadius !== null) {
    radius_meters = rawRadius;
    if (radius_meters < RADIUS_MIN || radius_meters > RADIUS_MAX) {
      errors.push({
        field: "radius_meters",
        message: `O raio tem de estar entre ${RADIUS_MIN} e ${RADIUS_MAX} metros.`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      code,
      arp2_code: asTrimmedOrNull(body.arp2_code),
      name: asTrimmedOrNull(body.name),
      type,
      address: asTrimmedOrNull(body.address),
      locality: asTrimmedOrNull(body.locality),
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      radius_meters,
    },
  };
}
