import { eq } from 'drizzle-orm';
import { createDatabase } from './index.ts';
import * as schema from './schema.ts';
import { hashPassword } from '../../../apps/api/src/domain/password.ts';

/**
 * Seed data, clearly marked. One institution, two faculties, six departments'
 * worth of courses, three lecturers, 120 students, a term of timetabled
 * sessions and synthetic face embeddings (random 512-d vectors — NOT faces,
 * and obviously not a real biometric template).
 */

const SEED_TAG = 'seed@attend.local';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticEmbedding(random: () => number): number[] {
  const vector = Array.from({ length: 512 }, () => random() * 2 - 1);
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((value) => value.toFixed(6)).join(',')}]`;
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL_MIGRATE'] ?? process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const { db, pool } = createDatabase({ connectionString });
  const random = mulberry32(20260101);

  try {
    const existing = await db.select({ id: schema.institutions.id }).from(schema.institutions).limit(1);
    if (existing.length > 0) {
      console.log('seed skipped: institutions already exist');
      return;
    }

    const [institution] = await db
      .insert(schema.institutions)
      .values({ name: 'Demo University', code: 'DEMO', timeZone: 'Africa/Accra' })
      .returning();

    const faculties = await db
      .insert(schema.faculties)
      .values([
        { institutionId: institution!.id, name: 'Faculty of Science', code: 'SCI' },
        { institutionId: institution!.id, name: 'Faculty of Arts', code: 'ART' },
      ])
      .returning();

    const departments = await db
      .insert(schema.departments)
      .values([
        { facultyId: faculties[0]!.id, name: 'Computer Science', code: 'CS' },
        { facultyId: faculties[0]!.id, name: 'Mathematics', code: 'MATH' },
        { facultyId: faculties[0]!.id, name: 'Physics', code: 'PHY' },
        { facultyId: faculties[1]!.id, name: 'History', code: 'HIS' },
        { facultyId: faculties[1]!.id, name: 'Linguistics', code: 'LIN' },
        { facultyId: faculties[1]!.id, name: 'Philosophy', code: 'PHI' },
      ])
      .returning();

    const programmes = await db
      .insert(schema.programmes)
      .values([
        { departmentId: departments[0]!.id, name: 'BSc Computer Science', code: 'BSCS' },
        { departmentId: departments[1]!.id, name: 'BSc Mathematics', code: 'BSMA' },
        { departmentId: departments[3]!.id, name: 'BA History', code: 'BAHI' },
      ])
      .returning();

    const [term] = await db
      .insert(schema.terms)
      .values({
        institutionId: institution!.id,
        name: '2025/2026 Semester 2',
        startsOn: '2026-01-05',
        endsOn: '2026-05-15',
        isCurrent: true,
      })
      .returning();

    const courseRows = await db
      .insert(schema.courses)
      .values([
        { departmentId: departments[0]!.id, code: 'CS201', title: 'Data Structures', creditHours: 4 },
        { departmentId: departments[0]!.id, code: 'CS301', title: 'Operating Systems', creditHours: 3 },
        { departmentId: departments[1]!.id, code: 'MA101', title: 'Calculus I', creditHours: 3 },
        { departmentId: departments[2]!.id, code: 'PH101', title: 'Mechanics', creditHours: 3 },
        { departmentId: departments[3]!.id, code: 'HI210', title: 'Modern Africa', creditHours: 2 },
        { departmentId: departments[4]!.id, code: 'LI150', title: 'Phonetics', creditHours: 2 },
      ])
      .returning();

    const offerings = await db
      .insert(schema.courseOfferings)
      .values(
        courseRows.map((course) => ({ courseId: course.id, termId: term!.id, section: 'A', capacity: 120 })),
      )
      .returning();

    const rooms = await db
      .insert(schema.rooms)
      .values([
        {
          institutionId: institution!.id,
          name: 'Lecture Theatre 1',
          building: 'Main Block',
          latitude: '5.650500',
          longitude: '-0.187000',
          geofenceM: 120,
        },
        {
          institutionId: institution!.id,
          name: 'Lab 204',
          building: 'Science Block',
          latitude: '5.651200',
          longitude: '-0.186400',
          geofenceM: 80,
        },
        { institutionId: institution!.id, name: 'Seminar Room B', building: 'Arts Block', geofenceM: 60 },
      ])
      .returning();

    // Three lecturers, all with MFA required (staff policy).
    const lecturerSeed = [
      { email: 'lecturer1@seed.attend.local', name: 'Dr Ama Owusu', staff: 'STF-001', dept: departments[0]!.id },
      { email: 'lecturer2@seed.attend.local', name: 'Dr Kojo Asante', staff: 'STF-002', dept: departments[1]!.id },
      { email: 'lecturer3@seed.attend.local', name: 'Dr Yaa Adjei', staff: 'STF-003', dept: departments[3]!.id },
    ];
    const passwordHash = await hashPassword('SeedPassw0rd!');

    const lecturerIds: string[] = [];
    for (const seed of lecturerSeed) {
      const [user] = await db
        .insert(schema.users)
        .values({ email: seed.email, name: seed.name, passwordHash, status: 'active' })
        .returning();
      const [lecturer] = await db
        .insert(schema.lecturers)
        .values({ userId: user!.id, staffNumber: seed.staff, departmentId: seed.dept })
        .returning();
      lecturerIds.push(lecturer!.id);
    }

    const [superAdmin] = await db
      .insert(schema.users)
      .values({
        email: 'admin@seed.attend.local',
        name: 'Seed Super Admin',
        passwordHash,
        status: 'active',
      })
      .returning();

    // Roles + permissions from the contracts package.
    const { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } = await import('@attend/contracts');
    await db
      .insert(schema.permissions)
      .values(PERMISSIONS.map((key) => ({ key, description: key })))
      .onConflictDoNothing();
    const permissionRows = await db.select().from(schema.permissions);

    const roleRows = await db
      .insert(schema.roles)
      .values(
        Object.entries(SYSTEM_ROLE_PERMISSIONS).map(([key, permissions]) => ({
          key,
          name: key.replace(/_/gu, ' '),
          isSystem: true,
        })),
      )
      .returning();

    const roleByKey = new Map(roleRows.map((role) => [role.key, role.id]));
    const permissionByKey = new Map(permissionRows.map((permission) => [permission.key, permission.id]));
    const rolePermissionValues: { roleId: string; permissionId: string }[] = [];
    for (const [roleKey, permissions] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
      const roleId = roleByKey.get(roleKey);
      if (!roleId) continue;
      for (const permission of permissions) {
        const permissionId = permissionByKey.get(permission);
        if (permissionId) rolePermissionValues.push({ roleId, permissionId });
      }
    }
    if (rolePermissionValues.length > 0) {
      await db.insert(schema.rolePermissions).values(rolePermissionValues).onConflictDoNothing();
    }

    await db.insert(schema.roleAssignments).values({
      userId: superAdmin!.id,
      roleId: roleByKey.get('super_admin')!,
      scopeType: 'institution',
      scopeId: null,
    });
    for (const [index, lecturerId] of lecturerIds.entries()) {
      const lecturerUser = await db
        .select({ userId: schema.lecturers.userId })
        .from(schema.lecturers)
        .where(eq(schema.lecturers.id, lecturerId))
        .limit(1);
      await db.insert(schema.roleAssignments).values({
        userId: lecturerUser[0]!.userId,
        roleId: roleByKey.get('lecturer')!,
        scopeType: 'department',
        scopeId: lecturerSeed[index]!.dept,
      });
    }

    // Teaching assignments: two offerings per lecturer.
    await db.insert(schema.teachingAssignments).values([
      { offeringId: offerings[0]!.id, lecturerId: lecturerIds[0]!, role: 'lecturer' },
      { offeringId: offerings[1]!.id, lecturerId: lecturerIds[0]!, role: 'lecturer' },
      { offeringId: offerings[2]!.id, lecturerId: lecturerIds[1]!, role: 'lecturer' },
      { offeringId: offerings[3]!.id, lecturerId: lecturerIds[1]!, role: 'lecturer' },
      { offeringId: offerings[4]!.id, lecturerId: lecturerIds[2]!, role: 'lecturer' },
      { offeringId: offerings[5]!.id, lecturerId: lecturerIds[2]!, role: 'lecturer' },
    ]);

    // 120 students.
    const studentValues: { userId: string; studentNumber: string; programmeId: string; year: number }[] = [];
    for (let i = 1; i <= 120; i += 1) {
      const [user] = await db
        .insert(schema.users)
        .values({
          email: `student${String(i).padStart(3, '0')}@seed.attend.local`,
          name: `Seed Student ${String(i).padStart(3, '0')}`,
          passwordHash,
          status: 'active',
        })
        .returning();
      studentValues.push({
        userId: user!.id,
        studentNumber: `2026${String(i).padStart(4, '0')}`,
        programmeId: programmes[i % programmes.length]!.id,
        year: 1 + (i % 4),
      });
    }
    const studentRows: { id: string }[] = [];
    for (const value of studentValues) {
      const [student] = await db.insert(schema.students).values(value).returning({ id: schema.students.id });
      studentRows.push(student!);
    }

    // Enrol everyone in the first offering, half in the second.
    const enrollmentValues = studentRows.flatMap((student, index) => {
      const rows = [{ offeringId: offerings[0]!.id, studentId: student.id, status: 'active' }];
      if (index % 2 === 0) rows.push({ offeringId: offerings[2]!.id, studentId: student.id, status: 'active' });
      return rows;
    });
    await db.insert(schema.enrollments).values(enrollmentValues).onConflictDoNothing();

    // Timetable: Monday and Wednesday 09:00 for offering 0, Tuesday 14:00 for offering 2.
    await db.insert(schema.timetableSlots).values([
      {
        offeringId: offerings[0]!.id,
        roomId: rooms[0]!.id,
        dayOfWeek: 1,
        startsAt: '09:00',
        endsAt: '11:00',
        validFrom: '2026-01-05',
        validTo: '2026-05-15',
      },
      {
        offeringId: offerings[0]!.id,
        roomId: rooms[0]!.id,
        dayOfWeek: 3,
        startsAt: '09:00',
        endsAt: '11:00',
        validFrom: '2026-01-05',
        validTo: '2026-05-15',
      },
      {
        offeringId: offerings[2]!.id,
        roomId: rooms[1]!.id,
        dayOfWeek: 2,
        startsAt: '14:00',
        endsAt: '16:00',
        validFrom: '2026-01-05',
        validTo: '2026-05-15',
      },
    ]);

    // Two past, closed sessions with records, plus one scheduled.
    const sessionTimes = [
      { start: '2026-01-05T09:00:00Z', status: 'closed' as const },
      { start: '2026-01-07T09:00:00Z', status: 'closed' as const },
      { start: '2026-01-12T09:00:00Z', status: 'scheduled' as const },
    ];
    for (const timing of sessionTimes) {
      const startsAt = new Date(timing.start);
      const [session] = await db
        .insert(schema.classSessions)
        .values({
          offeringId: offerings[0]!.id,
          roomId: rooms[0]!.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
          checkinOpensAt: startsAt,
          checkinClosesAt: new Date(startsAt.getTime() + 15 * 60 * 1000),
          lateAfter: new Date(startsAt.getTime() + 10 * 60 * 1000),
          status: timing.status,
          closedAt: timing.status === 'closed' ? new Date(startsAt.getTime() + 2 * 60 * 60 * 1000) : null,
        })
        .returning();

      if (timing.status === 'closed') {
        const records = studentRows.map((student, index) => ({
          sessionId: session!.id,
          studentId: student.id,
          status: index % 7 === 0 ? 'absent' : index % 11 === 0 ? 'late' : 'present',
          method: 'auto' as const,
          checkedInAt: new Date(startsAt.getTime() + (index % 11 === 0 ? 12 : 3) * 60 * 1000),
        }));
        await db.insert(schema.attendanceRecords).values(records);
      }
    }

    // Synthetic templates for the first 20 students, so the duplicate-enrolment
    // search has something to search. Marked seed-only.
    for (const student of studentRows.slice(0, 20)) {
      await pool.query(
        `insert into biometrics.face_templates (student_id, embedding, model_version, quality_score, liveness_score)
         values ($1, $2::vector, $3, $4, $5)`,
        [student.id, toVectorLiteral(syntheticEmbedding(random)), 'seed-synthetic-512', 0.95, 0.97],
      );
      await pool.query(
        `insert into biometric_consents (student_id, notice_version) values ($1, $2) on conflict do nothing`,
        [student.id, 'seed-notice-v1'],
      );
    }

    // Default settings row so the console has something to edit.
    const { DEFAULT_SETTINGS } = await import('@attend/contracts');
    await db.insert(schema.systemSettings).values(
      Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value: value as unknown })),
    );

    await db.insert(schema.auditLog).values({
      actorId: null,
      actorEmail: SEED_TAG,
      action: 'seed.applied',
      entity: 'institution',
      entityId: institution!.id,
      after: { students: 120, lecturers: 3, offerings: 6, note: 'seed data' },
    });

    console.log('seed complete: 1 institution, 2 faculties, 6 courses, 3 lecturers, 120 students');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
