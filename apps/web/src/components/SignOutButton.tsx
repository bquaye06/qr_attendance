'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@attend/ui';

export function SignOutButton() {
  const router = useRouter();

  async function signOut(): Promise<void> {
    await fetch('/api/signout', { method: 'POST' });
    router.push('/signin');
    router.refresh();
  }

  return (
    <Button variant="ghost" size="sm" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
