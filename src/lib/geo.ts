export type GeoPoint = { id: string; latitude: number; longitude: number };

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Distance below which a travel's start/end point is considered "at" a location.
export const LOCATION_MATCH_RADIUS_METERS = 300;

export function findNearestLocationId(
  lat: number | null | undefined,
  lng: number | null | undefined,
  candidates: GeoPoint[],
  maxMeters = LOCATION_MATCH_RADIUS_METERS,
): string | null {
  if (lat == null || lng == null) return null;

  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = haversineMeters(lat, lng, candidate.latitude, candidate.longitude);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = candidate.id;
    }
  }

  return bestDist <= maxMeters ? bestId : null;
}
