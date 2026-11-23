import { expect, test } from '@playwright/test';

/**
 * Sign-in and route protection. These run against seeded data:
 *   admin@seed.attend.local / lecturer1@seed.attend.local / student001@seed.attend.local
 *   password: SeedPassw0rd!
 */
const STUDENT = { email: 'student001@seed.attend.local', password: 'SeedPassw0rd!' };
const ADMIN = { email: 'admin@seed.attend.local', password: 'SeedPassw0rd!' };

async function signIn(page: import('@playwright/test').Page, user: { email: string; password: string }) {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('authentication', () => {
  test('a protected page redirects to sign-in when signed out', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('wrong credentials are rejected with a message, not a redirect loop', async ({ page }) => {
    await signIn(page, { email: STUDENT.email, password: 'definitely-not-the-password' });
    await expect(page).toHaveURL(/\/signin\?error=/);
    await expect(page.getByText(/incorrect/i)).toBeVisible();
  });

  test('a student signs in and lands on the student app', async ({ page }) => {
    await signIn(page, STUDENT);
    await expect(page).toHaveURL(/\/student/);
    await expect(page.getByText(/recent attendance|finish setup/i)).toBeVisible();
  });

  test('staff are stopped at two-factor until it is set up', async ({ page }) => {
    await signIn(page, ADMIN);
    // Seeded staff have no confirmed TOTP secret, so the session is limited.
    await expect(page).toHaveURL(/\/signin\/mfa/);
    await expect(page.getByRole('heading', { name: /two-factor/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /generate my secret/i })).toBeVisible();
  });

  test('signing out returns to sign-in and clears the session', async ({ page }) => {
    await signIn(page, STUDENT);
    await expect(page).toHaveURL(/\/student/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/signin/);
    await page.goto('/student');
    await expect(page).toHaveURL(/\/signin/);
  });
});
