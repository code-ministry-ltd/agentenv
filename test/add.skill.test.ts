import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { SKILL_NAME_RULE, validateSkillDir } from '../src/content-items.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot, type TempHome } from './helpers.js';

describe('add skill', () => {
  let tmp: TempHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await run(['create', 'writing'], { env: tmp.env });
  });
  afterEach(() => {
    tmp.cleanup();
  });

  function skillDir(env: string, name: string): string {
    return join(tmp.home, 'store', 'environments', env, 'skills', name);
  }

  it('scaffolds a SKILL.md that passes the naming validator', async () => {
    const real = realHomeSnapshot();
    const result = await run(['add', 'skill', 'writing', 'sharpen-prose'], { env: tmp.env });
    expect(result.code).toBe(0);

    const file = join(skillDir('writing', 'sharpen-prose'), 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('name: sharpen-prose');

    // The scaffolded skill validates exactly as a copied one would.
    const validation = await validateSkillDir(skillDir('writing', 'sharpen-prose'));
    expect(validation).toEqual({ name: 'sharpen-prose' });

    expectRealHomeUntouched(real);
  });

  it('is reflected by show', async () => {
    await run(['add', 'skill', 'writing', 'sharpen-prose'], { env: tmp.env });
    const shown = await run(['show', 'writing'], { env: tmp.env });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/skills:\s*1/);
  });

  it('rejects invalid names with the rule quoted, writing nothing', async () => {
    for (const bad of ['Sharpen Prose', 'UPPER', 'has_underscore', 'double--hyphen']) {
      const result = await run(['add', 'skill', 'writing', bad], { env: tmp.env });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(SKILL_NAME_RULE);
      expect(existsSync(skillDir('writing', bad))).toBe(false);
    }
  });

  it("rejects a traversal '../x' with nothing written", async () => {
    const result = await run(['add', 'skill', 'writing', '../x'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    // '../x' contains '/', is not an existing dir → rejected as a non-existent source.
    expect(existsSync(join(tmp.home, 'store', 'environments', 'writing', 'skills'))).toBe(false);
  });

  it('errors clearly when the environment does not exist', async () => {
    const result = await run(['add', 'skill', 'ghost', 'sharpen-prose'], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ghost');
  });

  it('copies and validates a local skill directory', async () => {
    const src = join(tmp.home, 'external', 'tidy-tables');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'SKILL.md'),
      '---\nname: tidy-tables\ndescription: Tidy up tables.\n---\n\n# tidy-tables\n\nDo it.\n',
      'utf8',
    );
    writeFileSync(join(src, 'helper.md'), 'extra file\n', 'utf8');

    const result = await run(['add', 'skill', 'writing', src], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(existsSync(join(skillDir('writing', 'tidy-tables'), 'SKILL.md'))).toBe(true);
    // The whole directory is vendored, not just SKILL.md.
    expect(existsSync(join(skillDir('writing', 'tidy-tables'), 'helper.md'))).toBe(true);
  });

  it('errors helpfully when a local dir lacks a valid SKILL.md', async () => {
    const src = join(tmp.home, 'external', 'no-skill');
    mkdirSync(src, { recursive: true });
    const result = await run(['add', 'skill', 'writing', src], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SKILL.md');
    expect(existsSync(skillDir('writing', 'no-skill'))).toBe(false);
  });

  it('errors when a local skill folder name does not match its frontmatter name', async () => {
    const src = join(tmp.home, 'external', 'wrong-folder');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'SKILL.md'),
      '---\nname: right-name\ndescription: x\n---\n\nbody\n',
      'utf8',
    );
    const result = await run(['add', 'skill', 'writing', src], { env: tmp.env });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/must equal/);
    expect(existsSync(skillDir('writing', 'right-name'))).toBe(false);
  });

  it('refuses to clobber an existing skill without --force, overwrites with it', async () => {
    await run(['add', 'skill', 'writing', 'sharpen-prose'], { env: tmp.env });
    const file = join(skillDir('writing', 'sharpen-prose'), 'SKILL.md');
    writeFileSync(file, '---\nname: sharpen-prose\ndescription: edited\n---\n\nedited body\n', 'utf8');

    const again = await run(['add', 'skill', 'writing', 'sharpen-prose'], { env: tmp.env });
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('--force');
    // Untouched by the refused re-add.
    expect(readFileSync(file, 'utf8')).toContain('edited body');

    const forced = await run(['add', 'skill', 'writing', 'sharpen-prose', '--force'], { env: tmp.env });
    expect(forced.code).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('edited body');
  });

  it('--print-path prints the SKILL.md path without writing', async () => {
    const result = await run(['add', 'skill', 'writing', 'brand-new', '--print-path'], { env: tmp.env });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(join(skillDir('writing', 'brand-new'), 'SKILL.md'));
    expect(existsSync(skillDir('writing', 'brand-new'))).toBe(false);
  });
});
