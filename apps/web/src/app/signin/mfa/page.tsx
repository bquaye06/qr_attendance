import { redirect } from 'next/navigation';
import { Alert } from '@attend/ui';
import { getMe, homeFor } from '@/lib/api';
import { MfaForm } from './MfaForm';

export const metadata = { title: 'Two-factor setup · Attend' };

export default async function MfaPage() {
  const me = await getMe();
  if (!me) redirect('/signin');
  if (!me.staff?.requiresMfa) redirect(homeFor(me));

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
      <p className="mt-1 text-sm text-slate-600">
        Lecturers and administrators must use an authenticator app. Your session stays limited until this is done.
      </p>
      <div className="mt-4">
        <Alert tone="info" title="Why this is required">
          Staff accounts can correct attendance records, so they carry a second factor.
        </Alert>
      </div>
      <MfaForm />
    </main>
  );
}
