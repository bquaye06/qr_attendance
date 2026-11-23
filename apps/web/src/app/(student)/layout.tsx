import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe, homeFor } from '@/lib/api';
import { SignOutButton } from '@/components/SignOutButton';

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/signin');
  if (!me.student) redirect(homeFor(me));

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Attend</p>
            <p className="text-xs text-slate-500">
              {me.name} · {me.student.studentNumber}
            </p>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-4 py-5">{children}</main>
      <nav className="sticky bottom-0 border-t border-slate-200 bg-white">
        <ul className="grid grid-cols-3">
          {[
            { href: '/student', label: 'Home' },
            { href: '/student/checkin', label: 'Check in' },
            { href: '/student/history', label: 'History' },
          ].map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex min-h-14 items-center justify-center text-sm font-medium text-slate-700 hover:text-slate-900"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
