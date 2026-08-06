import { expect, test, type Request } from '@playwright/test';

test('authenticates the local UI and keeps the credential ephemeral', async ({
  context,
  page,
}) => {
  const launchUrl = process.env.AGENTENV_UI_TEST_LAUNCH_URL;
  expect(launchUrl).toBeTruthy();
  const origin = new URL(launchUrl!).origin;
  const consoleProblems: string[] = [];
  let verificationRequest: Request | undefined;
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
  page.on('request', (request) => {
    if (request.url() === `${origin}/api/session/verify`) verificationRequest = request;
  });

  await page.goto(launchUrl!);

  await expect.poll(async () => await page.evaluate(() => location.hash === '')).toBe(true);
  expect(await page.evaluate(() => location.origin + location.pathname)).toBe(`${origin}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your agent environments' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Secure local session established' }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-session', 'ready');
  expect(verificationRequest).toBeDefined();
  await expect(verificationRequest!.headerValue('x-agentenv-csrf')).resolves.toMatch(
    /^[A-Za-z0-9_-]{32,}$/,
  );
  await expect(verificationRequest!.headerValue('cookie')).resolves.toContain(
    'agentenv_session=',
  );

  expect(
    await page.evaluate(() => ({
      cookie: document.cookie,
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ cookie: '', local: [], session: [] });

  const refreshSession = await context.request.get(`${origin}/api/session`);
  expect(refreshSession.status()).toBe(200);

  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: 'Secure local session established' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  for (const viewport of [
    { width: 320, height: 640 },
    { width: 768, height: 800 },
    { width: 1024, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'agentenv home' })).toBeFocused();

  const replay = await context.newPage();
  await replay.goto(launchUrl!);
  await expect.poll(async () => await replay.evaluate(() => location.hash === '')).toBe(true);
  await expect(replay.getByRole('alert')).toContainText('This launch link is no longer valid');
  await replay.close();

  expect(consoleProblems).toEqual([]);
});
