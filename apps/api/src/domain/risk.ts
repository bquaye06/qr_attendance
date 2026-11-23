/**
 * Deterministic risk scoring for a check-in attempt.
 *
 * The score is 0–100 and the weights are fixed, documented constants so two
 * runs on the same inputs never disagree, and so an admin's threshold change is
 * the only moving part. Above `riskFlagThreshold` the record is stored as
 * `present_flagged` and routed to the review queue instead of being rejected.
 */

export interface RiskFactor {
  code: string;
  label: string;
  points: number;
}

export interface GeofenceRiskInput {
  enabled: boolean;
  inside: boolean;
  distanceM: number | null;
  radiusM: number;
}

export interface RiskInput {
  /** Passive + active liveness, 0–1. */
  livenessScore: number;
  /** Similarity to the student's own template, 0–1. */
  similarity: number;
  /** Configured acceptance threshold. */
  similarityThreshold: number;
  /** Similarity to the closest *other* template in this session, 0–1. */
  similarityMarginToOthers: number;
  geofence: GeofenceRiskInput | null;
  fingerprintMatched: boolean;
  /** Hours since the device was bound; a just-bound device is weaker evidence. */
  deviceAgeHours: number | null;
  /** Seconds between QR issue and claim. */
  tokenAgeSeconds: number;
  recentFailures: number;
  requireActiveLiveness: boolean;
  activeChallengePassed: boolean | null;
}

export interface RiskResult {
  score: number;
  factors: RiskFactor[];
}

const WEIGHTS = {
  liveness: 25,
  thinMargin: 25,
  ambiguity: 20,
  geofence: 10,
  fingerprint: 30,
  freshDevice: 10,
  tokenAge: 10,
  recentFailures: 10,
  activeLiveness: 15,
} as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function computeRiskScore(input: RiskInput): RiskResult {
  const factors: RiskFactor[] = [];
  const add = (code: string, label: string, points: number): void => {
    const rounded = Math.round(points * 10) / 10;
    if (rounded >= 0.5) factors.push({ code, label, points: rounded });
  };

  add('liveness_low', 'Low liveness confidence', (1 - clamp01(input.livenessScore)) * WEIGHTS.liveness);

  const margin = input.similarity - input.similarityThreshold;
  if (margin < 0.1) {
    add(
      'thin_similarity_margin',
      'Face matched only just above threshold',
      ((0.1 - Math.max(0, margin)) / 0.1) * WEIGHTS.thinMargin,
    );
  }

  if (input.similarityMarginToOthers < 0.3) {
    add(
      'face_ambiguity',
      'Face is also close to another enrolled student',
      ((0.3 - clamp01(input.similarityMarginToOthers)) / 0.3) * WEIGHTS.ambiguity,
    );
  }

  if (input.geofence?.enabled) {
    if (!input.geofence.inside) {
      add('geofence_outside', 'Outside the room geofence', WEIGHTS.geofence * 3);
    } else if (input.geofence.distanceM !== null && input.geofence.radiusM > 0) {
      const ratio = input.geofence.distanceM / input.geofence.radiusM;
      if (ratio > 0.85) {
        add('geofence_edge', 'Near the edge of the room geofence', ((ratio - 0.85) / 0.15) * WEIGHTS.geofence);
      }
    }
  }

  if (!input.fingerprintMatched) {
    add('fingerprint_mismatch', 'Device fingerprint does not match the bound device', WEIGHTS.fingerprint);
  }

  if (input.deviceAgeHours !== null && input.deviceAgeHours < 24) {
    add('fresh_device', 'Device was bound less than a day ago', WEIGHTS.freshDevice * (1 - input.deviceAgeHours / 24));
  }

  if (input.tokenAgeSeconds > 5) {
    add(
      'stale_token',
      'QR token was older than 5 seconds when claimed',
      Math.min(WEIGHTS.tokenAge, ((input.tokenAgeSeconds - 5) / 10) * WEIGHTS.tokenAge),
    );
  }

  if (input.recentFailures > 0) {
    add('recent_failures', 'Earlier failed attempts on this device', Math.min(WEIGHTS.recentFailures, input.recentFailures * 4));
  }

  if (input.requireActiveLiveness && input.activeChallengePassed === false) {
    add('active_challenge_failed', 'Active liveness challenge not satisfied', WEIGHTS.activeLiveness);
  }

  const total = factors.reduce((sum, factor) => sum + factor.points, 0);
  return { score: Math.min(100, Math.round(total)), factors: factors.sort((a, b) => b.points - a.points) };
}
