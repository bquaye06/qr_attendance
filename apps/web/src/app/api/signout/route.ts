import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const API_URL = process.env['API_URL'] ?? 'http://localhost:4000';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cookie = request.headers.get('cookie') ?? '';
  const csrf = request.cookies.get('attend_csrf')?.value ?? '';

  const response = await fetch(`${API_URL}/api/v1/auth/signout`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf },
  });

  const next = NextResponse.json({ ok: true });
  for (const setCookie of response.headers.getSetCookie()) {
    next.headers.append('set-cookie', setCookie);
  }
  // Belt and braces: clear locally even if the API call failed.
  next.cookies.set('attend_session', '', { path: '/', maxAge: 0 });
  next.cookies.set('attend_csrf', '', { path: '/', maxAge: 0 });
  return next;
}
