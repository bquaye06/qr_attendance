'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Alert, AttendanceBadge, Badge, Button, Card, CardBody, CardHeader, CardTitle, Stat } from '@attend/ui';
import { clientFetch } from '@/lib/api';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

interface RosterEntry {
  studentId: string;
  studentNumber: string;
  name: string;
  status: string;
  method: string | null;
  checkedInAt: string | null;
  flagReason: string | null;
  riskScore: number | null;
}

interface RosterEvent {
  counts: { enrolled: number; present: number; late: number; flagged: number; absent: number; excused: number };
  entries: RosterEntry[];
}

interface QrEvent {
  token: string;
  issuedAt: string;
  expiresAt: string;
  rotationSeconds: number;
}

export function LiveClient({
  sessionId,
  initial,
  meta,
}: {
  sessionId: string;
  initial: RosterEvent;
  meta: { courseCode: string; courseTitle: string; roomName: string | null; checkinClosesAt: string; status: string };
}) {
  const [roster, setRoster] = useState<RosterEvent>(initial);
  const [qr, setQr] = useState<{ dataUrl: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [mode, setMode] = useState<'projector' | 'roster'>('projector');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busyStudent, setBusyStudent] = useState<string | null>(null);
  const rosterRef = useRef(roster);
  rosterRef.current = roster;

  // Rotating QR: the API streams one signed token per rotation interval.
  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/v1/sessions/${sessionId}/qr/stream`, { withCredentials: true });
    source.addEventListener('qr', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as QrEvent;
      void QRCode.toDataURL(payload.token, { margin: 1, width: 512, errorCorrectionLevel: 'M' }).then((dataUrl) =>
        setQr({ dataUrl, expiresAt: new Date(payload.expiresAt).getTime() }),
      );
    });
    source.onerror = () => setError('Live QR stream disconnected. Reconnecting…');
    return () => source.close();
  }, [sessionId]);

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/v1/sessions/${sessionId}/roster/stream`, {
      withCredentials: true,
    });
    source.addEventListener('roster', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as RosterEvent;
      setRoster(payload);
    });
    return () => source.close();
  }, [sessionId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const secondsLeft = qr ? Math.max(0, Math.round((qr.expiresAt - now) / 1000)) : 0;
  const windowLeft = Math.max(0, Math.round((new Date(meta.checkinClosesAt).getTime() - now) / 1000));

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return roster.entries;
    return roster.entries.filter(
      (entry) => entry.name.toLowerCase().includes(term) || entry.studentNumber.includes(term),
    );
  }, [roster.entries, filter]);

  const correct = useCallback(
    async (studentId: string, status: 'present_manual' | 'excused' | 'absent') => {
      const reason = window.prompt('Reason for this correction (required, goes to the audit log):');
      if (!reason || reason.trim().length < 3) return;
      setBusyStudent(studentId);
      setError(null);
      try {
        await clientFetch(`/api/v1/sessions/${sessionId}/students/${studentId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status, reason: reason.trim() }),
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Correction failed.');
      } finally {
        setBusyStudent(null);
      }
    },
    [sessionId],
  );

  return (
    <div className="space-y-4">
      {error ? <Alert tone="warning">{error}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {meta.courseCode} <span className="font-normal text-slate-500">{meta.courseTitle}</span>
          </h1>
          <p className="text-xs text-slate-500">
            {meta.roomName ?? 'No room'} · window closes in {Math.floor(windowLeft / 60)}m {windowLeft % 60}s
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={mode === 'projector' ? 'default' : 'outline'} size="sm" onClick={() => setMode('projector')}>
            Projector
          </Button>
          <Button variant={mode === 'roster' ? 'default' : 'outline'} size="sm" onClick={() => setMode('roster')}>
            Live roster
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Present" value={roster.counts.present + roster.counts.late} detail={`of ${roster.counts.enrolled}`} />
        <Stat label="Late" value={roster.counts.late} />
        <Stat label="Flagged" value={roster.counts.flagged} />
        <Stat label="Absent" value={roster.counts.absent} />
      </div>

      {mode === 'projector' ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-4 py-8">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.dataUrl} alt="Check-in QR code" className="h-auto w-full max-w-sm rounded-xl bg-white p-3" />
            ) : (
              <div className="flex h-72 w-full max-w-sm items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">
                Waiting for a token…
              </div>
            )}
            <p className="text-4xl font-semibold tabular-nums">{secondsLeft}s</p>
            <p className="text-sm text-slate-500">
              The code changes every few seconds. A photo of the screen stops working almost immediately.
            </p>
            <p className="text-xs uppercase tracking-wide text-slate-400">No student names are shown on this screen</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex items-center justify-between gap-3">
            <CardTitle>Live roster</CardTitle>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search name or number"
              className="h-9 w-56 rounded-lg border border-slate-300 px-3 text-sm"
            />
          </CardHeader>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Student</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Checked in</th>
                  <th className="px-4 py-2">Risk</th>
                  <th className="px-4 py-2">Correct</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr key={entry.studentId} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <p className="font-medium">{entry.name}</p>
                      <p className="text-xs text-slate-500">{entry.studentNumber}</p>
                    </td>
                    <td className="px-4 py-2">
                      <AttendanceBadge status={entry.status} />
                      {entry.flagReason ? (
                        <p className="mt-1 text-xs text-amber-700">{entry.flagReason.replace(/_/gu, ' ')}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {entry.checkedInAt ? new Date(entry.checkedInAt).toLocaleTimeString('en-GB') : '—'}
                    </td>
                    <td className="px-4 py-2">
                      {entry.riskScore !== null ? <Badge tone={entry.riskScore >= 70 ? 'warning' : 'neutral'}>{entry.riskScore}</Badge> : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyStudent === entry.studentId}
                          onClick={() => void correct(entry.studentId, 'present_manual')}
                        >
                          Present
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyStudent === entry.studentId}
                          onClick={() => void correct(entry.studentId, 'excused')}
                        >
                          Excused
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyStudent === entry.studentId}
                          onClick={() => void correct(entry.studentId, 'absent')}
                        >
                          Absent
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
