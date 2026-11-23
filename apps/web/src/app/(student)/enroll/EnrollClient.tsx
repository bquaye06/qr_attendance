'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from '@attend/ui';
import { clientFetch } from '@/lib/api';
import { createPasskey, fingerprintFor } from '@/lib/webauthn';
import type { RegistrationOptions } from '@/lib/webauthn';

type Step = 'consent' | 'device' | 'face' | 'done';

const NOTICE_VERSION = '2026-01-v1';

export function EnrollClient({ initial }: { initial: { consent: boolean; deviceBound: boolean; faceEnrolled: boolean } }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(
    !initial.consent ? 'consent' : !initial.deviceBound ? 'device' : !initial.faceEnrolled ? 'face' : 'done',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [accepted, setAccepted] = useState(false);

  async function grantConsent(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientFetch('/api/v1/biometrics/consent', {
        method: 'POST',
        body: JSON.stringify({ noticeVersion: NOTICE_VERSION, granted: true }),
      });
      setStep('device');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record consent.');
    } finally {
      setBusy(false);
    }
  }

  async function bindDevice(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const options = await clientFetch<RegistrationOptions>('/api/v1/devices/register/options', { method: 'POST' });
      const created = await createPasskey(options);
      const fingerprint = await fingerprintFor();
      await clientFetch('/api/v1/devices/register', {
        method: 'POST',
        body: JSON.stringify({ challengeId: created.challengeId, credential: created.credential, fingerprint }),
      });
      setStep('face');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not register this device.');
    } finally {
      setBusy(false);
    }
  }

  async function enrolFace(): Promise<void> {
    setBusy(true);
    setError(null);
    setProgress('Opening camera…');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
      });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      const frames: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        setProgress(
          index === 0 ? 'Look straight ahead' : index === 1 ? 'Turn slightly left' : 'Turn slightly right',
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not capture the frame.');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        frames.push(dataUrl.slice(dataUrl.indexOf(',') + 1));
      }
      stream.getTracks().forEach((track) => track.stop());
      stream = null;

      setProgress('Checking liveness and building your template…');
      await clientFetch('/api/v1/biometrics/enroll', {
        method: 'POST',
        body: JSON.stringify({ frames, challenge: 'blink' }),
      });
      setStep('done');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enrolment failed.');
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setProgress('');
      setBusy(false);
    }
  }

  if (step === 'done') {
    return (
      <Card>
        <CardBody className="space-y-3">
          <p className="text-lg font-semibold">You are set up</p>
          <p className="text-sm text-slate-600">
            Your face template is an embedding, not a photo. No image is stored anywhere.
          </p>
          <Button onClick={() => router.push('/student')}>Go to check-in</Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger" title="That step did not complete">{error}</Alert> : null}
      {progress ? <Alert tone="info">{progress}</Alert> : null}

      {step === 'consent' ? (
        <Card>
          <CardHeader>
            <CardTitle>Biometric notice</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>
              We create a mathematical template (an &ldquo;embedding&rdquo;) of your face so you can prove you were in
              class. We never store photographs, and the template cannot be used to reconstruct your face.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>Stored: one 512-number template, encrypted and isolated in a biometrics schema.</li>
              <li>Used only to confirm your identity at check-in.</li>
              <li>Deleted {30} days after you withdraw consent or leave the institution.</li>
              <li>
                You can decline: your lecturer can mark you present manually, and declining never blocks you from
                class.
              </li>
            </ul>
            <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span className="text-sm">
                I consent to biometric verification under notice version {NOTICE_VERSION}.
              </span>
            </label>
            <Button disabled={!accepted || busy} onClick={() => void grantConsent()}>
              {busy ? 'Saving…' : 'Accept and continue'}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {step === 'device' ? (
        <Card>
          <CardHeader>
            <CardTitle>Register this phone</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>
              We bind one device to your account using a passkey — the same technology as a banking app. It proves the
              check-in came from your own phone, and it stops a friend using their phone in your name.
            </p>
            <Button disabled={busy} onClick={() => void bindDevice()}>
              {busy ? 'Waiting for your device…' : 'Register this phone'}
            </Button>
            <p className="text-xs text-slate-500">
              New phone? Ask your department administrator for a device reset; the old passkey is revoked.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {step === 'face' ? (
        <Card>
          <CardHeader>
            <CardTitle>Enrol your face</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm text-slate-700">
            <p>Three quick captures: straight ahead, slightly left, slightly right. Keep your face in the frame.</p>
            <Button disabled={busy} onClick={() => void enrolFace()}>
              {busy ? 'Capturing…' : 'Start face enrolment'}
            </Button>
            <p className="text-xs text-slate-500">
              If the camera keeps failing, tell your lecturer — they can mark you present manually.
            </p>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
