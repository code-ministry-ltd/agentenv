import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';

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
 * A sandboxed stand-in for the process's home directory, installed for the span
 * of one test by {@link guardRealHome} and torn down by
 * {@link expectRealHomeUntouched}.
 */
export interface RealHomeGuard {
  /** The temp dir `os.homedir()` resolves to while the guard is installed. */
  home: string;
  /** Where a leaked store lands: `<home>/.agentenv`. Must never be created. */
  trap: string;
  /** Restore the previous env and delete the sandbox home. Idempotent. */
  restore: () => void;
}

/** The guard currently redirecting this worker's HOME, if any. */
let active: RealHomeGuard | null = null;

/**
 * Make the "real home" hermetic so a test can prove a command never wrote to an
 * agentenv store outside the `AGENTENV_HOME` it was handed.
 *
 * There is exactly one way production code can reach a store other than the
 * injected one: `resolvePaths()` falling back to `join(homedir(), '.agentenv')`
 * because it was called without the test's env. So instead of inspecting the
 * developer's real `~/.agentenv` after the fact — which reads state outside the
 * sandbox, and therefore trips whenever anything else on the machine touches
 * that directory concurrently — we point that fallback at a fresh empty temp
 * dir and assert nothing appeared there.
 *
 * `AGENTENV_HOME` is unset in the process env for the same span, so the
 * `homedir()` fallback is genuinely the path taken (a stray `AGENTENV_HOME` in
 * the developer's shell would otherwise hide the leak). `USERPROFILE` is
 * redirected too because `os.homedir()` consults it on Windows.
 *
 * Pair it with {@link expectRealHomeUntouched} (or call `restore()` yourself).
 * If a test throws before either runs, the next `guardRealHome()` tears the
 * abandoned guard down first — vitest reuses a worker process across files, so a
 * redirect left dangling by a failed test would otherwise become exactly the
 * kind of cross-file state that makes later failures unexplainable.
 */
export function guardRealHome(): RealHomeGuard {
  active?.restore(); // never stack redirects: the saved values must be the real ones
  const home = mkdtempSync(join(tmpdir(), 'agentenv-test-realhome-'));
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    AGENTENV_HOME: process.env.AGENTENV_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.AGENTENV_HOME;

  let restored = false;
  const guard: RealHomeGuard = {
    home,
    trap: join(home, '.agentenv'),
    restore: () => {
      if (restored) return;
      restored = true;
      if (active === guard) active = null;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
  active = guard;
  return guard;
}

/**
 * Assert the guarded home never grew an agentenv store, then tear the guard
 * down. Fails as an assertion (with the leaked entries named), not as a bare
 * throw whose stack is entirely inside vitest's hook machinery.
 */
export function expectRealHomeUntouched(guard: RealHomeGuard): void {
  try {
    const leaked = existsSync(guard.trap);
    const entries = leaked ? readdirSync(guard.home).join(', ') : '';
    expect(
      leaked,
      `production code resolved the agentenv store from os.homedir() instead of the ` +
        `AGENTENV_HOME it was given: ${guard.trap} was created ` +
        `(sandbox home now holds: ${entries})`,
    ).toBe(false);
  } finally {
    guard.restore();
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
  /** Run an arbitrary git command in the repo (for tags, branches, …). */
  git(...args: string[]): string;
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
    git,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
