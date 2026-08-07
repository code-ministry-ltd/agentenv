import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENVIRONMENT_COUNT = 100;

function environmentName(index: number): string {
  return `catalog-${String(index).padStart(3, '0')}`;
}

function hexadecimalCommit(index: number): string {
  return index.toString(16).padStart(40, '0');
}

async function seedEnvironment(environments: string, index: number): Promise<void> {
  const name = environmentName(index);
  const environment = join(environments, name);
  const firstSkill = `drafting-${String(index).padStart(3, '0')}-a`;
  const secondSkill = `reviewing-${String(index).padStart(3, '0')}-b`;
  await Promise.all([
    mkdir(join(environment, 'skills', firstSkill), { recursive: true }),
    mkdir(join(environment, 'skills', secondSkill), { recursive: true }),
    mkdir(join(environment, 'instructions'), { recursive: true }),
    mkdir(join(environment, 'mcp'), { recursive: true }),
    mkdir(join(environment, 'agents'), { recursive: true }),
    mkdir(join(environment, 'commands'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(environment, 'env.yaml'),
      [
        'version: "1.0"',
        `description: Deterministic environment ${name}.`,
        'sources:',
        `  ${firstSkill}:`,
        '    repo: code-ministry/large-catalogue',
        `    path: skills/${firstSkill}`,
        '    ref: large-main',
        `    commit: "${hexadecimalCommit(index)}"`,
        `    hash: fixture-${String(index).padStart(3, '0')}`,
        '',
      ].join('\n'),
    ),
    writeFile(
      join(environment, 'skills', firstSkill, 'SKILL.md'),
      [
        '---',
        `name: ${firstSkill}`,
        `description: Performance skill alpha for ${name}.`,
        '---',
        '',
        `# ${firstSkill}`,
        '',
      ].join('\n'),
    ),
    writeFile(
      join(environment, 'skills', secondSkill, 'SKILL.md'),
      [
        '---',
        `name: ${secondSkill}`,
        '---',
        '',
        `# ${secondSkill}`,
        '',
      ].join('\n'),
    ),
    writeFile(join(environment, 'instructions', 'base.md'), `# Base ${name}\n`),
    writeFile(join(environment, 'instructions', 'codex.md'), `# Codex ${name}\n`),
    writeFile(
      join(environment, 'mcp', 'servers.yaml'),
      [
        `local-${String(index).padStart(3, '0')}:`,
        '  transport: stdio',
        '  command: local-fixture',
        `remote-${String(index).padStart(3, '0')}:`,
        '  transport: http',
        '  url: https://example.invalid/mcp',
        '',
      ].join('\n'),
    ),
    writeFile(join(environment, 'agents', `planner-${String(index).padStart(3, '0')}.md`), '# Planner\n'),
    writeFile(join(environment, 'agents', `reviewer-${String(index).padStart(3, '0')}.md`), '# Reviewer\n'),
    writeFile(join(environment, 'commands', `check-${String(index).padStart(3, '0')}.md`), '# Check\n'),
    writeFile(join(environment, 'commands', `publish-${String(index).padStart(3, '0')}.md`), '# Publish\n'),
  ]);
}

export async function seedLargeUiHome(home: string): Promise<void> {
  const environments = join(home, 'store', 'environments');
  await mkdir(environments, { recursive: true });
  await Promise.all(
    Array.from({ length: ENVIRONMENT_COUNT }, (_, index) =>
      seedEnvironment(environments, index),
    ),
  );
}
