import { redirect } from 'next/navigation';
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Label, Alert } from '@attend/ui';
import { getMe, homeFor } from '@/lib/api';

export const metadata = { title: 'Sign in · Attend' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const me = await getMe();
  if (me) redirect(homeFor(me));
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Attend</h1>
        <p className="mt-1 text-sm text-slate-600">
          Sign in with your institution account to check in, teach, or manage attendance.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardBody>
          {error ? (
            <div className="mb-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
          <form action="/api/signin" method="post" className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <div>
              <Label htmlFor="totp">Authenticator code (staff only)</Label>
              <Input id="totp" name="totp" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>

      <p className="mt-6 text-xs text-slate-500">
        Staff accounts require a six-digit authenticator code. Students use their institution password and a
        passkey on this device.
      </p>
    </main>
  );
}
