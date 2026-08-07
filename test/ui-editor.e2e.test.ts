import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { startUiTestServer } from './ui-global-setup.js';

const DRAFTING_SOURCE = [
  '---',
  'name: drafting',
  'description: Shape a clear first draft.',
  '---',
  '',
  '# drafting',
  '',
  '<script>window.__skillExecuted = true</script>',
  '<img src=x onerror="window.__skillImageExecuted = true">',
  '[unsafe](javascript:window.__skillLinkExecuted=true)',
  '',
].join('\n');

const REVIEWING_SOURCE = [
  '---',
  'name: reviewing',
  'description: Review prose before publishing.',
  '---',
  '',
  '# reviewing',
  '',
].join('\n');

async function editorText(editor: Locator): Promise<string> {
  return await editor.locator('.cm-line').allTextContents().then((lines) => lines.join('\n'));
}

test('isolates a dirty draft and late response from the next skill selection', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const uniqueDraft = '\nselection A draft must not leak';
  let draftingReads = 0;
  let holdDraftingRefresh: (() => void) | undefined;
  let releaseDraftingRefresh: (() => void) | undefined;
  let draftingRefreshResolved: (() => void) | undefined;
  let reviewingDocument: { revision: string; text: string } | undefined;
  const draftingRefreshHeld = new Promise<void>((resolve) => { holdDraftingRefresh = resolve; });
  const releaseHeldDraftingRefresh = new Promise<void>((resolve) => {
    releaseDraftingRefresh = resolve;
  });
  const draftingRefreshFinished = new Promise<void>((resolve) => {
    draftingRefreshResolved = resolve;
  });

  await page.route('**/api/environments/*/skills/*/document', async (route) => {
    const skill = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    const upstream = await route.fetch();
    if (skill === 'reviewing') {
      const body = await upstream.json() as {
        data: { revision: string; text: string };
      };
      reviewingDocument = body.data;
    }
    if (skill === 'drafting' && ++draftingReads === 2) {
      holdDraftingRefresh!();
      await releaseHeldDraftingRefresh;
      await route.fulfill({ response: upstream }).catch(() => undefined);
      draftingRefreshResolved!();
      return;
    }
    await route.fulfill({ response: upstream });
  });

  try {
    const draftingPath = join(
      server.home,
      'store',
      'environments',
      'writing',
      'skills',
      'drafting',
      'SKILL.md',
    );
    await writeFile(draftingPath, DRAFTING_SOURCE, 'utf8');
    await page.goto(server.launchUrl);
    await page.getByRole('button', { name: 'Inspect writing' }).click();
    await page.getByRole('button', { name: 'Open skill drafting' }).click();

    const draftingWorkspace = page.getByRole('region', { name: 'drafting SKILL.md' });
    const draftingEditor = draftingWorkspace.getByRole('textbox', {
      name: 'Skill Markdown source editor',
    });
    await expect.poll(() => editorText(draftingEditor)).toBe(DRAFTING_SOURCE);
    await draftingEditor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await draftingEditor.pressSequentially(uniqueDraft);
    await expect.poll(() => editorText(draftingEditor)).toBe(`${DRAFTING_SOURCE}${uniqueDraft}`);

    await writeFile(draftingPath, `${DRAFTING_SOURCE}\nexternal A response\n`, 'utf8');
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await draftingRefreshHeld;

    await page.getByRole('button', { name: 'Open skill reviewing' }).click();
    const reviewingWorkspace = page.getByRole('region', { name: 'reviewing SKILL.md' });
    const reviewingEditor = reviewingWorkspace.getByRole('textbox', {
      name: 'Skill Markdown source editor',
    });
    await expect(reviewingWorkspace.getByRole('heading', { name: 'reviewing SKILL.md' }))
      .toBeVisible();
    await expect.poll(() => reviewingDocument?.text).toBe(REVIEWING_SOURCE);
    await expect.poll(() => editorText(reviewingEditor)).toBe(REVIEWING_SOURCE);
    await expect(reviewingWorkspace.getByText(/^Revision /))
      .toHaveAttribute('title', reviewingDocument!.revision);
    await expect(reviewingWorkspace).not.toContainText(uniqueDraft.trim());

    releaseDraftingRefresh!();
    await draftingRefreshFinished;
    await expect.poll(() => editorText(reviewingEditor)).toBe(REVIEWING_SOURCE);
    await expect(reviewingWorkspace.getByText(/^Revision /))
      .toHaveAttribute('title', reviewingDocument!.revision);
    await expect(reviewingWorkspace).not.toContainText(uniqueDraft.trim());
  } finally {
    releaseDraftingRefresh?.();
    await server.close();
  }
});

