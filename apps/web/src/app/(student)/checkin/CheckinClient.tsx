'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Input, Label } from '@attend/ui';
import { clientFetch } from '@/lib/api';
import { fingerprintFor, getAssertion } from '@/lib/webauthn';

type Phase = 'scan' | 'claiming' | 'capture' | 'verifying' | 'done' | 'error';

interface ClaimResponse {
  claimId: string;
  expiresAt: string;
  challenge: 'blink' | 'turn_left' | 'turn_right' | 'none';
  session: { courseCode: string; courseTitle: string; roomName: string | null; checkinClosesAt: string };
}

interface VerifyResponse {
  status: string;
  checkedInAt: string;
  courseCode: string;
  message: string;
}

const CHALLENGE_TEXT: Record<ClaimResponse['challenge'], string> = {
  blink: 'Blink twice, slowly, while we capture three photos.',
  turn_left: 'Turn your head slightly to your left, then back.',
  turn_right: 'Turn your head slightly to your right, then back.',
  none: 'Hold still and look at the camera.',
};

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function CheckinClient({ rpId }: { rpId: string }) {
  const [phase, setPhase] = useState<Phase>('scan');
  const [token, setToken] = useState('');
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannedRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // QR scanning uses the platform detector when available; the manual field is
  // the fallback, which also covers desktop testing.
  async function startScanner(): Promise<void> {
    setError(null);
    const detectorCtor = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!detectorCtor) {
      setError('This browser cannot scan QR codes. Type the code shown under the QR, or use the phone camera.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setScanning(true);
      const detector = new detectorCtor({ formats: ['qr_code'] });

      const tick = async (): Promise<void> => {
        if (!streamRef.current || !videoRef.current || scannedRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const value = codes[0]?.rawValue;
          if (value) {
            scannedRef.current = true;
            setToken(value);
            stopCamera();
            return;
          }
        } catch {
          // keep scanning; a single failed frame is normal
        }
        requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch {
      setError('Camera permission was refused. Type the code under the QR instead.');
      setScanning(false);
    }
  }

  async function submitClaim(): Promise<void> {
    setPhase('claiming');
    setError(null);
    try {
      const assertion = await getAssertion(token.trim(), rpId);
      const fingerprint = await fingerprintFor();

      const location = await new Promise<{ lat: number; lng: number; accuracyM: number } | undefined>((resolve) => {
        if (!navigator.geolocation) return resolve(undefined);
        navigator.geolocation.getCurrentPosition(
          (position) =>
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              accuracyM: Math.min(position.coords.accuracy, 5000),
            }),
          () => resolve(undefined),
          { timeout: 4000, maximumAge: 60_000 },
        );
      });

      const response = await clientFetch<ClaimResponse>('/api/v1/checkin/claim', {
        method: 'POST',
        headers: { 'idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({
          token: token.trim(),
          credential: assertion,
          fingerprint,
          ...(location ? { location } : {}),
        }),
      });
      setClaim(response);
      setPhase('capture');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Check-in failed.');
      setPhase('error');
    }
  }

  async function captureAndVerify(): Promise<void> {
    if (!claim) return;
    setPhase('verifying');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const frames: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        setProgress(`Capturing ${index + 1} of 3…`);
        // Give the user time to perform the liveness challenge between frames.
        await new Promise((resolve) => setTimeout(resolve, index === 0 ? 600 : 900));
        frames.push(grabFrame(videoRef.current));
      }
      stopCamera();
      setProgress('Verifying…');

      const response = await clientFetch<VerifyResponse>('/api/v1/checkin/verify', {
        method: 'POST',
        headers: { 'idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({ claimId: claim.claimId, frames }),
      });
      setResult(response);
      setPhase('done');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Verification failed.');
      setPhase('error');
    } finally {
      stopCamera();
      setProgress('');
    }
  }

  if (phase === 'done' && result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Checked in</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-3xl font-semibold">{result.courseCode}</p>
          <p className="text-sm text-slate-600">{result.message}</p>
          <p className="text-xs text-slate-500">{new Date(result.checkedInAt).toLocaleString('en-GB')}</p>
          <Button onClick={() => window.location.assign('/student')}>Back to home</Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="Check-in failed">{error}</Alert> : null}

      {phase === 'scan' || phase === 'claiming' ? (
        <Card>
          <CardHeader>
            <CardTitle>Scan the code on the screen</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="overflow-hidden rounded-lg bg-slate-900">
              <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            </div>
            {!scanning ? (
              <Button className="w-full" onClick={() => void startScanner()}>
                Open camera
              </Button>
            ) : null}
            <div>
              <Label htmlFor="token">Or type the code under the QR</Label>
              <Input
                id="token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="v1.…"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <Button
              className="w-full"
              disabled={phase === 'claiming' || token.trim().length < 10}
              onClick={() => void submitClaim()}
            >
              {phase === 'claiming' ? 'Verifying device…' : 'Continue'}
            </Button>
            <p className="text-xs text-slate-500">
              We check your device and the session window first. Nothing is recorded until the face check passes.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {phase === 'capture' && claim ? (
        <Card>
          <CardHeader>
            <CardTitle>Face check</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-slate-700">{CHALLENGE_TEXT[claim.challenge]}</p>
            <div className="overflow-hidden rounded-lg bg-slate-900">
              <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            </div>
            <Button className="w-full" onClick={() => void captureAndVerify()}>
              Start face check
            </Button>
            <p className="text-xs text-slate-500">
              {claim.session.courseCode} · {claim.session.courseTitle}
              {claim.session.roomName ? ` · ${claim.session.roomName}` : ''}
            </p>
          </CardBody>
        </Card>
      ) : null}

      {phase === 'verifying' ? (
        <Card>
          <CardBody className="space-y-3 text-center">
            <div className="overflow-hidden rounded-lg bg-slate-900">
              <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            </div>
            <p className="text-sm font-medium">{progress || 'Verifying…'}</p>
            <p className="text-xs text-slate-500">Hold still and stay in the frame.</p>
          </CardBody>
        </Card>
      ) : null}

      {phase === 'error' ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-slate-700">
              Something stopped the check-in. You can try again, and your lecturer can mark you present manually if
              your camera keeps failing.
            </p>
            <Button
              onClick={() => {
                setError(null);
                setClaim(null);
                setPhase('scan');
              }}
            >
              Try again
            </Button>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function grabFrame(video: HTMLVideoElement | null): string {
  if (!video || video.videoWidth === 0) throw new Error('The camera is not ready yet.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not capture the frame.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
