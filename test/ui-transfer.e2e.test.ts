import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startUiTestServer } from './ui-global-setup.js';

test('copies content between environments', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const documentRequests: string[] = [];
  const transferBodies: Record<string, unknown>[] = [];
  let responseMode: 'continue' | 'failure' | 'stale' | 'hold-overwrite' = 'continue';
  let overwriteHeld: (() => void) | undefined;
  let releaseOverwrite: (() => void) | undefined;
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });
  await page.route('**/api/content/transfer', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    transferBodies.push(body);
    if (responseMode === 'failure') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'secret /private/server/path' },
        }),
      });
      return;
    }
    if (responseMode === 'stale') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'STALE_REVISION',
            message: 'private stale detail',
            details: { kind: 'conflict', resource: '/private/source' },
          },
        }),
      });
      return;
    }
    if (responseMode === 'hold-overwrite' && body.collision === 'overwrite') {
      overwriteHeld!();
      await new Promise<void>((resolve) => { releaseOverwrite = resolve; });
    }
    await route.continue();
  });

  try {
    await page.goto(server.launchUrl);
    await page.getByRole('button', { name: 'Inspect writing' }).click();
    const copy = page.getByRole('button', { name: 'Copy skill drafting' });
    await expect(copy).toBeVisible();

    await copy.click();
    const dialog = page.getByRole('dialog', { name: 'Copy drafting' });
    const destination = dialog.getByLabel('Destination environment');
    await expect(dialog).toBeVisible();
    await expect(destination).toBeFocused();
    await expect(destination.locator('option')).toHaveText(['research']);
    await expect(dialog).toContainText('Source');
    await expect(dialog).toContainText('writing');
    await expect(dialog).toContainText('Destination: research');
    await expect(dialog).toContainText('skill');
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeEnabled();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(destination).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(copy).toBeFocused();
    expect(transferBodies).toHaveLength(0);

    await copy.click();
    await expect(destination).toHaveValue('research');
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeEnabled();
    responseMode = 'failure';
    await dialog.getByRole('button', { name: 'Copy now' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Your destination is retained');
    await expect(destination).toHaveValue('research');
    await expect(page.locator('body')).not.toContainText('/private/server/path');

    responseMode = 'stale';
    await dialog.getByRole('button', { name: 'Copy now' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Refresh both environments');
    await expect(destination).toHaveValue('research');
    await expect(page.locator('body')).not.toContainText('private stale detail');
    const staleSourceRevision = transferBodies.at(-1)?.sourceItemRevision;
    await writeFile(
      join(server.home, 'store', 'environments', 'writing', 'skills', 'drafting', 'SKILL.md'),
      '---\nname: drafting\ndescription: Refreshed draft.\n---\n\n# refreshed drafting\n',
    );
    await dialog.getByRole('button', { name: 'Refresh content' }).click();
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeEnabled();

    responseMode = 'continue';
    await dialog.getByRole('button', { name: 'Copy now' }).click();
    expect(transferBodies.at(-1)?.sourceItemRevision).not.toBe(staleSourceRevision);
    await expect(dialog).toBeHidden();
    await expect(copy).toBeFocused();
    await expect(page.getByText('Copied drafting to research.', { exact: true })).toBeVisible();
    expect(await readFile(
      join(server.home, 'store', 'environments', 'research', 'skills', 'drafting', 'SKILL.md'),
      'utf8',
    )).toContain('# refreshed drafting');

    await copy.click();
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Copy now' }).click();
    const collision = dialog.getByRole('alert');
    await expect(collision).toContainText('already contains this exact item');
    await expect(collision.getByRole('button', { name: 'Replace current drafting' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(transferBodies.filter((body) => body.collision === 'overwrite')).toHaveLength(0);

    const destinationSkill = join(
      server.home,
      'store',
      'environments',
      'research',
      'skills',
      'drafting',
      'SKILL.md',
    );
    await writeFile(
      destinationSkill,
      '---\nname: drafting\ndescription: destination collision\n---\n\n# old destination\n',
    );
    await copy.click();
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Copy now' }).click();
    const replace = dialog.getByRole('button', { name: 'Replace current drafting' });
    await expect(replace).toBeVisible();
    const collisionRevision = transferBodies.at(-1)?.destinationItemRevision;
    await writeFile(
      destinationSkill,
      '---\nname: drafting\ndescription: refreshed collision\n---\n\n# newer destination\n',
    );
    await dialog.getByRole('button', { name: 'Refresh content' }).click();
    await expect(replace).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Copy now' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Copy now' }).click();
    await expect(replace).toBeVisible();
    expect(transferBodies.at(-1)?.destinationItemRevision).not.toBe(collisionRevision);
    const held = new Promise<void>((resolve) => { overwriteHeld = resolve; });
    responseMode = 'hold-overwrite';
    await replace.click();
    await held;
    await expect(dialog.getByRole('status')).toContainText('Copying drafting');
    await expect(replace).toBeDisabled();
    await expect(destination).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    releaseOverwrite!();
    await expect(dialog).toBeHidden();
    await expect(copy).toBeFocused();
    expect(await readFile(destinationSkill, 'utf8')).toBe(await readFile(
      join(server.home, 'store', 'environments', 'writing', 'skills', 'drafting', 'SKILL.md'),
      'utf8',
    ));
    expect(transferBodies.filter((body) => body.collision === 'overwrite')).toHaveLength(1);

    const reviewCopy = page.getByRole('button', { name: 'Copy skill reviewing' });
    await expect(reviewCopy).toBeVisible();
    await reviewCopy.click();
    const reviewDialog = page.getByRole('dialog', { name: 'Copy reviewing' });
    await expect(reviewDialog).toBeVisible();
    await rm(
      join(server.home, 'store', 'environments', 'writing', 'skills', 'reviewing'),
      { recursive: true },
    );
    await reviewDialog.getByRole('button', { name: 'Refresh content' }).click();
    await expect(reviewDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'writing content' })).toBeFocused();
    expect(documentRequests).toHaveLength(1);
  } finally {
    await server.close();
  }
});
