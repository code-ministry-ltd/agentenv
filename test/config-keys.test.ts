import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  injectKeyed,
  removeKey,
  type ConfigKeysItem,
} from '../src/config-keys.js';
import { beginTransaction } from '../src/journal.js';
import { resolvePaths } from '../src/paths.js';
import { findOwners, readState } from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, realHomeSnapshot } from './helpers.js';

describe('config-keys', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof realHomeSnapshot>;

  beforeEach(() => {
    realBefore = realHomeSnapshot();
    temp = makeTempHome();
  });

  afterEach(() => {
    temp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  const paths = () => resolvePaths(temp.env);
  const file = (name: string) => join(temp.home, name);

  /** Run one config-keys operation inside a real begin→commit journal transaction. */
  async function inTx<T>(
    p: ReturnType<typeof paths>,
    fn: (tx: Awaited<ReturnType<typeof beginTransaction>>) => Promise<T>,
  ): Promise<T> {
    const tx = await beginTransaction(p);
    const out = await fn(tx);
    await tx.commit();
    return out;
  }

  describe('config-keys keyed JSON/JSONC inject + remove', () => {
    it('injects a keyed value and records ownership by key path + hash', async () => {
      const p = paths();
      const f = file('claude.json');
      writeFileSync(f, '{\n  "mcpServers": {}\n}\n');

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'json',
          keyPath: ['mcpServers', 'linear'],
          value: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
          ownerEnv: 'writing',
        }),
      );

      // The real key was injected into the file.
      const onDisk = JSON.parse(readFileSync(f, 'utf8'));
      expect(onDisk.mcpServers.linear).toEqual({
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
      });

      // Ownership is tracked by surface + path + key discriminator, with a hash.
      expect(item).toMatchObject({
        surface: 'config-keys',
        mode: 'keyed',
        format: 'json',
        keyPath: ['mcpServers', 'linear'],
        ownerEnv: 'writing',
        key: 'mcpServers.linear',
      });
      expect(item.hash).toMatch(/^[0-9a-f]{64}$/);

      // The transaction committed the record into the manifest.
      const owners = findOwners(await readState(p), f);
      expect(owners).toHaveLength(1);
      expect(owners[0]?.key).toBe('mcpServers.linear');
    });

    it('preserves JSONC comments AND user formatting across an inject+remove cycle', async () => {
      const p = paths();
      const f = file('opencode.jsonc');
      // Deliberately idiosyncratic formatting + comments the user cares about.
      const original = `{
  // linear + github MCP servers live here
  "mcpServers": {
    "github": { "transport": "stdio" }
  },
  "theme":  "dark",
  "weird": [1,   2,3]
}
`;
      writeFileSync(f, original);

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'jsonc',
          keyPath: ['mcpServers', 'linear'],
          value: { transport: 'http' },
          ownerEnv: 'writing',
        }),
      );

      const injected = readFileSync(f, 'utf8');
      // Comment survived, and the injected key is really present.
      expect(injected).toContain('// linear + github MCP servers live here');
      expect(JSON.parse(stripComments(injected)).mcpServers.linear).toEqual({ transport: 'http' });

      // Removing it returns the file byte-for-byte to the user's original.
      const result = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(result.removed).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe(original);
    });

    it('creates the file (backup = absent) and undo deletes it on rollback', async () => {
      const p = paths();
      const f = file('created.json'); // does not exist yet
      expect(existsSync(f)).toBe(false);

      const tx = await beginTransaction(p);
      await injectKeyed(p, tx, {
        file: f,
        format: 'json',
        keyPath: ['a', 'b'],
        value: 1,
        ownerEnv: 'writing',
      });
      // Effect ran: the file now exists mid-transaction.
      expect(existsSync(f)).toBe(true);
      await tx.rollback();

      // Undo of a CREATE deletes the file, and nothing was committed.
      expect(existsSync(f)).toBe(false);
      expect((await readState(p)).items).toHaveLength(0);
    });

    it('removeKey on an already-absent key is a no-op with a note', async () => {
      const p = paths();
      const f = file('claude.json');
      writeFileSync(f, '{}\n');
      const ghost: ConfigKeysItem = {
        action: 'config-key',
        surface: 'config-keys',
        path: f,
        key: 'mcpServers.gone',
        ownerEnv: 'writing',
        mode: 'keyed',
        format: 'json',
        keyPath: ['mcpServers', 'gone'],
        hash: 'deadbeef',
      };

      const result = await inTx(p, (tx) => removeKey(p, tx, ghost));
      expect(result.removed).toBe(false);
      expect(result.reason).toBe('absent');
      expect(result.note).toMatch(/absent/);
      expect(readFileSync(f, 'utf8')).toBe('{}\n'); // untouched
    });
  });
});

/** Cheap comment stripper so tests can JSON.parse a JSONC document. */
function stripComments(jsonc: string): string {
  return jsonc.replace(/^\s*\/\/.*$/gm, '');
}
