import { expect, test } from '@playwright/test';

const STUDENT = { email: 'student001@seed.attend.local', password: 'SeedPassw0rd!' };

test.describe('student setup gating', () => {
  test('a student with no device or face cannot reach the check-in flow', async ({ page }) => {
    await page.goto('/signin');
    await page.getByLabel('Email').fill(STUDENT.email);
    await page.getByLabel('Password').fill(STUDENT.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/student/);

    // Fresh seed accounts have no consent, no passkey and no template.
    await expect(page.getByText(/finish setup/i)).toBeVisible();

    await page.goto('/student/checkin');
    await expect(page.getByText(/finish setup first/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /open camera/i })).toHaveCount(0);
  });

  test('the biometric notice explains the alternative to consent', async ({ page }) => {
    await page.goto('/signin');
    await page.getByLabel('Email').fill(STUDENT.email);
    await page.getByLabel('Password').fill(STUDENT.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.goto('/student/enroll');
    await expect(page.getByRole('heading', { name: /one-time setup/i })).toBeVisible();
    await expect(page.getByText(/never store photographs/i)).toBeVisible();
    // Declining must be a real option, not a dead end: the notice says so.
    await expect(page.getByText(/mark you present manually/i)).toBeVisible();
  });

  test('history shows the per-course threshold', async ({ page }) => {
    await page.goto('/signin');
    await page.getByLabel('Email').fill(STUDENT.email);
    await page.getByLabel('Password').fill(STUDENT.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.goto('/student/history');
    await expect(page.getByRole('heading', { name: /your attendance/i })).toBeVisible();
    await expect(page.getByText(/threshold/i).first()).toBeVisible();
  });
});
