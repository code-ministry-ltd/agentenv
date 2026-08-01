import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { writeSecrets } from '../src/secrets.js';
import { makeFixtureAdapter } from './fixtures/fixture-adapter.js';
import { makeTempHome, type TempHome } from './helpers.js';

/**
 * Task 2.4 acceptance (spec criterion 7 / design D6): **no secret value ever
 * reaches the synced store.** Two e2e variants, both driven through the real CLI
 * against a git-backed store so the store's history can be asserted:
 *
 *  - 7a SUBSTITUTE rung (fixture adapter, `substitutePlaceholders`): a fake token
 *    in secrets.env is substituted into the REAL config as a literal; a mid-session
 *    edit is REPORTED and the STORE is untouched, so it still holds the `${VAR}`
 *    placeholder and never the token.
 *  - 7b PASSTHROUGH rung (Claude): the user bakes a literal token over a `${VAR}`
 *    placeholder in the real `.claude.json`; the store keeps the indirection, never
 *    the literal.
 *
 * Plus the fail-closed-per-server path: an unresolved `${VAR}` on a substitute
 * surface warns and skips only that server, leaving the rest materialised.
 */

const homes: TempHome[] = [];
function gitHome(): TempHome {
  const th = makeTempHome({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  homes.push(th);
  return th;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/** A real-SHAPED GitHub token — if it ever hit the store the pre-commit scan would block. */
const FAKE_TOKEN = `ghp_${'A1'.repeat(18)}`;
/** A distinct real-shaped token the user bakes over a passthrough placeholder (7b). */
const BAKED_TOKEN = `ghp_${'B2'.repeat(18)}`;
/**
 * An OPAQUE literal (no provider prefix) baked over an ARRAY-nested `${VAR}` (7c).
 * Deliberately NOT token-shaped, so the D9 token-pattern scan cannot save it — only
 * restoring the placeholder on write-back keeps it out of the store.
 */
const OPAQUE_BAKED = 'Kp7mNq2wXt9vRb4zLc6yHa1dFe3gJh5nMs8pQr0T';

/** All committed blobs + working tree of the store, joined — for a "token never present" scan. */
function storeHistoryAndTree(storeDir: string): string {
  const log = execFileSync('git', ['log', '-p', '--all'], { cwd: storeDir, encoding: 'utf8' });
  const parts: string[] = [log];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else parts.push(readFileSync(abs, 'utf8'));
    }
  };
  walk(storeDir);
  return parts.join('\n');
}

describe('secrets materialise 7a: substitute rung keeps the token out of the store', () => {
  it('substitutes a literal into the real config; write-back restores the placeholder', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'fixture-copy');
    mkdirSync(realRoot, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...th.env, FIXTURE_CONFIG_DIR: realRoot };
    const opts = { env, adapters: [makeFixtureAdapter({ substituteMcp: true })] };

    await run(['init'], { env });
    await run(['create', 'work'], { env });
    // Secret VALUE lives only in secrets.env (machine-local, outside the store).
    await writeSecrets(paths, new Map([['FAKE_TOKEN', FAKE_TOKEN]]));
    // Store MCP def uses the ${VAR} placeholder — never the value.
    mkdirSync(join(paths.envDir('work'), 'mcp'), { recursive: true });
    writeFileSync(
      join(paths.envDir('work'), 'mcp', 'servers.yaml'),
      'github:\n  command: mcp-server-github\n  env:\n    GITHUB_TOKEN: ${FAKE_TOKEN}\n',
    );

    // Materialise via the substitute rung.
    const used = await run(['use', 'work', '--global'], opts);
    expect(used.code).toBe(0);

    // The REAL config received the LITERAL (substitution happened).
    const cfg = JSON.parse(readFileSync(join(realRoot, 'config.json'), 'utf8'));
    expect(cfg.mcpServers.github.env.GITHUB_TOKEN).toBe(FAKE_TOKEN);
    // The STORE def still holds the placeholder — materialise never wrote the store.
    expect(readFileSync(join(paths.envDir('work'), 'mcp', 'servers.yaml'), 'utf8')).toContain(
      '${FAKE_TOKEN}',
    );

    // The user edits the harness config mid-session (a non-secret change → drift).
    const storeFile = join(paths.envDir('work'), 'mcp', 'servers.yaml');
    const storeBefore = readFileSync(storeFile);
    cfg.mcpServers.github.command = 'mcp-server-github-v2';
    writeFileSync(join(realRoot, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    // Next invocation runs the drift sweep → the edit is REPORTED, never applied.
    const again = await run(['use', 'work', '--global'], opts);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("'github'");
    expect(again.stderr).toMatch(/changed\s+command/);

    // STORE: byte-identical. The substitute rung's literal cannot reach it, because the
    // sweep does not write it at all — the placeholder stands until the user edits it.
    expect(readFileSync(storeFile).equals(storeBefore)).toBe(true);
    expect(readFileSync(storeFile, 'utf8')).toContain('${FAKE_TOKEN}');

    // The token literal appears in NO store commit, NO working-tree file, and no report.
    expect(storeHistoryAndTree(paths.store)).not.toContain(FAKE_TOKEN);
    expect(again.stderr ?? '').not.toContain(FAKE_TOKEN);
  });
});

describe('secrets materialise 7b: passthrough rung strips a baked literal on write-back', () => {
  it('a literal baked over a ${VAR} in real .claude.json is restored to the placeholder', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'claude-copy');
    mkdirSync(realHome, { recursive: true });
    // A minimal real .claude.json (mixed internal file) with host state to preserve.
    writeFileSync(
      join(realHome, '.claude.json'),
      `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
    );
    const env: NodeJS.ProcessEnv = { ...th.env, CLAUDE_CONFIG_DIR: realHome };
    const opts = { env, adapters: [claudeAdapter] };

    await run(['init'], { env });
    await run(['create', 'writing'], { env });
    mkdirSync(join(paths.envDir('writing'), 'mcp'), { recursive: true });
    writeFileSync(
      join(paths.envDir('writing'), 'mcp', 'servers.yaml'),
      'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
    );

    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);

    // Passthrough: the placeholder is KEPT in the real config (no secret written).
    const cfg1 = JSON.parse(readFileSync(join(realHome, '.claude.json'), 'utf8'));
    expect(cfg1.mcpServers.linear.headers.Authorization).toBe('Bearer ${LINEAR_TOKEN}');

    // The user BAKES a literal token over the placeholder, mid-session.
    cfg1.mcpServers.linear.headers.Authorization = `Bearer ${BAKED_TOKEN}`;
    writeFileSync(join(realHome, '.claude.json'), `${JSON.stringify(cfg1, null, 2)}\n`);

    // Next invocation: drift sweep write-back restores the placeholder to the store.
    const again = await run(['use', 'writing', '--global'], opts);
    expect(again.code).toBe(0);

    const storeYaml = readFileSync(join(paths.envDir('writing'), 'mcp', 'servers.yaml'), 'utf8');
    // The write-back restores the secret INDIRECTION in canonical D6 shape (F1): the
    // `Bearer ${VAR}` header reverse-maps to `auth.bearer_env: LINEAR_TOKEN` — the token
    // is a var name, never the baked literal.
    expect(storeYaml).toContain('bearer_env: LINEAR_TOKEN');
    expect(storeYaml).not.toContain(BAKED_TOKEN);
    // The baked literal is in NO store commit and NO working-tree file.
    expect(storeHistoryAndTree(paths.store)).not.toContain(BAKED_TOKEN);
  });
});

describe('secrets materialise 7c: an array-nested baked literal is stripped on write-back', () => {
  it('a literal baked over ${VAR} inside stdio args is restored to the placeholder', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const realHome = join(th.home, 'claude-copy');
    mkdirSync(realHome, { recursive: true });
    writeFileSync(
      join(realHome, '.claude.json'),
      `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
    );
    const env: NodeJS.ProcessEnv = { ...th.env, CLAUDE_CONFIG_DIR: realHome };
    const opts = { env, adapters: [claudeAdapter] };

    await run(['init'], { env });
    await run(['create', 'research'], { env });
    mkdirSync(join(paths.envDir('research'), 'mcp'), { recursive: true });
    // Canonical MCP `args` carries the ${VAR} as an ARRAY element (D6 passthrough).
    writeFileSync(
      join(paths.envDir('research'), 'mcp', 'servers.yaml'),
      [
        'context7:',
        '  command: npx',
        '  args:',
        '    - "-y"',
        '    - "@upstash/context7-mcp"',
        '    - "--api-key"',
        '    - "${CTX_API_KEY}"',
        '',
      ].join('\n'),
    );

    const used = await run(['use', 'research', '--global'], opts);
    expect(used.code).toBe(0);

    // Passthrough: the placeholder is KEPT verbatim in the real config (no secret).
    const cfg1 = JSON.parse(readFileSync(join(realHome, '.claude.json'), 'utf8'));
    expect(cfg1.mcpServers.context7.args).toContain('${CTX_API_KEY}');

    // The user BAKES an opaque literal over the array-nested placeholder, mid-session.
    const idx = cfg1.mcpServers.context7.args.indexOf('${CTX_API_KEY}');
    cfg1.mcpServers.context7.args[idx] = OPAQUE_BAKED;
    writeFileSync(join(realHome, '.claude.json'), `${JSON.stringify(cfg1, null, 2)}\n`);

    // Next invocation: drift sweep write-back must restore the placeholder to the store.
    const again = await run(['use', 'research', '--global'], opts);
    expect(again.code).toBe(0);

    const storeYaml = readFileSync(join(paths.envDir('research'), 'mcp', 'servers.yaml'), 'utf8');
    expect(storeYaml).toContain('${CTX_API_KEY}');
    expect(storeYaml).not.toContain(OPAQUE_BAKED);
    // The baked literal is in NO store commit and NO working-tree file.
    expect(storeHistoryAndTree(paths.store)).not.toContain(OPAQUE_BAKED);
  });
});

