/** Geofence maths. Pure functions so the rule can be tested without a database. */

export interface Coordinate {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres (haversine). */
export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GeofenceRoom {
  latitude: number | null;
  longitude: number | null;
  geofenceM: number;
}

export interface GeofenceResult {
  /** True when the point is inside the allowed radius. */
  inside: boolean;
  distanceM: number | null;
  /** True when the room has no coordinates, so the rule cannot apply. */
  skipped: boolean;
}

export function evaluateGeofence(
  room: GeofenceRoom,
  point: Coordinate | null | undefined,
  overrideRadiusM?: number,
): GeofenceResult {
  if (room.latitude === null || room.longitude === null) {
    return { inside: true, distanceM: null, skipped: true };
  }
  if (!point) {
    return { inside: false, distanceM: null, skipped: false };
  }
  const radius = overrideRadiusM ?? room.geofenceM;
  const distance = haversineMeters(
    { lat: room.latitude, lng: room.longitude },
    { lat: point.lat, lng: point.lng },
  );
  return { inside: distance <= radius, distanceM: Math.round(distance), skipped: false };
}

/** Supports IPv4 literal and IPv4 CIDR entries; anything unparsable never matches. */
export function ipMatchesAllowlist(ip: string, allowlist: readonly string[]): boolean {
  const candidates = allowlist.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (candidates.length === 0) return true;
  const target = ipv4ToInt(ip);
  if (target === null) return false;
  return candidates.some((entry) => {
    if (!entry.includes('/')) {
      const single = ipv4ToInt(entry);
      return single !== null && single === target;
    }
    const [network, bitsRaw] = entry.split('/') as [string, string];
    const networkInt = ipv4ToInt(network);
    const bits = Number.parseInt(bitsRaw, 10);
    if (networkInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (networkInt & mask);
  });
}

function ipv4ToInt(ip: string): number | null {
  const normalised = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const parts = normalised.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    result = result * 256 + value;
  }
  return result >>> 0;
}