test('opens a skill document', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const documentRequests: string[] = [];
  type ResponseMode = 'continue' | 'hold-drafting' | 'failure' | 'stale' | 'missing' | 'invalid';
  let responseMode: ResponseMode = 'hold-drafting';
  let draftingHeld: (() => void) | undefined;
  let releaseDrafting: (() => void) | undefined;
  const heldDrafting = new Promise<void>((resolve) => { draftingHeld = resolve; });
  const releaseHeldDrafting = new Promise<void>((resolve) => { releaseDrafting = resolve; });

  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });
  await page.route('**/api/environments/*/skills/*/document', async (route) => {
    const skill = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!);
    if (responseMode === 'hold-drafting' && skill === 'drafting') {
      const upstream = await route.fetch();
      draftingHeld!();
      await releaseHeldDrafting;
      await route.fulfill({ response: upstream }).catch(() => undefined);
      return;
    }
    if (responseMode !== 'continue') {
      const detail = 'secret /private/skill/path PRIVATE-SOURCE-TEXT';
      const response = responseMode === 'stale'
        ? { status: 409, code: 'STALE_REVISION' }
        : responseMode === 'missing'
          ? { status: 404, code: 'NOT_FOUND' }
          : responseMode === 'invalid'
            ? { status: 400, code: 'MALFORMED_REQUEST' }
            : { status: 500, code: 'INTERNAL_ERROR' };
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: response.code, message: detail } }),
      });
      return;
    }
    await route.continue();
  });

  try {
    const draftingPath = join(
      server.home,
      'store',
      'environments',
      'writing',
      'skills',
      'drafting',
      'SKILL.md',
    );
    await writeFile(draftingPath, DRAFTING_SOURCE, 'utf8');
    await page.goto(server.launchUrl);
    await page.getByRole('button', { name: 'Inspect writing' }).click();

    // A response for the previous selection cannot replace the active workspace.
    await page.getByRole('button', { name: 'Open skill drafting' }).click();
    await heldDrafting;
    await expect(page.getByRole('heading', { name: 'drafting SKILL.md' })).toBeVisible();
    responseMode = 'continue';
    await page.getByRole('button', { name: 'Open skill reviewing' }).click();
    const reviewingEditor = page.getByRole('textbox', { name: 'Skill Markdown source editor' });
    await expect(page.getByRole('heading', { name: 'reviewing SKILL.md' })).toBeVisible();
    await expect(reviewingEditor).toBeFocused();
    await expect(reviewingEditor).toContainText('# reviewing');
    releaseDrafting!();
    await expect(page.getByRole('heading', { name: 'reviewing SKILL.md' })).toBeVisible();
    await expect(reviewingEditor).toContainText('# reviewing');
    await expect(reviewingEditor).not.toContainText('# drafting');

    // A vanished selection closes the workspace and sends focus to a stable fallback.
    await rm(join(server.home, 'store', 'environments', 'writing', 'skills', 'reviewing'), {
      recursive: true,
    });
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await expect(page.getByRole('heading', { name: 'reviewing SKILL.md' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'writing content' })).toBeFocused();

    await page.getByRole('button', { name: 'Open skill drafting' }).click();
    const workspace = page.getByRole('region', { name: 'drafting SKILL.md' });
    const editor = page.getByRole('textbox', { name: 'Skill Markdown source editor' });
    await expect(workspace).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.evaluate((node) => {
      (window as typeof window & { __originalSkillEditor?: Element }).__originalSkillEditor = node;
    });
    const revisionLabel = workspace.getByText(/^Revision /);
    await expect(revisionLabel).toBeVisible();
    const originalRevision = await revisionLabel.getAttribute('title');
    await expect(workspace.getByRole('button', { name: 'Save unavailable' })).toBeDisabled();

    const tabs = workspace.getByRole('tablist', { name: 'Skill document view' });
    const sourceTab = tabs.getByRole('tab', { name: 'Source' });
    const previewTab = tabs.getByRole('tab', { name: 'Preview' });
    const splitTab = tabs.getByRole('tab', { name: 'Split' });
    await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
    await expect(previewTab).toHaveAttribute('aria-selected', 'false');
    await expect(splitTab).toHaveAttribute('aria-selected', 'false');

    await previewTab.click();
    const literalPreview = workspace.getByLabel('Skill document literal preview');
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
    await expect(editor).toHaveCount(0);
    expect(await literalPreview.textContent()).toBe(DRAFTING_SOURCE);
    await expect(literalPreview.locator('script, img, a')).toHaveCount(0);
    expect(await page.evaluate(() => ({
      script: (window as unknown as { __skillExecuted?: boolean }).__skillExecuted,
      image: (window as unknown as { __skillImageExecuted?: boolean }).__skillImageExecuted,
      link: (window as unknown as { __skillLinkExecuted?: boolean }).__skillLinkExecuted,
    }))).toEqual({ script: undefined, image: undefined, link: undefined });

    await sourceTab.click();
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node) =>
      node === (window as typeof window & { __originalSkillEditor?: Element })
        .__originalSkillEditor)).toBe(true);
    await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await editor.pressSequentially('local retained draft');
    await previewTab.click();
    expect(await literalPreview.textContent()).toBe(`${DRAFTING_SOURCE}local retained draft`);

    await sourceTab.click();
    await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(editor).not.toContainText('local retained draft');
    await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await editor.pressSequentially('local retained draft');
    await previewTab.click();

    await previewTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(splitTab).toHaveAttribute('aria-selected', 'true');
    await expect(editor).toBeFocused();
    await expect(workspace.getByRole('heading', { name: 'Markdown source' })).toBeVisible();
    await expect(workspace.getByRole('heading', { name: 'Literal preview' })).toBeVisible();
    expect(await literalPreview.textContent()).toBe(`${DRAFTING_SOURCE}local retained draft`);

    await sourceTab.click();
    await splitTab.click();
    await sourceTab.click();
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node) =>
      node === (window as typeof window & { __originalSkillEditor?: Element })
        .__originalSkillEditor)).toBe(true);

    // Every retryable read outcome keeps the editor draft and reveals no server detail.
    responseMode = 'failure';
    await writeFile(draftingPath, `${DRAFTING_SOURCE}\nexternal change\n`, 'utf8');
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    const alert = workspace.getByRole('alert');
    await expect(alert).toContainText('draft already in this workspace has been retained');
    await expect(editor).toContainText('local retained draft');
    for (const [mode, safeText] of [
      ['stale', 'changed while it was loading'],
      ['missing', 'no longer available'],
      ['invalid', 'request failed'],
    ] as const) {
      responseMode = mode;
      await alert.getByRole('button', { name: 'Retry skill document' }).click();
      await expect(alert).toContainText(safeText);
      await expect(editor).toContainText('local retained draft');
      await expect(page.locator('body')).not.toContainText('/private/skill/path');
      await expect(page.locator('body')).not.toContainText('PRIVATE-SOURCE-TEXT');
    }
    responseMode = 'continue';
    await alert.getByRole('button', { name: 'Retry skill document' }).click();
    await expect(alert).toBeHidden();
    await expect(workspace).toContainText('local draft was retained');
    await expect(editor).toContainText('local retained draft');
    await expect(editor).not.toContainText('external change');
    await expect(revisionLabel).toHaveAttribute('title', originalRevision!);

    // A later failed response does not discard the already pending successful response.
    responseMode = 'failure';
    await writeFile(draftingPath, `${DRAFTING_SOURCE}\nfailed external change\n`, 'utf8');
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await expect(alert).toContainText('draft already in this workspace has been retained');
    await expect(editor).toContainText('local retained draft');

    // Returning the draft to its old base promotes the pending successful response.
    await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(editor).toContainText('external change');
    await expect(editor).not.toContainText('local retained draft');
    await expect(revisionLabel).not.toHaveAttribute('title', originalRevision!);
    await expect(workspace).not.toContainText('local draft was retained');
    expect(await editor.evaluate((node) =>
      node === (window as typeof window & { __originalSkillEditor?: Element })
        .__originalSkillEditor)).toBe(false);
    await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(editor).toContainText('external change');

    // The promoted response is now the clean base, so a later external update applies directly.
    responseMode = 'continue';
    await writeFile(draftingPath, `${DRAFTING_SOURCE}\nsecond external change\n`, 'utf8');
    await page.getByRole('button', { name: 'Refresh writing content' }).click();
    await expect(editor).toContainText('second external change');
    await expect(editor).not.toContainText('local retained draft');
    expect(documentRequests).toHaveLength(1);
  } finally {
    await server.close();
  }
});
