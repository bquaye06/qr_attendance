import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe, homeFor } from '@/lib/api';
import { SignOutButton } from '@/components/SignOutButton';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/signin');
  if (!me.roles.some((role) => role.roleKey.endsWith('_admin'))) redirect(homeFor(me));

  const links = [
    { href: '/admin', label: 'Dashboard' },
    { href: '/admin/review', label: 'Review queue' },
    { href: '/admin/settings', label: 'Settings' },
    { href: '/admin/devices', label: 'Devices' },
    { href: '/admin/audit', label: 'Audit log' },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex flex-wrap items-center gap-5">
            <span className="text-sm font-semibold">Attend · Management</span>
            <nav className="flex flex-wrap gap-4 text-sm text-slate-600">
              {links.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {me.name} · {me.roles.map((role) => role.roleKey).join(', ')}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  );
}
