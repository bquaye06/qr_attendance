import { redirect } from 'next/navigation';
import { getMe, homeFor } from '@/lib/api';

export default async function IndexPage() {
  const me = await getMe();
  if (!me) redirect('/signin');
  redirect(homeFor(me));
}
