import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigKeysError,
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

    // B1 (REQUIRED): injecting into a MISSING parent creates it; removal must prune
    // that created parent (while still empty) so the cycle is byte-identical — no
    // orphaned "mcpServers": {} left in the user's file.
    it('prunes a parent it created on inject so remove is byte-identical', async () => {
      const p = paths();
      const f = file('claude.json');
      const original = '{\n  "theme": "dark"\n}\n'; // no mcpServers parent
      writeFileSync(f, original);

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'json',
          keyPath: ['mcpServers', 'linear'],
          value: { transport: 'http' },
          ownerEnv: 'writing',
        }),
      );
      // Inject really created the missing parent.
      expect(JSON.parse(readFileSync(f, 'utf8')).mcpServers.linear).toEqual({ transport: 'http' });

      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      // Created-and-now-empty parent pruned → byte-for-byte the user's original.
      expect(readFileSync(f, 'utf8')).toBe(original);
    });

    // The byte-identity claim was only ever proven for ONE 2-space plain-JSON file.
    // `pruneCreatedParents` re-parses and re-modifies the text a SECOND time, which is a
    // second chance to diverge — and JSONC is where a re-serialising editor shows itself.
    it('is byte-identical on JSONC with comments, trailing commas and tab indentation', async () => {
      const p = paths();
      const f = file('mcp.jsonc');
      const original =
        '{\n' +
        "\t// the user's own MCP set — comments MUST survive\n" +
        '\t"servers": {\n' +
        '\t\t/* block comment */\n' +
        '\t\t"mine": { "command": "x" },\n' +
        '\t},\n' +
        '\t"theme": "dark",\n' +
        '}\n';
      writeFileSync(f, original);

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'jsonc',
          keyPath: ['servers', 'ours'],
          value: { command: 'y' },
          ownerEnv: 'writing',
        }),
      );
      const afterInject = readFileSync(f, 'utf8');
      expect(afterInject).toContain('comments MUST survive');
      expect(afterInject).toContain('/* block comment */');

      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe(original);
    });

    // Same, but through the created-parent PRUNE path (the second re-modify).
    it('is byte-identical on JSONC when the inject had to CREATE the parent', async () => {
      const p = paths();
      const f = file('mcp2.jsonc');
      const original = '{\n  // keep me\n  "theme": "dark",\n}\n'; // no `servers` parent
      writeFileSync(f, original);

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'jsonc',
          keyPath: ['servers', 'ours'],
          value: { command: 'y' },
          ownerEnv: 'writing',
        }),
      );
      expect(item.createdParents).toBe(1);

      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe(original);
    });

    // F5/10: the byte-identity guarantee is about a file that EXISTS. When the target
    // file was absent, inject CREATES it and removal cannot un-create it — an empty `{}`
    // is left where the user had no file. Pinned here so the limitation stays visible
    // rather than being implied away by the "byte-identical" wording.
    it('leaves an empty {} behind when the target file did not exist (documented gap)', async () => {
      const p = paths();
      const f = file('created-by-us.json');
      expect(existsSync(f)).toBe(false);

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'json',
          keyPath: ['mcpServers', 'ours'],
          value: { command: 'y' },
          ownerEnv: 'writing',
        }),
      );
      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);

      // The file still exists, holding an empty object — NOT the pre-inject state (no
      // file at all). Harmless for every current adapter (their config files all exist
      // already), but it is not "byte-identical", and the docstrings must not say so.
      expect(existsSync(f)).toBe(true);
      expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({});
    });

    it('does NOT prune a parent the user already owned as an empty {}', async () => {
      const p = paths();
      const f = file('claude.json');
      const original = '{\n  "mcpServers": {},\n  "theme": "dark"\n}\n'; // user's own empty {}
      writeFileSync(f, original);

      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'json',
          keyPath: ['mcpServers', 'linear'],
          value: { transport: 'http' },
          ownerEnv: 'writing',
        }),
      );
      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      // The user's pre-existing empty object survives — we only prune what we made.
      expect(readFileSync(f, 'utf8')).toBe(original);
    });

    // C2 (NIT): the key discriminator joined segments with "." unescaped, so
    // ['a.b','c'] and ['a','b','c'] both rendered "a.b.c" — one manifest identity
    // for two DISTINCT key paths, so the second silently clobbered the first.
    it('gives distinct key paths distinct ownership identities (no discriminator aliasing)', async () => {
      const p = paths();
      const f = file('claude.json');
      writeFileSync(f, '{}\n');

      const dotted = await inTx(p, (tx) =>
        injectKeyed(p, tx, { file: f, format: 'json', keyPath: ['a.b', 'c'], value: 1, ownerEnv: 'w' }),
      );
      const nested = await inTx(p, (tx) =>
        injectKeyed(p, tx, { file: f, format: 'json', keyPath: ['a', 'b', 'c'], value: 2, ownerEnv: 'w' }),
      );

      expect(dotted.key).not.toBe(nested.key); // distinct discriminators
      const owners = findOwners(await readState(p), f);
      expect(owners).toHaveLength(2); // both tracked — neither clobbered the other
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

    // A1 (CRITICAL): after a harness reserialised the TOML (markers stripped, our
    // table now UNMARKED beside the user's), a drift write-back must not append a
    // SECOND [mcp_servers.linear] table — that is invalid TOML ("redefine an
    // already defined table") — and must scrub any baked secret literal.
    it('syncBack write-back after a reserialised TOML stays valid (no duplicate table)', async () => {
      const p = paths();
      const f = file('config.toml');
      writeFileSync(f, originalToml);
      const item = await injectLinearToml(p, f);

      // Harness reserialises: parse → stringify drops our markers, leaving an
      // UNMARKED [mcp_servers.linear] beside the user's github table.
      const reserialised = stringifyToml(parseToml(readFileSync(f, 'utf8')));
      writeFileSync(f, reserialised);
      expect(reserialised).not.toContain('agentenv:config-key');

      // The value drifts (user/harness edits it in place).
      const doc = parseToml(readFileSync(f, 'utf8')) as { mcp_servers: Record<string, unknown> };
      doc.mcp_servers.linear = { transport: 'ws' };
      writeFileSync(f, stringifyToml(doc));

      const synced = await inTx(p, (tx) => syncBack(p, tx, item));
      expect(synced.drifted).toBe(true);

      const after = readFileSync(f, 'utf8');
      // Valid TOML: parsing threw "redefine an already defined table" before the fix.
      const parsed = parseToml(after) as { mcp_servers: Record<string, unknown> };
      expect(parsed.mcp_servers.linear).toEqual({ transport: 'ws' });
      expect(parsed.mcp_servers.github).toEqual({ transport: 'stdio' }); // sibling untouched
      // Exactly one linear table header — the drifted table was replaced, not doubled.
      expect(after.match(/\[mcp_servers\.linear\]/g)).toHaveLength(1);
    });

    it('syncBack scrubs a baked secret from a reserialised TOML, restoring the placeholder', async () => {
      const p = paths();
      const f = file('config.toml');
      writeFileSync(f, originalToml);
      const item = await inTx(p, (tx) =>
        injectKeyed(p, tx, {
          file: f,
          format: 'toml',
          keyPath: ['mcp_servers', 'ghsecret'],
          value: { transport: 'stdio', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
          ownerEnv: 'writing',
          secretFields: { 'env.GITHUB_TOKEN': '${GITHUB_TOKEN}' },
        }),
      );

      // Harness reserialises (markers gone), then bakes a real token over the placeholder.
      writeFileSync(f, stringifyToml(parseToml(readFileSync(f, 'utf8'))));
      const doc = parseToml(readFileSync(f, 'utf8')) as {
        mcp_servers: { ghsecret: { transport: string; env: Record<string, string> } };
      };
      doc.mcp_servers.ghsecret.env.GITHUB_TOKEN = 'ghp_REALSECRET123';
      writeFileSync(f, stringifyToml(doc));

      const synced = await inTx(p, (tx) => syncBack(p, tx, item));
      expect(synced.drifted).toBe(true);

      const after = readFileSync(f, 'utf8');
      expect(() => parseToml(after)).not.toThrow(); // valid TOML
      expect(after).not.toContain('ghp_REALSECRET123'); // literal scrubbed from the FILE
      expect(after).toContain('${GITHUB_TOKEN}'); // placeholder restored
      expect(JSON.stringify(synced.canonicalValue)).not.toContain('ghp_REALSECRET123');
    });

    // C1 (NIT): the marker-splice removal previously always re-emitted a trailing
    // newline, so a file the user wrote WITHOUT one did not round-trip. Inject must
    // preserve the original's trailing-newline state so removal is byte-identical.
    it('preserves a no-trailing-newline TOML file across an inject+remove round-trip', async () => {
      const p = paths();
      const f = file('config.toml');
      const original = '[mcp_servers.github]\ntransport = "stdio"'; // NO trailing newline
      writeFileSync(f, original);

      const item = await injectLinearToml(p, f);
      const removed = await inTx(p, (tx) => removeKey(p, tx, item));
      expect(removed.removed).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe(original); // trailing-newline state intact
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

  // B2 (REQUIRED): injecting a keyed value over a pre-existing NON-owned value/table
  // must REFUSE — never silently overwrite a user's JSON key (a later removal would
  // then delete it) nor emit a doubled [table] in TOML (invalid). Skip/force policy
  // is the engine's (1.7) call; this module's job is to refuse rather than corrupt.
  describe('config-keys keyed inject collision refusal', () => {
    it('refuses a JSON inject over a pre-existing non-owned key (no silent overwrite)', async () => {
      const p = paths();
      const f = file('claude.json');
      const original = '{\n  "mcpServers": {\n    "linear": { "transport": "stdio" }\n  }\n}\n';
      writeFileSync(f, original);

      await expect(
        inTx(p, (tx) =>
          injectKeyed(p, tx, {
            file: f,
            format: 'json',
            keyPath: ['mcpServers', 'linear'],
            value: { transport: 'http' },
            ownerEnv: 'writing',
          }),
        ),
      ).rejects.toBeInstanceOf(ConfigKeysError);

      // The user's key is untouched and nothing was committed to the manifest.
      expect(readFileSync(f, 'utf8')).toBe(original);
      expect(findOwners(await readState(p), f)).toHaveLength(0);
    });

    it('refuses a TOML inject over a pre-existing non-owned table (no invalid TOML)', async () => {
      const p = paths();
      const f = file('config.toml');
      const original = '[mcp_servers.linear]\ntransport = "stdio"\n';
      writeFileSync(f, original);

      await expect(
        inTx(p, (tx) =>
          injectKeyed(p, tx, {
            file: f,
            format: 'toml',
            keyPath: ['mcp_servers', 'linear'],
            value: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
            ownerEnv: 'writing',
          }),
        ),
      ).rejects.toBeInstanceOf(ConfigKeysError);

      // The user's file is left byte-for-byte intact (no doubled table written).
      expect(readFileSync(f, 'utf8')).toBe(original);
      expect(findOwners(await readState(p), f)).toHaveLength(0);
    });
  });
});

/** Cheap comment stripper so tests can JSON.parse a JSONC document. */
function stripComments(jsonc: string): string {
  return jsonc.replace(/^\s*\/\/.*$/gm, '');
}
