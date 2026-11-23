import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const API_URL = process.env['API_URL'] ?? 'http://localhost:4000';

/**
 * Sign-in proxy: posts to the API and forwards the session + CSRF cookies to
 * the browser. The web app never handles the password itself beyond this hop.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const totp = String(form.get('totp') ?? '');

  const response = await fetch(`${API_URL}/api/v1/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, ...(totp.length === 6 ? { totp } : {}) }),
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
    const message = encodeURIComponent(problem?.detail ?? 'Sign in failed.');
    return NextResponse.redirect(new URL(`/signin?error=${message}`, request.url), { status: 303 });
  }

  const body = (await response.json()) as { mfaRequired: boolean; mfaVerified: boolean; mfaSetupRequired: boolean };
  const redirectTo = body.mfaRequired && !body.mfaVerified ? '/signin/mfa' : '/';
  const next = NextResponse.redirect(new URL(redirectTo, request.url), { status: 303 });

  for (const cookie of response.headers.getSetCookie()) {
    next.headers.append('set-cookie', cookie);
  }
  return next;
}
