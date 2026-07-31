import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  injectArrayElement,
  injectKeyed,
  removeKey,
  syncBack,
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

  describe('config-keys drift + syncBack write-back', () => {
    async function injectLinear(p: ReturnType<typeof paths>, f: string): Promise<ConfigKeysItem> {
      return inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'json',
          keyPath: ['mcpServers', 'linear'],
          value: { transport: 'http' },
          ownerEnv: 'writing',
        }),
      );
    }

    it('refuses to remove a drifted key until its drift is written back', async () => {
      const p = paths();
      const f = file('claude.json');
      writeFileSync(f, '{\n  "mcpServers": {}\n}\n');
      const item = await injectLinear(p, f);

      // The harness/user edits the value in place → drift.
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      doc.mcpServers.linear = { transport: 'ws' };
      writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');

      // Removal is refused while the recorded hash no longer matches the file.
      const refused = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(refused).toMatchObject({ removed: false, reason: 'hash-mismatch' });
      expect(JSON.parse(readFileSync(f, 'utf8')).mcpServers.linear).toEqual({ transport: 'ws' });

      // syncBack writes the drift back and updates the recorded hash.
      const synced = await inTx(p, (tx) => syncBack(p, tx, item));
      expect(synced.drifted).toBe(true);
      expect(synced.currentValue).toEqual({ transport: 'ws' });
      expect(synced.canonicalValue).toEqual({ transport: 'ws' });
      expect(synced.item.hash).not.toBe(item.hash);

      // With the hash back in agreement, removal now proceeds.
      const removed = await inTx(p, (tx) => removeKey(p, tx, synced.item));
      expect(removed.removed).toBe(true);
      expect(JSON.parse(readFileSync(f, 'utf8')).mcpServers).toEqual({});
    });

    it('reports no drift when the value is unchanged (a no-op sync)', async () => {
      const p = paths();
      const f = file('claude.json');
      writeFileSync(f, '{\n  "mcpServers": {}\n}\n');
      const item = await injectLinear(p, f);

      const synced = await inTx(p, (tx) => syncBack(p, tx, item));
      expect(synced.drifted).toBe(false);
      expect(synced.item.hash).toBe(item.hash);
      expect((await readState(p)).items).toHaveLength(1); // no phantom mutation
    });

    it('restores a secret-flagged field to its placeholder on write-back, never the literal', async () => {
      const p = paths();
      const f = file('claude.json');
      writeFileSync(f, '{\n  "mcpServers": {}\n}\n');

      // Inject with a passthrough placeholder and flag it secret.
      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'json',
          keyPath: ['mcpServers', 'github'],
          value: { transport: 'stdio', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
          ownerEnv: 'writing',
          secretFields: { 'env.GITHUB_TOKEN': '${GITHUB_TOKEN}' },
        }),
      );

      // The harness bakes a real literal token over the placeholder.
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      doc.mcpServers.github.env.GITHUB_TOKEN = 'ghp_REALSECRET123';
      doc.mcpServers.github.transport = 'http'; // also a non-secret drift
      writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');

      const synced = await inTx(p, (tx) => syncBack(p, tx, item));
      expect(synced.drifted).toBe(true);
      // The value returned FOR THE STORE never contains the literal secret.
      expect(synced.canonicalValue).toEqual({
        transport: 'http',
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      });
      const canonicalText = JSON.stringify(synced.canonicalValue);
      expect(canonicalText).not.toContain('ghp_REALSECRET123');
      expect(canonicalText).toContain('${GITHUB_TOKEN}');

      // The literal is also stripped from the config file itself.
      const fileNow = readFileSync(f, 'utf8');
      expect(fileNow).not.toContain('ghp_REALSECRET123');
      expect(fileNow).toContain('${GITHUB_TOKEN}');

      // A second sync now sees no drift (hash agrees with the placeholder form).
      const again = await inTx(p, (tx) => syncBack(p, tx, synced.item));
      expect(again.drifted).toBe(false);
    });
  });

  describe('config-keys keyed TOML inject + remove', () => {
    const originalToml = `# my codex config
[mcp_servers.github]
transport = "stdio"
`;

    async function injectLinearToml(
      p: ReturnType<typeof paths>,
      f: string,
    ): Promise<ConfigKeysItem> {
      return inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'toml',
          keyPath: ['mcp_servers', 'linear'],
          value: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
          ownerEnv: 'writing',
        }),
      );
    }

    it('injects a marked [table] and removes it by marker-splice, preserving the rest', async () => {
      const p = paths();
      const f = file('config.toml');
      writeFileSync(f, originalToml);

      const item = await injectLinearToml(p, f);
      const injected = readFileSync(f, 'utf8');
      // Marked block present, user content and its comment untouched.
      expect(injected).toContain('# >>> agentenv:config-key mcp_servers.linear >>>');
      expect(injected).toContain('[mcp_servers.linear]');
      expect(injected).toContain('# my codex config');
      const parsed = parseToml(injected) as { mcp_servers: { linear: unknown; github: unknown } };
      expect(parsed.mcp_servers.linear).toEqual({
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
      });
      expect(parsed.mcp_servers.github).toEqual({ transport: 'stdio' });

      // Markers present → splice returns the file byte-for-byte to the original.
      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe(originalToml);
    });

    it('removes by PARSE after a harness reserialised the file and stripped the markers', async () => {
      const p = paths();
      const f = file('config.toml');
      writeFileSync(f, originalToml);
      const item = await injectLinearToml(p, f);

      // Simulate the harness rewriting the file: parse → stringify drops every
      // comment, including our ownership markers, and may reorder tables.
      const reserialised = stringifyToml(parseToml(readFileSync(f, 'utf8')));
      writeFileSync(f, reserialised);
      expect(reserialised).not.toContain('agentenv:config-key'); // markers gone

      // Removal must still find and drop our key — by parse, not by text.
      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);

      const after = parseToml(readFileSync(f, 'utf8')) as { mcp_servers?: Record<string, unknown> };
      expect(after.mcp_servers?.linear).toBeUndefined(); // our key gone
      expect(after.mcp_servers?.github).toEqual({ transport: 'stdio' }); // user's survives
    });
  });

  describe('config-keys array-element inject + remove-by-value', () => {
    const storePath = '/store/writing/instructions/base.md';

    it('injects into an array and removes by value even after the harness reorders it', async () => {
      const p = paths();
      const f = file('opencode.json');
      writeFileSync(f, '{\n  "instructions": ["AGENTS.md", "docs/rules.md"],\n  "model": "sonnet"\n}\n');

      const item = await inTx(p, (tx) =>
        injectArrayElement(p, tx, {
          file: f,
          format: 'json',
          arrayPath: ['instructions'],
          value: storePath,
          ownerEnv: 'writing',
        }),
      );
      expect(item).toMatchObject({ mode: 'array-element', keyPath: ['instructions'], value: storePath });
      expect(JSON.parse(readFileSync(f, 'utf8')).instructions).toContain(storePath);

      // The harness reorders the array (our value moves to the front).
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      doc.instructions = [storePath, 'AGENTS.md', 'docs/rules.md'];
      writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');

      // Removal still finds our value by identity, regardless of position.
      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      const instructions = JSON.parse(readFileSync(f, 'utf8')).instructions;
      expect(instructions).toEqual(['AGENTS.md', 'docs/rules.md']); // ours gone, user's order kept
    });

    it('is idempotent on re-injection and a no-op with a note when the value is already absent', async () => {
      const p = paths();
      const f = file('opencode.json');
      writeFileSync(f, '{\n  "instructions": ["AGENTS.md"]\n}\n');

      const req = {
        file: f,
        format: 'json' as const,
        arrayPath: ['instructions'],
        value: storePath,
        ownerEnv: 'writing',
      };
      const item = await inTx(p, (tx) => injectArrayElement(p, tx, req));
      // Re-injecting the same value does not duplicate it.
      await inTx(p, (tx) => injectArrayElement(p, tx, req));
      const arr = JSON.parse(readFileSync(f, 'utf8')).instructions;
      expect(arr.filter((v: string) => v === storePath)).toHaveLength(1);

      // First removal succeeds; a second removal of the now-absent value is a
      // logged no-op, not an error.
      const first = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(first.removed).toBe(true);
      const second = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(second).toMatchObject({ removed: false, reason: 'absent' });
      expect(second.note).toMatch(/absent/);
    });
  });
});

/** Cheap comment stripper so tests can JSON.parse a JSONC document. */
function stripComments(jsonc: string): string {
  return jsonc.replace(/^\s*\/\/.*$/gm, '');
}
