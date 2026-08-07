import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { makeFixtureRepo } from './helpers.js';
import { startUiTestServer } from './ui-global-setup.js';
import { parseEnvConfig } from '../src/env-config.js';

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

test('imports selected Git skills', async ({ page }) => {
  const server = await startUiTestServer({ fixture: 'authentication' });
  const repo = makeFixtureRepo();
  try {
    repo.writeSkill('skills/alpha', { description: 'Install alpha.' });
    repo.writeSkill('skills/beta', { description: 'Leave beta unselected.' });
    repo.writeSkill('skills/drafting', {
      description: 'Replace drafting only with consent.',
      body: '# drafting\n\nImported replacement.\n',
    });
    const commit = repo.commit('importable skills');
    const writing = join(server.home, 'store', 'environments', 'writing');
    const originalDrafting = await readFile(join(writing, 'skills', 'drafting', 'SKILL.md'), 'utf8');

    await page.goto(server.launchUrl);
    await page.getByRole('button', { name: 'Import from Git' }).click();
    const dialog = page.getByRole('dialog', { name: 'Browse skills from Git' });
    const browse = async (): Promise<void> => {
      await dialog.getByLabel('Repository source').fill(repo.fileUrl('skills'));
      await dialog.getByRole('button', { name: 'Browse repository' }).click();
      await expect(dialog.getByRole('list', { name: 'Discovered Git skills' })).toBeVisible();
    };
    await browse();
    await dialog.getByLabel('Import into environment').selectOption('writing');
    await dialog.getByLabel('Select alpha').check();
    await dialog.getByLabel('Select drafting').check();
    await expect(dialog.getByText('It will be skipped.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import selected skills' }).click();

    const results = dialog.getByRole('status', { name: 'Import results' });
    await expect(results).toContainText('alpha: installed');
    await expect(results).toContainText('drafting: skipped because it already exists');
    expect(await readFile(join(writing, 'skills', 'drafting', 'SKILL.md'), 'utf8'))
      .toBe(originalDrafting);
    expect(await readFile(join(writing, 'skills', 'alpha', 'SKILL.md'), 'utf8'))
      .toContain('name: alpha');
    await expect(access(join(writing, 'skills', 'beta'))).rejects.toMatchObject({ code: 'ENOENT' });

    await browse();
    await dialog.getByLabel('Select drafting').check();
    await dialog.getByLabel('Overwrite existing drafting').check();
    await dialog.getByRole('button', { name: 'Import selected skills' }).click();
    await expect(results).toContainText('drafting: installed');
    expect(await readFile(join(writing, 'skills', 'drafting', 'SKILL.md'), 'utf8'))
      .toContain('Imported replacement.');
    const config = parseEnvConfig(await readFile(join(writing, 'env.yaml'), 'utf8'), 'env.yaml');
    expect(config.sources?.drafting).toMatchObject({
      repo: repo.fileUrl(),
      path: 'skills/drafting',
      commit,
    });
    expect(config.sources?.alpha?.path).toBe('skills/alpha');
  } finally {
    repo.cleanup();
    await server.close();
  }
});
