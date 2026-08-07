import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { makeFixtureRepo } from './helpers.js';
import { startUiTestServer } from './ui-global-setup.js';

test('browses skills from Git', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const repo = makeFixtureRepo();
  try {
    repo.writeSkill('skills/alpha', { description: 'Alpha builds a clear outline.' });
    repo.writeSkill('skills/beta', { description: 'Beta reviews the final draft.' });
    const commit = repo.commit('browser skills');
    const skillsDir = join(server.home, 'store', 'environments', 'writing', 'skills');
    const before = (await readdir(skillsDir)).sort();

    await page.goto(server.launchUrl);
    const trigger = page.getByRole('button', { name: 'Import from Git' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Browse skills from Git' });
    await expect(dialog.getByLabel('Repository source')).toBeFocused();
    await dialog.getByLabel('Repository source').fill(repo.fileUrl('skills'));
    await dialog.getByRole('button', { name: 'Browse repository' }).click();

    const candidates = dialog.getByRole('list', { name: 'Discovered Git skills' });
    await expect(candidates).toBeVisible();
    await expect(candidates.getByRole('heading', { name: 'alpha' })).toBeVisible();
    await expect(candidates.getByRole('heading', { name: 'beta' })).toBeVisible();
    await expect(candidates).toContainText('Alpha builds a clear outline.');
    await expect(candidates).toContainText('skills/alpha');
    await expect(candidates).toContainText(repo.fileUrl());
    await expect(candidates).toContainText(commit.slice(0, 7));

    await dialog.getByLabel('Filter skills').fill('final draft');
    await expect(candidates.getByRole('heading', { name: 'beta' })).toBeVisible();
    await expect(candidates.getByRole('heading', { name: 'alpha' })).toBeHidden();
    await expect(dialog.getByText('Showing 1 of 2 skills.')).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect((await readdir(skillsDir)).sort()).toEqual(before);
  } finally {
    repo.cleanup();
    await server.close();
  }
});
