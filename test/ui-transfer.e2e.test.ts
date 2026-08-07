import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('moves content between environments', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const documentRequests: string[] = [];
  const catalogueRequests: string[] = [];
  const transferBodies: Record<string, unknown>[] = [];
  let transferSuccess: Record<string, unknown> | undefined;
  let failWritingInventory = false;
  let responseMode:
    | 'continue'
    | 'failure'
    | 'stale'
    | 'hold-overwrite'
    | 'git-pending'
    | 'projection-failure' = 'continue';
  let overwriteHeld: (() => void) | undefined;
  let releaseOverwrite: (() => void) | undefined;
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
    if (request.url().includes('/api/environments?page=')) catalogueRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/content/transfer') &&
      response.ok()
    ) {
      void response.json().then((body: { data?: Record<string, unknown> }) => {
        transferSuccess = body.data;
      });
    }
  });
  await page.route('**/api/environments/writing', async (route) => {
    if (failWritingInventory) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'private refresh failure' },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/content/transfer', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    transferBodies.push(body);
    if (responseMode === 'failure') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'secret /private/move/path' },
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
            message: 'private move stale detail',
            details: { kind: 'conflict', resource: '/private/move/source' },
          },
        }),
      });
      return;
    }
    if (responseMode === 'git-pending' || responseMode === 'projection-failure') {
      const operation = body.operation as string;
      const kind = body.kind as string;
      const name = body.name as string;
      const sourceEnvironment = body.sourceEnvironment as string;
      const destinationEnvironment = body.destinationEnvironment as string;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            operation,
            source: { environment: sourceEnvironment, kind, name },
            destination: { environment: destinationEnvironment, kind, name },
            publication: responseMode === 'git-pending' ? 'git-pending' : 'complete',
            refreshRequired: true,
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
    const move = page.getByRole('button', { name: 'Move skill drafting' });
    await expect(move).toBeVisible();

    await move.click();
    const dialog = page.getByRole('dialog', { name: 'Move drafting' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Moving removes this item from writing');
    await expect(dialog).toContainText('Destination: research');
    await expect(dialog).toContainText('skill');
    await expect(dialog).toContainText('drafting');
    const destination = dialog.getByLabel('Destination environment');
    await expect(destination).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Move now' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(destination).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(move).toBeFocused();
    expect(transferBodies).toHaveLength(0);

    await move.click();
    responseMode = 'failure';
    await dialog.getByRole('button', { name: 'Move now' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Your destination is retained');
    await expect(destination).toHaveValue('research');
    await expect(page.locator('body')).not.toContainText('/private/move/path');

    responseMode = 'stale';
    await dialog.getByRole('button', { name: 'Move now' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Refresh both environments');
    await expect(destination).toHaveValue('research');
    await expect(page.locator('body')).not.toContainText('private move stale detail');
    const staleSourceRevision = transferBodies.at(-1)?.sourceItemRevision;
    const sourceSkill = join(
      server.home,
      'store',
      'environments',
      'writing',
      'skills',
      'drafting',
      'SKILL.md',
    );
    await writeFile(
      sourceSkill,
      '---\nname: drafting\ndescription: Refreshed move draft.\n---\n\n# refreshed move drafting\n',
    );
    await dialog.getByRole('button', { name: 'Refresh content' }).click();
    await expect(dialog.getByRole('button', { name: 'Move now' })).toBeEnabled();
    responseMode = 'failure';
    await dialog.getByRole('button', { name: 'Move now' }).click();
    expect(transferBodies.at(-1)?.sourceItemRevision).not.toBe(staleSourceRevision);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const destinationSkill = join(
      server.home,
      'store',
      'environments',
      'research',
      'skills',
      'drafting',
      'SKILL.md',
    );
    await mkdir(join(destinationSkill, '..'), { recursive: true });
    await writeFile(
      destinationSkill,
      '---\nname: drafting\ndescription: destination collision\n---\n\n# old destination\n',
    );
    responseMode = 'continue';
    await move.click();
    await dialog.getByRole('button', { name: 'Move now' }).click();
    const collision = dialog.getByRole('alert');
    const replace = collision.getByRole('button', { name: 'Replace current drafting' });
    await expect(collision).toContainText('already contains this exact item');
    await expect(replace).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(transferBodies.filter((body) => body.collision === 'overwrite')).toHaveLength(0);

    await move.click();
    await dialog.getByRole('button', { name: 'Move now' }).click();
    await expect(replace).toBeVisible();
    const collisionRevision = transferBodies.at(-1)?.destinationItemRevision;
    await writeFile(
      destinationSkill,
      '---\nname: drafting\ndescription: changed collision\n---\n\n# newer destination\n',
    );
    await dialog.getByRole('button', { name: 'Refresh content' }).click();
    await expect(replace).toBeHidden();
    await dialog.getByRole('button', { name: 'Move now' }).click();
    await expect(replace).toBeVisible();
    expect(transferBodies.at(-1)?.destinationItemRevision).not.toBe(collisionRevision);

    const held = new Promise<void>((resolve) => { overwriteHeld = resolve; });
    responseMode = 'hold-overwrite';
    const catalogueBeforeMove = catalogueRequests.length;
    await replace.click();
    await held;
    await expect(dialog.getByRole('status')).toContainText('Moving drafting');
    await expect(replace).toBeDisabled();
    await expect(destination).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(1, 1);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    expect(transferBodies.filter((body) => body.collision === 'overwrite')).toHaveLength(1);
    releaseOverwrite!();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'writing content' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Move skill drafting' })).toHaveCount(0);
    await expect(page.getByText(
      'Moved drafting to research and removed it from writing.',
      { exact: true },
    )).toBeVisible();
    await expect.poll(() => catalogueRequests.length).toBeGreaterThan(catalogueBeforeMove);
    await expect.poll(() => transferSuccess).toMatchObject({
      operation: 'move',
      publication: 'complete',
      refreshRequired: false,
      sourceEnvironment: {
        name: 'writing',
        items: expect.not.arrayContaining([expect.objectContaining({ kind: 'skill', name: 'drafting' })]),
      },
      destinationEnvironment: {
        name: 'research',
        items: expect.arrayContaining([expect.objectContaining({ kind: 'skill', name: 'drafting' })]),
      },
    });
    await expect(readFile(sourceSkill, 'utf8')).rejects.toThrow();
    expect(await readFile(destinationSkill, 'utf8')).toContain('# refreshed move drafting');

    responseMode = 'git-pending';
    await page.getByRole('button', { name: 'Move command publish' }).click();
    const pendingDialog = page.getByRole('dialog', { name: 'Move publish' });
    await pendingDialog.getByRole('button', { name: 'Move now' }).click();
    await expect(page.getByText(
      'Moved publish to research. The move is complete locally and required Git bookkeeping is pending. Affected content could not be refreshed; refresh to reconcile the view. Do not repeat the move.',
      { exact: true },
    )).toBeVisible();

    responseMode = 'projection-failure';
    const editorMove = page.getByRole('button', { name: 'Move agent editor' });
    const staleEditorMove = await editorMove.elementHandle();
    expect(staleEditorMove).not.toBeNull();
    await editorMove.click();
    const refreshRequiredDialog = page.getByRole('dialog', { name: 'Move editor' });
    failWritingInventory = true;
    await refreshRequiredDialog.getByRole('button', { name: 'Move now' }).click();
    await expect(page.getByText(
      'Moved editor to research. The move is complete, but affected content could not be refreshed. Refresh to reconcile the view; do not repeat the move.',
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole('heading', { name: 'writing content' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Copy agent editor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Move agent editor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy skill reviewing' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move skill reviewing' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('writing content is unavailable');

    const requestsAfterAuthoritativeMove = transferBodies.length;
    await staleEditorMove!.evaluate((element) => {
      if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a move button');
      element.click();
    });
    await page.keyboard.press('Enter');
    expect(transferBodies).toHaveLength(requestsAfterAuthoritativeMove);

    failWritingInventory = false;
    await page.getByRole('button', { name: 'Retry writing content' }).click();
    await expect(page.getByRole('button', { name: 'Refresh writing content' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move agent editor' })).toHaveCount(0);

    await writeFile(
      join(server.home, 'store', 'environments', 'writing', 'agents', 'editor.md'),
      '# recreated editor\n',
    );
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await expect(page.getByRole('button', { name: 'Copy agent editor' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move agent editor' })).toBeVisible();

    await page.getByRole('button', { name: 'Inspect research' }).click();
    await expect(page.getByRole('button', { name: 'Inspect skill drafting' })).toBeVisible();
    expect(documentRequests).toHaveLength(1);
  } finally {
    await server.close();
  }
});
