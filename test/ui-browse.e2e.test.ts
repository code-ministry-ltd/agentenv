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
