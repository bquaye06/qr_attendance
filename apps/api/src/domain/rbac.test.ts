import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideAccess, permissionList, permissionMatches } from './rbac.ts';
import type { Assignment, ResourceScope } from './rbac.ts';

const institutionId = 'inst-1';

const physics: ResourceScope = {
  institutionId,
  facultyId: 'fac-sci',
  departmentId: 'dept-phy',
  offeringId: 'off-phy-101',
};

const history: ResourceScope = {
  institutionId,
  facultyId: 'fac-art',
  departmentId: 'dept-his',
  offeringId: 'off-his-210',
};

function assignment(partial: Partial<Assignment> & Pick<Assignment, 'scopeType' | 'scopeId'>): Assignment {
  return {
    roleKey: partial.roleKey ?? 'department_admin',
    permissions: partial.permissions ?? ['attendance:read'],
    scopeType: partial.scopeType,
    scopeId: partial.scopeId,
  };
}

describe('permission matching', () => {
  it('matches exact permissions only', () => {
    assert.equal(permissionMatches('attendance:read', 'attendance:read'), true);
    assert.equal(permissionMatches('attendance:read', 'attendance:override'), false);
    assert.equal(permissionMatches('attendance', 'attendance:read'), false);
  });

  it('supports wildcards without over-matching', () => {
    assert.equal(permissionMatches('attendance:*', 'attendance:override'), true);
    assert.equal(permissionMatches('attendance:*', 'session:start'), false);
    assert.equal(permissionMatches('*', 'anything:at_all'), true);
  });
});

describe('scope enforcement', () => {
  it('lets a department admin work inside their own department', () => {
    const decision = decideAccess(
      [assignment({ scopeType: 'department', scopeId: 'dept-phy' })],
      'attendance:read',
      physics,
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'granted');
  });

  it('stops a department admin from reading another department', () => {
    const decision = decideAccess(
      [assignment({ scopeType: 'department', scopeId: 'dept-phy' })],
      'attendance:read',
      history,
    );
    assert.deepEqual(decision, { allowed: false, matched: null, reason: 'out_of_scope' });
  });

  it('stops a lecturer from another faculty reading this offering', () => {
    const decision = decideAccess(
      [assignment({ scopeType: 'faculty', scopeId: 'fac-art', roleKey: 'lecturer' })],
      'attendance:read',
      physics,
    );
    assert.equal(decision.allowed, false);
  });

  it('restricts an offering-scoped assistant to that offering', () => {
    const assistant = [
      assignment({ scopeType: 'offering', scopeId: 'off-phy-101', roleKey: 'teaching_assistant' }),
    ];
    assert.equal(decideAccess(assistant, 'attendance:read', physics).allowed, true);
    assert.equal(decideAccess(assistant, 'attendance:read', history).allowed, false);
  });

  it('reports a missing permission separately from a scope failure', () => {
    const auditor = [assignment({ scopeType: 'institution', scopeId: null, permissions: ['report:read'] })];
    assert.equal(decideAccess(auditor, 'attendance:override', physics).reason, 'missing_permission');
  });

  it('gives an institution-scoped super admin everything', () => {
    const superAdmin = [
      assignment({ scopeType: 'institution', scopeId: null, roleKey: 'super_admin', permissions: ['*'] }),
    ];
    assert.equal(decideAccess(superAdmin, 'biometric:purge', history).allowed, true);
  });

  it('combines several roles without widening scope', () => {
    const both = [
      assignment({ scopeType: 'department', scopeId: 'dept-phy' }),
      assignment({
        scopeType: 'department',
        scopeId: 'dept-his',
        permissions: ['report:read'],
        roleKey: 'auditor',
      }),
    ];
    assert.equal(decideAccess(both, 'report:read', history).allowed, true);
    assert.equal(decideAccess(both, 'attendance:override', history).allowed, false);
  });

  it('returns the sorted union of permissions for the UI', () => {
    const merged = permissionList([
      assignment({ scopeType: 'institution', scopeId: null, permissions: ['b:read', 'a:read'] }),
      assignment({ scopeType: 'institution', scopeId: null, permissions: ['a:read', 'c:read'] }),
    ]);
    assert.deepEqual(merged, ['a:read', 'b:read', 'c:read']);
  });
});
