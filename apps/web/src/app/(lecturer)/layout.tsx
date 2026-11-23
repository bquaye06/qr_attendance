import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe, homeFor } from '@/lib/api';
import { SignOutButton } from '@/components/SignOutButton';

export default async function LecturerLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/signin');
  const roleKeys = me.roles.map((role) => role.roleKey);
  if (!roleKeys.some((key) => key === 'lecturer' || key === 'teaching_assistant' || key.endsWith('_admin'))) {
    redirect(homeFor(me));
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold">Attend · Teaching</span>
            <nav className="flex gap-4 text-sm text-slate-600">
              <Link href="/lecturer">Today</Link>
              <Link href="/lecturer/offerings">Courses</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">{me.name}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  );
}
