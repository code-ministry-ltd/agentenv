import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { injectKeyed } from '../src/config-keys.js';
import { beginTransaction } from '../src/journal.js';
import { withLock } from '../src/lock.js';
import { resolvePaths } from '../src/paths.js';
import { makeTempHome, type TempHome } from './helpers.js';

const homes: TempHome[] = [];
function home(): TempHome {
  const h = makeTempHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

/**
 * Fixture: an MCP server injected through the real config-keys mechanism, then its
 * value REWRITTEN in the file as a harness reserialising the config would (design
 * D4). The manifest's recorded hash no longer matches the file value, but the key
 * is still present and parseable — reconcilable by parse via syncBack.
 */
async function seedReserialised(th: TempHome): Promise<{ cfgFile: string }> {
  const paths = resolvePaths(th.env);
  mkdirSync(paths.base, { recursive: true });
  const realHome = join(th.home, 'real');
  mkdirSync(realHome, { recursive: true });
  const cfgFile = join(realHome, 'config.json');
  writeFileSync(cfgFile, '{\n  "mcpServers": {\n    "user": { "url": "u" }\n  }\n}\n');

  await withLock(paths, async () => {
    const tx = await beginTransaction(paths);
    await injectKeyed(paths, tx, {
      file: cfgFile,
      format: 'json',
      keyPath: ['mcpServers', 'linear'],
      value: { url: 'https://linear' },
      ownerEnv: 'writing',
    });
    await tx.commit();
  });

  // A harness reserialises the file and rewrites our server's value (value hash
  // changes; the key stays present and parseable).
  const parsed = JSON.parse(readFileSync(cfgFile, 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  parsed.mcpServers.linear = { url: 'https://linear/v2', extra: true };
  writeFileSync(cfgFile, JSON.stringify(parsed, null, 2));
  return { cfgFile };
}

describe('doctor: reserialised config files', () => {
  it('detects a config key whose value hash drifted (read-only)', async () => {
    const th = home();
    const { cfgFile } = await seedReserialised(th);
    const before = readFileSync(cfgFile, 'utf8');

    const res = await run(['doctor'], { env: th.env });
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr ?? ''}`).toContain('config');
    // Never mutates.
    expect(readFileSync(cfgFile, 'utf8')).toBe(before);
  });

  it('--repair reconciles the record to the parsed value, re-run clean', async () => {
    const th = home();
    const { cfgFile } = await seedReserialised(th);

    const repair = await run(['doctor', '--repair'], { env: th.env });
    expect(repair.code).toBe(0);

    // The user's server and the reserialised value both survive; the record now
    // agrees with the file.
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as {
      mcpServers: Record<string, { url: string } | undefined>;
    };
    expect(cfg.mcpServers.user?.url).toBe('u');
    expect(cfg.mcpServers.linear?.url).toBe('https://linear/v2');

    const rerun = await run(['doctor'], { env: th.env });
    expect(rerun.code).toBe(0);
  });
});