describe('secrets materialise: an unresolved ${VAR} fails closed per server', () => {
  it('warns and skips only the affected server; the rest materialise', async () => {
    const th = gitHome();
    const paths = resolvePaths(th.env);
    const realRoot = join(th.home, 'fixture-copy');
    mkdirSync(realRoot, { recursive: true });
    // NOTE: no secrets.env and no matching shell var → MISSING_TOKEN is unresolvable.
    const env: NodeJS.ProcessEnv = { ...th.env, FIXTURE_CONFIG_DIR: realRoot };
    const opts = { env, adapters: [makeFixtureAdapter({ substituteMcp: true })] };

    await run(['init'], { env });
    await run(['create', 'work'], { env });
    mkdirSync(join(paths.envDir('work'), 'mcp'), { recursive: true });
    writeFileSync(
      join(paths.envDir('work'), 'mcp', 'servers.yaml'),
      [
        'secret-server:',
        '  command: needs-secret',
        '  env:',
        '    TOKEN: ${MISSING_TOKEN}',
        'plain-server:',
        '  command: no-secret',
        '',
      ].join('\n'),
    );

    const used = await run(['use', 'work', '--global'], opts);
    // Never fails the whole activation.
    expect(used.code).toBe(0);
    // The unresolved var is named in a warning.
    expect(used.stderr ?? '').toContain('MISSING_TOKEN');

    const cfg = JSON.parse(readFileSync(join(realRoot, 'config.json'), 'utf8'));
    // The secret-bearing server was skipped; the plain one materialised.
    expect(cfg.mcpServers['plain-server']).toBeDefined();
    expect(cfg.mcpServers['secret-server']).toBeUndefined();
  });
});
