import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { startUiTestServer } from './ui-global-setup.js';

test('large environment catalogue is usable, filterable, refreshable, and race-safe', async ({
  page,
}) => {
  const server = await startUiTestServer({ fixture: 'large' });
  try {
    const startedAt = performance.now();
    await page.goto(server.launchUrl, { waitUntil: 'domcontentloaded' });
    const firstEnvironment = page.getByRole('button', { name: 'Inspect catalog-000' });
    try {
      await firstEnvironment.click({ trial: true, timeout: 1_000 });
    } finally {
      const elapsedMs = performance.now() - startedAt;
      console.info(
        `[ui-performance] environment list actionable in ${elapsedMs.toFixed(1)}ms on ${process.version}`,
      );
    }
    expect(
      performance.now() - startedAt,
      `production environment list exceeded 1,000ms on ${process.version}`,
    ).toBeLessThan(1_000);
    const environmentList = page.getByRole('list', { name: 'Environments' });
    await expect(environmentList.getByRole('listitem')).toHaveCount(100);
    await expect(page.getByText('100 environments', { exact: true })).toBeVisible();

    let releaseFirstInventory: (() => void) | undefined;
    let firstInventoryHeld: (() => void) | undefined;
    let firstInventoryRequests = 0;
    const firstHeld = new Promise<void>((resolve) => {
      firstInventoryHeld = resolve;
    });
    await page.route('**/api/environments/catalog-000', async (route) => {
      firstInventoryRequests += 1;
      firstInventoryHeld!();
      await new Promise<void>((resolve) => {
        releaseFirstInventory = resolve;
      });
      await route.continue().catch(() => undefined);
    });

    await firstEnvironment.click();
    await firstHeld;
    const initialRefresh = page.getByRole('button', { name: 'Refresh catalog-000 content' });
    await expect(initialRefresh).toHaveAttribute('aria-disabled', 'true');
    await initialRefresh.evaluate((button: HTMLButtonElement) => button.click());
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(firstInventoryRequests).toBe(1);
    await page.getByRole('button', { name: 'Inspect catalog-001' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'catalog-001 content' })).toBeVisible();
    releaseFirstInventory!();
    await expect(page.getByRole('heading', { level: 2, name: 'catalog-001 content' })).toBeVisible();
    await expect(page.getByText('Performance skill alpha for catalog-001.')).toBeVisible();

    const filter = page.getByRole('searchbox', { name: 'Filter catalog-001 content' });
    await filter.focus();
    await filter.fill('code-ministry/large-catalogue');
    await expect(filter).toBeFocused();
    await expect(page.getByRole('button', { name: 'Inspect catalog-001' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Inspect skill drafting-001-a' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Inspect skill reviewing-001-b' })).toBeHidden();

    const metadataFilters = [
      ['No description.', 'Inspect skill reviewing-001-b'],
      ['INSTRUCTIONS', 'Inspect instruction base'],
      ['skills/drafting-001-a', 'Inspect skill drafting-001-a'],
      ['large-main', 'Inspect skill drafting-001-a'],
      ['0000000', 'Inspect skill drafting-001-a'],
      ['codex harness instructions', 'Inspect instruction codex'],
      ['HTTP transport', 'Inspect MCP server remote-001'],
      ['Subagent definition', 'Inspect agent planner-001'],
      ['Slash command', 'Inspect command publish-001'],
    ] as const;
    for (const [query, expectedItem] of metadataFilters) {
      await filter.fill(query);
      await expect(page.getByRole('button', { name: expectedItem })).toBeVisible();
      await expect(filter).toBeFocused();
    }

    await filter.fill('does-not-exist');
    await expect(page.getByRole('status', { name: 'Filter results' })).toContainText(
      'No content matches',
    );
    await filter.fill('');
    await expect(page.getByRole('status', { name: 'Filter results' })).toContainText(
      'Showing all 10 elements',
    );

    const refresh = page.getByRole('button', { name: 'Refresh catalog-001 content' });
    await refresh.focus();
    const refreshed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/environments/catalog-001',
    );
    await refresh.click();
    expect((await refreshed).status()).toBe(200);
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
  } finally {
    await server.close();
  }
});
