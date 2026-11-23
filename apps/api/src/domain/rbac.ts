/**
 * Scope-aware permission checks.
 *
 * A permission answers "what may they do"; a scope answers "where".
 * `role_assignments` carry a scope (institution, faculty, department or a
 * single course offering), so a department admin of Physics cannot read the
 * History department's data even though the permission string is identical.
 */

export type ScopeType = 'institution' | 'faculty' | 'department' | 'offering';

export interface Assignment {
  roleKey: string;
  permissions: readonly string[];
  scopeType: ScopeType;
  scopeId: string | null;
}

/** The place a resource lives, with every ancestor resolved. */
export interface ResourceScope {
  institutionId: string;
  facultyId: string | null;
  departmentId: string | null;
  offeringId: string | null;
}

export function permissionMatches(granted: string, required: string): boolean {
  if (granted === required) return true;
  if (granted === '*') return true;
  // `resource:*` covers `resource:action`.
  if (granted.endsWith(':*')) {
    const prefix = granted.slice(0, -1);
    return required.startsWith(prefix);
  }
  return false;
}

export function scopeCoversScope(
  assignment: Pick<Assignment, 'scopeType' | 'scopeId'>,
  resource: ResourceScope,
): boolean {
  switch (assignment.scopeType) {
    case 'institution':
      return true;
    case 'faculty':
      return resource.facultyId !== null && resource.facultyId === assignment.scopeId;
    case 'department':
      return resource.departmentId !== null && resource.departmentId === assignment.scopeId;
    case 'offering':
      return resource.offeringId !== null && resource.offeringId === assignment.scopeId;
    default:
      return false;
  }
}

export interface AccessDecision {
  allowed: boolean;
  /** The assignment that granted access, for the audit trail. */
  matched: Assignment | null;
  reason: 'granted' | 'missing_permission' | 'out_of_scope';
}

export function decideAccess(
  assignments: readonly Assignment[],
  requiredPermission: string,
  resource: ResourceScope,
): AccessDecision {
  const withPermission = assignments.filter((assignment) =>
    assignment.permissions.some((permission) => permissionMatches(permission, requiredPermission)),
  );
  if (withPermission.length === 0) {
    return { allowed: false, matched: null, reason: 'missing_permission' };
  }
  const inScope = withPermission.find((assignment) => scopeCoversScope(assignment, resource));
  if (!inScope) return { allowed: false, matched: null, reason: 'out_of_scope' };
  return { allowed: true, matched: inScope, reason: 'granted' };
}

/** Union of all permissions across assignments (used by the UI and /auth/me). */
export function permissionList(assignments: readonly Assignment[]): string[] {
  const set = new Set<string>();
  for (const assignment of assignments) for (const permission of assignment.permissions) set.add(permission);
  return [...set].sort();
}
