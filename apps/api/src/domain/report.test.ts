import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCourseMatrix, countRoster } from './report.ts';

const sessions = [
  { sessionId: 's1', startsAt: new Date('2026-01-05T09:00:00.000Z'), status: 'closed' as const },
  { sessionId: 's2', startsAt: new Date('2026-01-12T09:00:00.000Z'), status: 'closed' as const },
  { sessionId: 's3', startsAt: new Date('2026-01-19T09:00:00.000Z'), status: 'cancelled' as const },
  { sessionId: 's4', startsAt: new Date('2026-01-26T09:00:00.000Z'), status: 'open' as const },
];

const students = [
  { studentId: 'a', studentNumber: '2023002', name: 'Ama Mensah' },
  { studentId: 'b', studentNumber: '2023001', name: 'Kofi Boateng' },
];

describe('course report matrix', () => {
  it('excludes cancelled sessions from the held count', () => {
    const matrix = buildCourseMatrix({ sessions, students, records: [], threshold: 75 });
    assert.equal(matrix.sessions.length, 3);
    assert.equal(matrix.held, 3);
  });

  it('counts every present-like status as attended', () => {
    const matrix = buildCourseMatrix({
      sessions,
      students,
      threshold: 75,
      records: [
        { sessionId: 's1', studentId: 'a', status: 'present' },
        { sessionId: 's2', studentId: 'a', status: 'late' },
        { sessionId: 's4', studentId: 'a', status: 'present_manual' },
      ],
    });
    const row = matrix.students.find((student) => student.studentId === 'a')!;
    assert.equal(row.attended, 3);
    assert.equal(row.percent, 100);
    assert.equal(row.belowThreshold, false);
  });

  it('does not count absent, excused or missing records as attended', () => {
    const matrix = buildCourseMatrix({
      sessions,
      students,
      threshold: 75,
      records: [
        { sessionId: 's1', studentId: 'a', status: 'absent' },
        { sessionId: 's2', studentId: 'a', status: 'excused' },
      ],
    });
    const row = matrix.students.find((student) => student.studentId === 'a')!;
    assert.equal(row.attended, 0);
    assert.equal(row.percent, 0);
    assert.equal(row.belowThreshold, true);
    assert.equal(row.cells.find((cell) => cell.sessionId === 's4')?.status, null);
  });

  it('flags students exactly at the threshold as acceptable but below it as failing', () => {
    // 2 of 4 present would be 50%; with 3 held sessions, 2 attended is 66.7%.
    const atThreshold = buildCourseMatrix({
      sessions,
      students,
      threshold: 66.7,
      records: [
        { sessionId: 's1', studentId: 'a', status: 'present' },
        { sessionId: 's2', studentId: 'a', status: 'present' },
      ],
    });
    assert.equal(atThreshold.students.find((s) => s.studentId === 'a')!.belowThreshold, false);

    const below = buildCourseMatrix({
      sessions,
      students,
      threshold: 70,
      records: [
        { sessionId: 's1', studentId: 'a', status: 'present' },
        { sessionId: 's2', studentId: 'a', status: 'present' },
      ],
    });
    assert.equal(below.students.find((s) => s.studentId === 'a')!.belowThreshold, true);
  });

  it('sorts students by student number for a stable export', () => {
    const matrix = buildCourseMatrix({ sessions, students, records: [], threshold: 75 });
    assert.deepEqual(
      matrix.students.map((student) => student.studentNumber),
      ['2023001', '2023002'],
    );
  });

  it('counts a live roster, treating missing records as absent', () => {
    const counts = countRoster(['present', 'late', 'present_flagged', 'excused', null, null], 6);
    assert.deepEqual(counts, { enrolled: 6, present: 1, late: 1, flagged: 1, absent: 2, excused: 1 });
  });

  it('counts manual presences with automatic ones', () => {
    const counts = countRoster(['present_manual', 'present'], 2);
    assert.equal(counts.present, 2);
  });
});
