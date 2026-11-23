import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MeResponse } from '@attend/contracts';

/**
 * API access from the web app.
 *
 * Server components forward the session cookie to the API and never touch the
 * database. Client components use the same REST API with the CSRF double-submit
 * cookie. This is the "API is the source of truth" rule in practice.
 */

const API_URL = process.env['API_URL'] ?? 'http://localhost:4000';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      cookie: cookieHeader,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (response.status === 401) throw new ApiRequestError(401, 'UNAUTHENTICATED', 'Sign in required');
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: string; detail?: string } | null;
    throw new ApiRequestError(response.status, problem?.code ?? 'ERROR', problem?.detail ?? response.statusText);
  }
  return (await response.json()) as T;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await apiFetch<MeResponse>('/api/v1/auth/me');
  } catch {
    return null;
  }
}

export async function requireRole(kind: 'student' | 'lecturer' | 'admin'): Promise<MeResponse> {
  const me = await getMe();
  if (!me) redirect('/signin');
  const roleKeys = me.roles.map((role) => role.roleKey);
  const isAdmin = roleKeys.some((key) => key.endsWith('_admin'));
  const isLecturer = roleKeys.some((key) => key === 'lecturer' || key === 'teaching_assistant');

  if (kind === 'admin' && !isAdmin) redirect('/');
  if (kind === 'lecturer' && !isLecturer && !isAdmin) redirect('/');
  if (kind === 'student' && !me.student && !isLecturer && !isAdmin) redirect('/');
  return me;
}

/** Browser-side call: sends the CSRF header the API expects. */
export async function clientFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('attend_csrf='))
    ?.split('=')[1];

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: string; detail?: string } | null;
    throw new ApiRequestError(
      response.status,
      problem?.code ?? 'ERROR',
      problem?.detail ?? `Request failed (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

export function homeFor(me: MeResponse): string {
  const roleKeys = me.roles.map((role) => role.roleKey);
  if (roleKeys.some((key) => key.endsWith('_admin'))) return '/admin';
  if (roleKeys.some((key) => key === 'lecturer' || key === 'teaching_assistant')) return '/lecturer';
  return '/student';
}
