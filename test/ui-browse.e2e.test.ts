import { expect, test } from '@playwright/test';
import { startUiTestServer } from './ui-global-setup.js';

test('browses environment summaries once in stable order across real pages', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'catalog' });
  try {
    const catalogResponses: Array<{ search: string; status: number }> = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname === '/api/environments') {
        catalogResponses.push({ search: url.search, status: response.status() });
      }
    });
    let releaseCatalog: (() => void) | undefined;
    const catalogBlocked = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    await page.route('**/api/environments?**', async (route) => {
      await catalogBlocked;
      await route.continue();
    });

    await page.goto(server.launchUrl);
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading environments' }),
    ).toBeVisible();
    const firstCatalogResponse = page.waitForResponse((response) =>
      response.url().includes('/api/environments?page=1&pageSize=100'),
    );
    releaseCatalog!();
    await firstCatalogResponse;
    await page.unroute('**/api/environments?**');

    await expect(page.getByRole('heading', { level: 2, name: 'Environments' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Environments' });
    await expect(list.getByRole('listitem')).toHaveCount(101);
    const expectedNames = [
      ...Array.from({ length: 99 }, (_, index) => `catalog-${String(index).padStart(3, '0')}`),
      'research',
      'writing',
    ];
    const firstNames = await list.getByRole('heading', { level: 3 }).allTextContents();
    expect(firstNames).toEqual(expectedNames);
    expect(new Set(firstNames).size).toBe(101);
    await expect(page.getByText('101 environments', { exact: true })).toBeVisible();
    await expect(list.getByText('Active', { exact: true })).toHaveCount(1);
    await expect(
      list.getByText('2 skills · 1 instruction · 2 MCP servers · 1 agent · 1 command'),
    ).toBeVisible();
    await expect(list.locator('[data-revision]')).toHaveCount(101);
    expect(catalogResponses).toEqual([
      { search: '?page=1&pageSize=100', status: 200 },
      { search: '?page=2&pageSize=100', status: 200 },
    ]);

    catalogResponses.length = 0;
    await page.reload();
    await expect(list.getByRole('listitem')).toHaveCount(101);
    expect(await list.getByRole('heading', { level: 3 }).allTextContents()).toEqual(firstNames);
    expect(catalogResponses).toEqual([
      { search: '?page=1&pageSize=100', status: 200 },
      { search: '?page=2&pageSize=100', status: 200 },
    ]);
  } finally {
    await server.close();
  }
});

test('browses environment summaries from a real empty home', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'empty' });
  try {
    const catalogResponse = page.waitForResponse((response) =>
      response.url().includes('/api/environments?'),
    );
    await page.goto(server.launchUrl);
    expect((await catalogResponse).status()).toBe(200);

    await expect(page.getByText('No environments yet.')).toBeVisible();
    await expect(page.getByText('Create one from the CLI to see it here.')).toBeVisible();
  } finally {
    await server.close();
  }
});

test('browses environment summaries into a real request-error state', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'error' });
  try {
    const catalogResponse = page.waitForResponse((response) =>
      response.url().includes('/api/environments?'),
    );
    await page.goto(server.launchUrl);
    expect((await catalogResponse).status()).toBe(500);

    await expect(page.getByRole('alert')).toContainText(
      'Environment summaries are unavailable',
    );
  } finally {
    await server.close();
  }
});

test('inspects environment content of every kind with safe metadata by keyboard', async ({
  page,
}) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  try {
    await page.goto(server.launchUrl);
    const writing = page.getByRole('button', { name: /Inspect writing/ });
    await writing.focus();
    await expect(writing).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { level: 2, name: 'writing content' })).toBeVisible();
    const expectedGroups = [
      ['Skills', '2'],
      ['Instructions', '1'],
      ['MCP servers', '2'],
      ['Agents', '1'],
      ['Commands', '1'],
    ] as const;
    for (const [name, count] of expectedGroups) {
      await expect(page.locator('summary').filter({ hasText: name })).toContainText(count);
    }

    for (const name of ['drafting', 'reviewing', 'base', 'linear', 'notion', 'editor', 'publish']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Shape a clear first draft.')).toBeVisible();
    await expect(page.getByText('https://example.com/code-ministry/writing-tools.git')).toBeVisible();
    await expect(page.getByText('skills/drafting', { exact: true })).toBeVisible();
    await expect(page.getByText('abcdef1', { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('browser-secret');
    await expect(page.locator('body')).not.toContainText('token=hidden');

    const skillsGroup = page.locator('summary').filter({ hasText: 'Skills' });
    await skillsGroup.focus();
    await expect(skillsGroup).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Inspect skill drafting' })).toBeHidden();
    await page.keyboard.press('Enter');
    const drafting = page.getByRole('button', { name: 'Inspect skill drafting' });
    await drafting.focus();
    await page.keyboard.press('Enter');
    await expect(drafting).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await server.close();
  }
});

test('inspects environment content through empty stale unavailable and error states', async ({
  page,
}) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  try {
    let mode: 'continue' | 'hold' | 'stale' | 'missing' | 'error' = 'continue';
    let releaseRefresh: (() => void) | undefined;
    let resolveRequestHeld: (() => void) | undefined;
    const requestHeld = new Promise<void>((resolve) => {
      resolveRequestHeld = resolve;
    });
    await page.route('**/api/environments/writing', async (route) => {
      if (mode === 'hold') {
        resolveRequestHeld!();
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        await route.continue();
      } else if (mode === 'missing') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'missing' } }),
        });
      } else if (mode === 'stale') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'STALE_REVISION', message: 'stale' } }),
        });
      } else if (mode === 'error') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'private detail' } }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(server.launchUrl);
    await page.getByRole('button', { name: /Inspect research/ }).click();
    await expect(page.getByText('This environment has no content yet.')).toBeVisible();

    await page.getByRole('button', { name: /Inspect writing/ }).click();
    await expect(page.getByRole('button', { name: 'Refresh writing content' })).toBeVisible();

    mode = 'hold';
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await requestHeld;
    await expect(
      page.getByRole('status').filter({ hasText: 'previously loaded content' }),
    ).toBeVisible();
    releaseRefresh!();
    await expect(page.getByRole('status').filter({ hasText: 'previously loaded content' })).toBeHidden();

    mode = 'stale';
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await expect(page.getByRole('alert')).toContainText('content changed before it could be loaded');

    mode = 'missing';
    await page.getByRole('button', { name: 'Retry writing content' }).click();
    await expect(page.getByRole('alert')).toContainText('writing is no longer available');

    mode = 'error';
    await page.getByRole('button', { name: 'Retry writing content' }).click();
    await expect(page.getByRole('alert')).toContainText('writing content is unavailable');
    await expect(page.locator('body')).not.toContainText('private detail');
  } finally {
    await server.close();
  }
});
