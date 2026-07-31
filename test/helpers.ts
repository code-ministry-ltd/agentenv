import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A hermetic temp AGENTENV_HOME plus the env object to inject into run(). */
export interface TempHome {
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function makeTempHome(extraEnv: NodeJS.ProcessEnv = {}): TempHome {
  const home = mkdtempSync(join(tmpdir(), 'agentenv-test-'));
  return {
    home,
    env: { AGENTENV_HOME: home, ...extraEnv },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/**
 * Snapshot the real ~/.agentenv so a test can prove a command never touched it.
 * Works whether or not it already exists on the dev machine.
 */
export function realHomeSnapshot(): { existed: boolean; mtimeMs?: number } {
  const real = join(homedir(), '.agentenv');
  if (!existsSync(real)) return { existed: false };
  return { existed: true, mtimeMs: statSync(real).mtimeMs };
}

export function expectRealHomeUntouched(before: { existed: boolean; mtimeMs?: number }): void {
  const real = join(homedir(), '.agentenv');
  if (!before.existed) {
    if (existsSync(real)) {
      throw new Error(`test created the real ~/.agentenv at ${real}`);
    }
    return;
  }
  if (statSync(real).mtimeMs !== before.mtimeMs) {
    throw new Error(`test modified the real ~/.agentenv at ${real}`);
  }
}

/** Options for one skill written into a fixture repo. */
export interface FixtureSkillOptions {
  /** Frontmatter `name`; defaults to the directory's basename. */
  name?: string;
  /** Frontmatter `description`; defaults to a generated line. */
  description?: string;
  /** SKILL.md body after the frontmatter. */
  body?: string;
  /** Extra files (relative path → contents) written alongside SKILL.md. */
  extraFiles?: Record<string, string>;
}

/** A local git repository used as an offline, network-free skill source in tests. */
export interface FixtureRepo {
  dir: string;
  /** `file://` URL to the repo root, or to `subpath` inside it. */
  fileUrl(subpath?: string): string;
  /** Write a skill directory at `relPath` (relative to the repo root). */
  writeSkill(relPath: string, opts?: FixtureSkillOptions): void;
  /** Write an arbitrary file (relative path → contents). */
  writeFile(relPath: string, contents: string): void;
  /** `git add -A && git commit`; returns the new HEAD sha. */
  commit(message: string): string;
  /** Current HEAD sha. */
  head(): string;
  cleanup(): void;
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'agentenv-test',
  GIT_AUTHOR_EMAIL: 'test@agentenv.invalid',
  GIT_COMMITTER_NAME: 'agentenv-test',
  GIT_COMMITTER_EMAIL: 'test@agentenv.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * Create a hermetic on-disk git repository for exercising git-source skill
 * installs offline (design D17). Cloned via its `file://` URL, it never touches
 * the network, so the whole git path runs in CI. Configured with no global/system
 * git config and no GPG signing so it is reproducible on any machine.
 */
export function makeFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), 'agentenv-fixture-repo-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  git('-c', 'init.defaultBranch=main', 'init');
  git('config', 'commit.gpgsign', 'false');

  const writeFile = (relPath: string, contents: string): void => {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  };

  const writeSkill = (relPath: string, opts: FixtureSkillOptions = {}): void => {
    const folder = relPath.split('/').filter(Boolean).at(-1) ?? relPath;
    const name = opts.name ?? folder;
    const description = opts.description ?? `The ${folder} skill.`;
    const body = opts.body ?? `# ${name}\n\nInstructions for ${name}.\n`;
    writeFile(
      join(relPath, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    );
    for (const [extra, contents] of Object.entries(opts.extraFiles ?? {})) {
      writeFile(join(relPath, extra), contents);
    }
  };

  return {
    dir,
    fileUrl: (subpath?: string) =>
      subpath ? pathToFileURL(join(dir, subpath)).href : pathToFileURL(dir).href,
    writeSkill,
    writeFile,
    commit: (message: string) => {
      git('add', '-A');
      git('-c', 'commit.gpgsign=false', 'commit', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    head: () => git('rev-parse', 'HEAD'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
