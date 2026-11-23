import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  FaceServiceHealth,
  FaceServiceResponse,
} from '@attend/contracts';
import type { LivenessChallenge } from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';

/**
 * Client for the Python face service.
 *
 * The browser never talks to this service and the service never sees the
 * database. Requests carry a short-lived HMAC service token so that a leak of
 * the private network alone is not enough to call it.
 */
export interface FaceServiceOptions {
  url: string;
  secret: string;
  timeoutMs: number;
}

export function serviceToken(secret: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1000).toString();
  const signature = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `t=${timestamp}.${signature}`;
}

export function verifyServiceToken(secret: string, header: string, nowMs = Date.now(), skewSeconds = 60): boolean {
  const match = /^t=(\d+)\.([0-9a-f]{64})$/u.exec(header);
  if (!match) return false;
  const [, timestamp, signature] = match as unknown as [string, string, string];
  const issuedAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(issuedAt) || Math.abs(Math.floor(nowMs / 1000) - issuedAt) > skewSeconds) return false;
  const expected = createHmac('sha256', secret).update(timestamp).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class FaceService {
  constructor(private readonly options: FaceServiceOptions) {}

  async enroll(frames: string[], challenge: LivenessChallenge): Promise<FaceServiceResponse> {
    return this.call('/v1/enroll', frames, challenge);
  }

  async verify(frames: string[], challenge: LivenessChallenge): Promise<FaceServiceResponse> {
    return this.call('/v1/verify', frames, challenge);
  }

  private async call(
    path: string,
    frames: string[],
    challenge: LivenessChallenge,
  ): Promise<FaceServiceResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': serviceToken(this.options.secret, Date.now()),
        },
        body: JSON.stringify({ frames, challenge }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ApiError(
          'FACE_SERVICE_UNAVAILABLE',
          `face service responded ${response.status}: ${detail.slice(0, 200)}`,
        );
      }
      return FaceServiceResponse.parse(await response.json());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A dead face service must never read as a face mismatch: the manual
      // fallback path depends on the error being distinguishable.
      throw new ApiError('FACE_SERVICE_UNAVAILABLE', 'The face service is unavailable. Use the manual check-in path.');
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<FaceServiceHealth | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(2000, this.options.timeoutMs));
    try {
      const response = await fetch(`${this.options.url}/readyz`, { signal: controller.signal });
      if (!response.ok) return null;
      return FaceServiceHealth.parse(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
