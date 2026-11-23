import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGeofence, haversineMeters, ipMatchesAllowlist } from './geo.ts';
import { computeRiskScore } from './risk.ts';

describe('geofence', () => {
  const room = { latitude: 5.6505, longitude: -0.187, geofenceM: 100 };

  it('measures a known distance within a metre', () => {
    // University of Ghana, Legon → Accra centre is about 9.6 km.
    const distance = haversineMeters({ lat: 5.6505, lng: -0.187 }, { lat: 5.556, lng: -0.1969 });
    assert.ok(distance > 10_400 && distance < 10_600, `got ${distance}`);
  });

  it('accepts a point inside the radius and rejects one outside', () => {
    const inside = evaluateGeofence(room, { lat: 5.6509, lng: -0.187 });
    assert.equal(inside.inside, true);
    assert.ok(inside.distanceM !== null && inside.distanceM < 100);

    const outside = evaluateGeofence(room, { lat: 5.6525, lng: -0.187 });
    assert.equal(outside.inside, false);
    assert.ok(outside.distanceM !== null && outside.distanceM > 100);
  });

  it('skips the rule when the room has no coordinates', () => {
    const result = evaluateGeofence({ latitude: null, longitude: null, geofenceM: 100 }, null);
    assert.equal(result.skipped, true);
    assert.equal(result.inside, true, 'a room without coordinates must not block check-in');
  });

  it('rejects a missing location when the room does have coordinates', () => {
    const result = evaluateGeofence(room, null);
    assert.equal(result.inside, false);
    assert.equal(result.skipped, false);
  });

  it('lets a session override the room radius', () => {
    const point = { lat: 5.6515, lng: -0.187 }; // ~110 m away
    assert.equal(evaluateGeofence(room, point).inside, false);
    assert.equal(evaluateGeofence(room, point, 200).inside, true);
  });

  it('matches IPv4 addresses and CIDR blocks', () => {
    assert.equal(ipMatchesAllowlist('10.0.0.5', []), true, 'empty allowlist means no restriction');
    assert.equal(ipMatchesAllowlist('10.0.0.5', ['10.0.0.5']), true);
    assert.equal(ipMatchesAllowlist('10.0.0.6', ['10.0.0.5']), false);
    assert.equal(ipMatchesAllowlist('192.168.4.20', ['192.168.4.0/24']), true);
    assert.equal(ipMatchesAllowlist('192.168.5.20', ['192.168.4.0/24']), false);
    assert.equal(ipMatchesAllowlist('::ffff:10.1.2.3', ['10.1.2.0/24']), true);
    assert.equal(ipMatchesAllowlist('not-an-ip', ['10.0.0.0/8']), false);
  });

  it('treats a /0 block as matching everything', () => {
    assert.equal(ipMatchesAllowlist('8.8.8.8', ['0.0.0.0/0']), true);
  });
});

describe('risk scoring', () => {
  it('scores a clean in-window check-in at zero', () => {
    const result = computeRiskScore({
      livenessScore: 0.99,
      similarity: 0.85,
      similarityThreshold: 0.45,
      similarityMarginToOthers: 0.6,
      geofence: { enabled: true, inside: true, distanceM: 5, radiusM: 100 },
      fingerprintMatched: true,
      deviceAgeHours: 1000,
      tokenAgeSeconds: 2,
      recentFailures: 0,
      requireActiveLiveness: true,
      activeChallengePassed: true,
    });
    assert.equal(result.score, 0);
    assert.deepEqual(result.factors, []);
  });

  it('accumulates points for several weak signals without reaching the review threshold', () => {
    // Every signal is mediocre but none is damning: this must NOT flag.
    const result = computeRiskScore({
      livenessScore: 0.82,
      similarity: 0.47,
      similarityThreshold: 0.45,
      similarityMarginToOthers: 0.12,
      geofence: { enabled: true, inside: true, distanceM: 92, radiusM: 100 },
      fingerprintMatched: true,
      deviceAgeHours: 3,
      tokenAgeSeconds: 14,
      recentFailures: 2,
      requireActiveLiveness: true,
      activeChallengePassed: true,
    });
    assert.ok(result.score >= 60 && result.score < 70, `expected 60–69, got ${result.score}`);
    assert.ok(result.factors.length >= 3);
    assert.ok(result.factors.some((factor) => factor.code === 'thin_similarity_margin'));
    assert.ok(result.factors.some((factor) => factor.code === 'recent_failures'));
  });

  it('crosses the default review threshold when the active challenge also fails', () => {
    const result = computeRiskScore({
      livenessScore: 0.82,
      similarity: 0.47,
      similarityThreshold: 0.45,
      similarityMarginToOthers: 0.12,
      geofence: { enabled: true, inside: true, distanceM: 92, radiusM: 100 },
      fingerprintMatched: true,
      deviceAgeHours: 3,
      tokenAgeSeconds: 14,
      recentFailures: 2,
      requireActiveLiveness: true,
      activeChallengePassed: false,
    });
    assert.ok(result.score >= 70, `expected at least 70, got ${result.score}`);
    assert.ok(result.factors.some((factor) => factor.code === 'active_challenge_failed'));
  });

  it('weighs a mismatched fingerprint heavily', () => {
    const result = computeRiskScore({
      livenessScore: 1,
      similarity: 0.9,
      similarityThreshold: 0.45,
      similarityMarginToOthers: 0.9,
      geofence: null,
      fingerprintMatched: false,
      deviceAgeHours: null,
      tokenAgeSeconds: 1,
      recentFailures: 0,
      requireActiveLiveness: false,
      activeChallengePassed: null,
    });
    assert.equal(result.score, 30);
    assert.equal(result.factors[0]?.code, 'fingerprint_mismatch');
  });

  it('never exceeds 100', () => {
    const result = computeRiskScore({
      livenessScore: 0,
      similarity: 0.46,
      similarityThreshold: 0.45,
      similarityMarginToOthers: 0,
      geofence: { enabled: true, inside: true, distanceM: 100, radiusM: 100 },
      fingerprintMatched: false,
      deviceAgeHours: 0,
      tokenAgeSeconds: 60,
      recentFailures: 9,
      requireActiveLiveness: true,
      activeChallengePassed: false,
    });
    assert.equal(result.score, 100);
  });

  it('is deterministic for identical inputs', () => {
    const input = {
      livenessScore: 0.9,
      similarity: 0.7,
      similarityThreshold: 0.45,
      similarityMarginToOthers: 0.25,
      geofence: { enabled: true, inside: true, distanceM: 95, radiusM: 100 },
      fingerprintMatched: true,
      deviceAgeHours: 10,
      tokenAgeSeconds: 8,
      recentFailures: 1,
      requireActiveLiveness: true,
      activeChallengePassed: true,
    };
    assert.deepEqual(computeRiskScore(input), computeRiskScore(input));
  });
});
