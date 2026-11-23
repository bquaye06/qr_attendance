import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { JsonForm } from '@/components/admin/JsonForm';

export const metadata = { title: 'Roles · Attend' };

interface RoleRow {
  id: string;
  key: string;
  name: string;
  is_system: boolean;
  permissions: string[];
  assignments: number;
}

export default async function RolesPage() {
  await requireRole('admin');
  const { roles } = await apiFetch<{ roles: RoleRow[] }>('/api/v1/admin/roles');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Roles and permissions</h1>
        <p className="text-sm text-slate-600">
          System roles are fixed. Custom roles are composed from the permission list; scope (institution, faculty,
          department or offering) is applied per assignment.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Roles ({roles.length})</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {roles.length === 0 ? (
            <EmptyState title="No roles" />
          ) : (
            roles.map((role) => (
              <div key={role.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {role.name} <code className="text-xs text-slate-500">{role.key}</code>
                    </p>
                    <p className="text-xs text-slate-500">{role.assignments} assignment(s)</p>
                  </div>
                  <Badge tone={role.is_system ? 'neutral' : 'info'}>{role.is_system ? 'system' : 'custom'}</Badge>
                </div>
                <p className="mt-2 text-xs text-slate-600">
                  {role.permissions.length > 0 ? role.permissions.join(', ') : 'No permissions'}
                </p>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a custom role</CardTitle>
        </CardHeader>
        <CardBody>
          <JsonForm
            action="/api/v1/admin/roles"
            submitLabel="Create role"
            successMessage="Role created. Assign it to a person from the API or the people screen."
            fields={[
              { name: 'key', label: 'Key', required: true, placeholder: 'exam_officer', hint: 'lowercase, underscores' },
              { name: 'name', label: 'Display name', required: true },
              {
                name: 'permissions',
                label: 'Permissions',
                array: true,
                required: true,
                hint: 'Comma separated, e.g. report:read, attendance:read, audit:read',
              },
            ]}
          />
          <p className="mt-3 text-xs text-slate-500">
            Role assignment needs a user id: <code>POST /api/v1/admin/role-assignments</code> with
            <code> {'{ userId, roleKey, scopeType, scopeId }'}</code>.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
