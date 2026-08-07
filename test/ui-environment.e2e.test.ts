import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { scaffoldEnvYaml } from '../src/env-config.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { startUiTestServer } from './ui-global-setup.js';

test('creates or clones an environment with recoverable accessible dialogs', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const documentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });

  let mutationMode: 'continue' | 'stale' | 'pending' | 'hold' = 'continue';
  let catalogMode: 'continue' | 'fail-next' | 'hold-next' = 'continue';
  let inventoryMode: 'continue' | 'fail-next' | 'hold-next' = 'continue';
  let resolveMutationHeld: (() => void) | undefined;
  let releaseMutation: (() => void) | undefined;
  let resolveCatalogHeld: (() => void) | undefined;
  let releaseCatalog: (() => void) | undefined;
  let catalogRelease: Promise<void> | undefined;
  let catalogSnapshot: string | undefined;
  let resolveInventoryHeld: (() => void) | undefined;
  let releaseInventory: (() => void) | undefined;
  let mutationHeld = new Promise<void>((resolve) => {
    resolveMutationHeld = resolve;
  });
  await page.route(/\/api\/environments(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') {
      if (catalogMode === 'fail-next') {
        catalogMode = 'continue';
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'INTERNAL_ERROR', message: 'private catalogue failure' },
          }),
        });
        return;
      }
      if (catalogMode === 'hold-next') {
        catalogMode = 'continue';
        resolveCatalogHeld!();
        void catalogRelease!.then(async () => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: catalogSnapshot!,
          });
        });
        return;
      }
      const response = await route.fetch();
      catalogSnapshot = (await response.body()).toString('utf8');
      await route.fulfill({ response });
      return;
    }
    if (mutationMode === 'stale') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'STALE_REVISION',
            message: 'private server message',
            details: { kind: 'conflict', resource: 'writing' },
          },
        }),
      });
      return;
    }
    if (mutationMode === 'pending') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'PENDING_RECOVERY',
            message: 'private pending message',
            details: {
              kind: 'pending-recovery',
              commandId: 'safe-command-id',
              publication: 'environment-published',
            },
          },
        }),
      });
      return;
    }
    if (mutationMode === 'hold') {
      resolveMutationHeld!();
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
    }
    await route.continue();
  });
  await page.route(/\/api\/environments\/[^/?]+$/, async (route) => {
    if (inventoryMode === 'fail-next') {
      inventoryMode = 'continue';
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'private inventory failure' },
        }),
      });
      return;
    }
    if (inventoryMode === 'hold-next') {
      inventoryMode = 'continue';
      resolveInventoryHeld!();
      await new Promise<void>((resolve) => {
        releaseInventory = resolve;
      });
    }
    await route.continue();
  });

  try {
    await page.goto(server.launchUrl);
    const createTrigger = page.getByRole('button', { name: 'Create environment' });
    const cloneTrigger = page.getByRole('button', { name: 'Clone environment' });
    await expect(createTrigger).toBeVisible();
    await expect(cloneTrigger).toBeVisible();

    await createTrigger.click();
    const createDialog = page.getByRole('dialog', { name: 'Create environment' });
    const createName = createDialog.getByLabel('New environment name');
    const description = createDialog.getByLabel('Description (optional)');
    await expect(createDialog).toBeVisible();
    await expect(createName).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(createDialog.getByRole('button', { name: 'Create now' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(createName).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(createDialog).toBeHidden();
    await expect(createTrigger).toBeFocused();

    await createTrigger.click();
    await createDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(createDialog).toBeHidden();
    await expect(createTrigger).toBeFocused();

    await createTrigger.click();
    await createName.fill('Not Valid');
    await createDialog.getByRole('button', { name: 'Create now' }).click();
    await expect(createDialog.getByRole('alert')).toContainText(
      'Use 1–64 lowercase letters',
    );
    await expect(createName).toHaveValue('Not Valid');

    await createName.fill('stale-draft');
    await description.fill('Retained journal description');
    mutationMode = 'stale';
    await createDialog.getByRole('button', { name: 'Create now' }).click();
    await expect(createDialog.getByRole('alert')).toContainText(
      'Environment data changed during publication',
    );
    await expect(createName).toHaveValue('stale-draft');
    await expect(description).toHaveValue('Retained journal description');
    await expect(page.locator('body')).not.toContainText('private server message');

    catalogMode = 'fail-next';
    await createDialog.getByRole('button', { name: 'Refresh environments' }).click();
    await expect(page.getByText('Environment refresh failed.', { exact: true })).toBeVisible();
    await expect(createDialog).toBeVisible();
    await expect(createName).toHaveValue('stale-draft');
    await expect(description).toHaveValue('Retained journal description');

    catalogMode = 'hold-next';
    const catalogHeld = new Promise<void>((resolve) => {
      resolveCatalogHeld = resolve;
    });
    catalogRelease = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    await createDialog.getByRole('button', { name: 'Refresh environments' }).click();
    await catalogHeld;

    mutationMode = 'continue';
    await createName.fill('writing');
    await createDialog.getByRole('button', { name: 'Create now' }).click();
    await expect(createDialog.getByRole('alert')).toContainText(
      'An environment named writing already exists',
    );
    await expect(createName).toHaveValue('writing');
    await expect(description).toHaveValue('Retained journal description');

    mutationMode = 'hold';
    await createName.fill('journaling');
    await createDialog.getByRole('button', { name: 'Create now' }).click();
    await mutationHeld;
    await expect(createDialog.getByRole('status')).toContainText('Creating journaling');
    await expect(createDialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(createDialog).toBeVisible();
    releaseMutation!();
    await expect(createDialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Inspect journaling' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('heading', { level: 2, name: 'journaling content' })).toBeVisible();
    await expect(page.getByText('This environment has no content yet.')).toBeVisible();
    releaseCatalog!();
    await expect(page.getByRole('button', { name: 'Inspect journaling' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await readFile(join(server.home, 'store', 'environments', 'journaling', 'env.yaml'), 'utf8'))
      .toBe(scaffoldEnvYaml({ description: 'Retained journal description' }));
    expect(documentRequests).toHaveLength(1);

    mutationHeld = new Promise<void>((resolve) => {
      resolveMutationHeld = resolve;
    });
    mutationMode = 'pending';
    await cloneTrigger.click();
    const cloneDialog = page.getByRole('dialog', { name: 'Clone environment' });
    const cloneName = cloneDialog.getByLabel('New environment name');
    const source = cloneDialog.getByLabel('Source environment');
    await expect(cloneName).toBeFocused();
    await cloneName.fill('writing-copy');
    await source.selectOption('writing');
    await cloneDialog.getByRole('button', { name: 'Clone now' }).click();
    await expect(cloneDialog.getByRole('alert')).toContainText(
      'Required Git bookkeeping is pending',
    );
    await expect(cloneName).toHaveValue('writing-copy');
    await expect(source).toHaveValue('writing');
    await expect(cloneDialog.getByRole('button', { name: 'Refresh environments' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('private pending message');

    mutationMode = 'hold';
    catalogMode = 'fail-next';
    inventoryMode = 'fail-next';
    await cloneDialog.getByRole('button', { name: 'Clone now' }).click();
    await mutationHeld;
    await expect(cloneDialog.getByRole('status')).toContainText(
      'Cloning writing as writing-copy',
    );
    releaseMutation!();
    await expect(cloneDialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Inspect writing-copy' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('heading', { level: 2, name: 'writing-copy content' })).toBeVisible();
    for (const name of ['drafting', 'reviewing', 'base', 'linear', 'notion', 'editor', 'publish']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('https://example.com/code-ministry/writing-tools.git')).toBeVisible();
    await expect(page.getByText('skills/drafting', { exact: true })).toBeVisible();
    await expect(page.getByText('abcdef1', { exact: true })).toBeVisible();
    const inventoryHeld = new Promise<void>((resolve) => {
      resolveInventoryHeld = resolve;
    });
    inventoryMode = 'hold-next';
    await page.getByRole('button', { name: 'Retry writing-copy content' }).click();
    await inventoryHeld;
    await expect(page.getByText('Showing previously loaded content while refresh completes…'))
      .toBeVisible();
    await expect(page.getByText('drafting', { exact: true })).toBeVisible();
    releaseInventory!();
    await expect(page.getByRole('button', { name: 'Refresh writing-copy content' })).toBeVisible();
    expect(
      await capturePathIdentity(join(server.home, 'store', 'environments', 'writing-copy')),
    ).toEqual(
      await capturePathIdentity(join(server.home, 'store', 'environments', 'writing')),
    );
    expect(documentRequests).toHaveLength(1);
  } finally {
    await server.close();
  }

  const emptyServer = await startUiTestServer({ fixture: 'empty' });
  try {
    await page.goto(emptyServer.launchUrl);
    const createTrigger = page.getByRole('button', { name: 'Create environment' });
    const cloneTrigger = page.getByRole('button', { name: 'Clone environment' });
    await expect(createTrigger).toBeVisible();
    await expect(cloneTrigger).toBeVisible();
    await createTrigger.click();
    await expect(page.getByRole('dialog', { name: 'Create environment' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(createTrigger).toBeFocused();
    await cloneTrigger.click();
    const cloneDialog = page.getByRole('dialog', { name: 'Clone environment' });
    await expect(cloneDialog.getByLabel('Source environment')).toBeDisabled();
    await expect(cloneDialog).toContainText('Create an environment before cloning one.');
    await page.keyboard.press('Escape');
    await expect(cloneTrigger).toBeFocused();
  } finally {
    await emptyServer.close();
  }
});
