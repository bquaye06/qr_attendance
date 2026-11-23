import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  absencesToWrite,
  attendancePercent,
  computeCheckinWindow,
  extendWindow,
  punctualityFor,
  sessionsDueForClose,
  windowState,
} from './session.ts';

const startsAt = new Date('2026-01-12T09:00:00.000Z');

describe('check-in windows', () => {
  it('defaults to opening at start and closing 15 minutes later', () => {
    const window = computeCheckinWindow({
      startsAt,
      opensOffsetMinutes: 0,
      closesOffsetMinutes: 15,
      lateAfterMinutes: 10,
    });
    assert.equal(window.opensAt.toISOString(), '2026-01-12T09:00:00.000Z');
    assert.equal(window.closesAt.toISOString(), '2026-01-12T09:15:00.000Z');
    assert.equal(window.lateAfter.toISOString(), '2026-01-12T09:10:00.000Z');
  });

  it('supports a window that opens before the class starts', () => {
    const window = computeCheckinWindow({
      startsAt,
      opensOffsetMinutes: -5,
      closesOffsetMinutes: 20,
      lateAfterMinutes: 5,
    });
    assert.equal(window.opensAt.toISOString(), '2026-01-12T08:55:00.000Z');
  });

  it('reports window state at the boundaries', () => {
    const window = computeCheckinWindow({
      startsAt,
      opensOffsetMinutes: 0,
      closesOffsetMinutes: 15,
      lateAfterMinutes: 10,
    });
    assert.equal(windowState(window, new Date('2026-01-12T08:59:59.000Z')), 'not_open');
    assert.equal(windowState(window, startsAt), 'open');
    assert.equal(windowState(window, new Date('2026-01-12T09:15:00.000Z')), 'open');
    assert.equal(windowState(window, new Date('2026-01-12T09:15:00.001Z')), 'closed');
  });

  it('marks late exactly after the late threshold', () => {
    const lateAfter = new Date('2026-01-12T09:10:00.000Z');
    assert.equal(punctualityFor(lateAfter, new Date('2026-01-12T09:10:00.000Z')), 'present');
    assert.equal(punctualityFor(lateAfter, new Date('2026-01-12T09:10:01.000Z')), 'late');
  });

  it('extends a window once and refuses a second time', () => {
    const first = extendWindow(
      { status: 'open', checkinClosesAt: new Date('2026-01-12T09:15:00.000Z'), windowExtensions: 0 },
      5,
    );
    assert.equal(first.extended, true);
    assert.equal(first.closesAt.toISOString(), '2026-01-12T09:20:00.000Z');

    const second = extendWindow(
      { status: 'open', checkinClosesAt: new Date('2026-01-12T09:20:00.000Z'), windowExtensions: 1 },
      5,
    );
    assert.equal(second.extended, false);
    assert.equal(second.reason, 'already_extended');
  });

  it('never extends a closed session', () => {
    const result = extendWindow(
      { status: 'closed', checkinClosesAt: new Date('2026-01-12T09:15:00.000Z'), windowExtensions: 0 },
      5,
    );
    assert.equal(result.extended, false);
    assert.equal(result.reason, 'session_closed');
  });
});

describe('absence sweep', () => {
  it('marks every enrolled student without a record', () => {
    assert.deepEqual(absencesToWrite(['a', 'b', 'c'], ['b']), ['a', 'c']);
  });

  it('never rewrites or duplicates existing rows', () => {
    assert.deepEqual(absencesToWrite(['a', 'a', 'b'], ['b']), ['a']);
  });

  it('is a no-op when everyone has a record', () => {
    assert.deepEqual(absencesToWrite(['a'], ['a']), []);
  });

  it('selects only open sessions whose window has ended', () => {
    const now = new Date('2026-01-12T09:30:00.000Z');
    const sessions = [
      { status: 'open' as const, checkinClosesAt: new Date('2026-01-12T09:15:00.000Z') },
      { status: 'open' as const, checkinClosesAt: new Date('2026-01-12T09:45:00.000Z') },
      { status: 'closed' as const, checkinClosesAt: new Date('2026-01-12T08:00:00.000Z') },
      { status: 'scheduled' as const, checkinClosesAt: new Date('2026-01-12T08:00:00.000Z') },
    ];
    assert.deepEqual(sessionsDueForClose(sessions, now), [0]);
  });
});

describe('attendance percentage', () => {
  it('rounds to one decimal place', () => {
    assert.equal(attendancePercent(2, 3), 66.7);
    assert.equal(attendancePercent(3, 4), 75);
  });

  it('is zero when nothing has been held yet', () => {
    assert.equal(attendancePercent(0, 0), 0);
  });
});
