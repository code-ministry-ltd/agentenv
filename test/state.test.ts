import { readdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import {
  STATE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION_STRING,
  StateError,
  addItem,
  emptyManifest,
  findItemsByEnv,
  findOwner,
  findOwners,
  readState,
  removeItem,
  writeState,
  type ManifestItem,
} from '../src/state.js';
import { expectRealHomeUntouched, makeTempHome, guardRealHome } from './helpers.js';

function symlinkItem(over: Partial<ManifestItem> = {}): ManifestItem {
  return {
    action: 'symlink',
    surface: 'dir-merge',
    path: '/home/u/.claude/skills/research',
    ownerEnv: 'work',
    backupRef: { kind: 'absent' },
    ...over,
  } as ManifestItem;
}

describe('state manifest', () => {
  let temp: ReturnType<typeof makeTempHome>;
  let realBefore: ReturnType<typeof guardRealHome>;

  beforeEach(() => {
    realBefore = guardRealHome();
    temp = makeTempHome();
  });

  afterEach(() => {
    temp.cleanup();
    expectRealHomeUntouched(realBefore);
  });

  const paths = () => resolvePaths(temp.env);

  describe('read/write', () => {
    it('returns a fresh empty manifest when state.json does not exist', async () => {
      const manifest = await readState(paths());
      expect(manifest).toEqual({
        version: STATE_SCHEMA_VERSION_STRING,
        items: [],
        journal: null,
        commands: [],
        generations: [],
        globalProjections: [],
        projectionRecords: [],
        candidates: [],
        quarantine: [],
        migration: null,
      });
    });

    it('round-trips items through write then read', async () => {
      const p = paths();
      const manifest = emptyManifest();
      addItem(manifest, symlinkItem());
      addItem(manifest, symlinkItem({ path: '/home/u/.claude/skills/writing', ownerEnv: 'writing' }));
      await writeState(p, manifest);

      const reloaded = await readState(p);
      expect(reloaded.items).toHaveLength(2);
      expect(reloaded.items[0]).toMatchObject({ surface: 'dir-merge', ownerEnv: 'work' });
    });

    it('writes atomically, leaving no temp debris beside state.json', async () => {
      const p = paths();
      await writeState(p, emptyManifest());
      const entries = readdirSync(p.base);
      expect(entries).toContain('state.json');
      expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
    });

    it('stamps the current CLI schema version on write', async () => {
      const p = paths();
      const manifest = emptyManifest();
      manifest.version = '1.0'; // regardless of what the caller holds
      await writeState(p, manifest);
      const reloaded = await readState(p);
      expect(reloaded.version).toBe(STATE_SCHEMA_VERSION_STRING);
    });

    it('reads CM v1 state into v2 defaults and upgrades it only on write', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: '1.0',
          items: [symlinkItem()],
          globalStack: ['work'],
        }),
      );

      const legacy = await readState(p);
      expect(legacy.version).toBe('1.0');
      expect(legacy.commands).toEqual([]);
      expect(legacy.generations).toEqual([]);
      expect(legacy.globalStack).toEqual(['work']);

      await writeState(p, legacy);
      expect((await readState(p)).version).toBe(STATE_SCHEMA_VERSION_STRING);
    });

    it('omits an empty journal from disk', async () => {
      const p = paths();
      await writeState(p, emptyManifest());
      const reloaded = await readState(p);
      expect(reloaded.journal).toBeNull();
    });
  });

  describe('version tolerance (behaves like env.yaml)', () => {
    it('accepts a newer MINOR and preserves unknown fields', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: `${STATE_SCHEMA_VERSION.major}.${STATE_SCHEMA_VERSION.minor + 7}`,
          items: [],
          futureTopLevel: { anything: true },
        }),
      );
      const manifest = await readState(p);
      expect(manifest.version).toBe(`${STATE_SCHEMA_VERSION.major}.${STATE_SCHEMA_VERSION.minor + 7}`);
      expect(manifest['futureTopLevel']).toEqual({ anything: true });
    });

    it('preserves unknown fields through a write (round-trip)', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({ version: STATE_SCHEMA_VERSION_STRING, items: [], futureTopLevel: 7 }),
      );
      const manifest = await readState(p);
      await writeState(p, manifest);
      const reloaded = await readState(p);
      expect(reloaded['futureTopLevel']).toBe(7);
    });

    it('rejects a newer MAJOR with an upgrade message, not a schema error', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({ version: `${STATE_SCHEMA_VERSION.major + 1}.0`, items: [] }),
      );
      await expect(readState(p)).rejects.toThrow(/state newer than CLI — upgrade agentenv/);
    });

    it('rejects corrupt JSON with a clear error naming the file', async () => {
      const p = paths();
      writeFileSync(p.state, '{ this is not: valid json');
      let thrown: unknown;
      try {
        await readState(p);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StateError);
      expect((thrown as StateError).message).toMatch(/corrupt state\.json/);
      expect((thrown as StateError).file).toBe(p.state);
    });

    it('rejects a missing version field', async () => {
      const p = paths();
      writeFileSync(p.state, JSON.stringify({ items: [] }));
      await expect(readState(p)).rejects.toThrow(/version/);
    });

    it('rejects a non-object top level', async () => {
      const p = paths();
      writeFileSync(p.state, JSON.stringify(['a', 'list']));
      await expect(readState(p)).rejects.toBeInstanceOf(StateError);
    });
  });

  describe('journal validation on read', () => {
    const goodItem = { action: 'symlink', surface: 'dir-merge', path: '/x', ownerEnv: 'w' };
    const goodUndo = { path: '/x', backupRef: { kind: 'absent' } };

    it('rejects a malformed journal entry with a StateError naming the file', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          journal: [{ op: 'frobnicate', item: goodItem, undo: goodUndo }],
        }),
      );
      let thrown: unknown;
      try {
        await readState(p);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StateError);
      expect((thrown as StateError).message).toMatch(/journal.*op/i);
      expect((thrown as StateError).file).toBe(p.state);
    });

    it('rejects a journal entry whose undo lacks a backupRef', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          journal: [{ op: 'add', item: goodItem, undo: { path: '/x' } }],
        }),
      );
      await expect(readState(p)).rejects.toThrow(/undo\.backupRef/i);
    });

    it('rejects a journal entry that is not an object', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({ version: STATE_SCHEMA_VERSION_STRING, items: [], journal: ['nope'] }),
      );
      await expect(readState(p)).rejects.toBeInstanceOf(StateError);
    });

    it('accepts a well-formed pending journal', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          journal: [{ op: 'add', item: goodItem, undo: goodUndo }],
        }),
      );
      const manifest = await readState(p);
      expect(manifest.journal).toHaveLength(1);
    });
  });

  describe('schema-v2 lifecycle validation', () => {
    function durableCommand(operation: Record<string, unknown>): Record<string, unknown> {
      return {
        schemaVersion: 2,
        transactionId: 'tx',
        kind: 'staged-command',
        phase: 'applying',
        commitPoint: false,
        operations: [{ state: 'applied', ...operation }],
      };
    }

    it('rejects a malformed durable command before it can reach a mutating path', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          commands: [{
            schemaVersion: 2,
            transactionId: 'tx',
            kind: 'activate-global',
            phase: 'teleported',
            commitPoint: false,
            operations: [],
          }],
        }),
      );

      await expect(readState(p)).rejects.toThrow(/commands.*phase/i);
    });

    it('rejects a lifecycle record from a different schema major', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          candidates: [{ schemaVersion: 3, id: 'candidate-1' }],
        }),
      );

      await expect(readState(p)).rejects.toThrow(/candidates.*schemaVersion/i);
    });

    it('rejects malformed nested lease and inventory fields', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          generations: [{
            schemaVersion: 2,
            id: 'generation-1',
            envs: ['work'],
            phase: 'published',
            reservations: [],
            leases: [{ reservationId: 'lease', pid: 'not-a-pid', processGroupId: 2, processStart: 'x' }],
            inventory: [{
              surfaceId: 'skills',
              storeKind: 'skills',
              mechanism: 'dir-merge',
              path: '/view/skills',
              baseline: ['one'],
              ownerEnv: 'work',
            }],
          }],
        }),
      );

      await expect(readState(p)).rejects.toThrow(/generations.*lease.*pid/i);
    });

    it('rejects malformed nested command identities before WAL recovery', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          commands: [{
            schemaVersion: 2,
            transactionId: 'tx',
            kind: 'filesystem-bundle',
            phase: 'applying',
            commitPoint: false,
            operations: [{
              id: 'effect',
              kind: 'replace-path',
              state: 'applied',
              path: '/target',
              preIdentity: { kind: 'file', digest: 42, mode: 420 },
              postIdentity: { kind: 'absent' },
            }],
          }],
        }),
      );

      await expect(readState(p)).rejects.toThrow(/commands.*preIdentity/i);
    });

    it.each([
      [
        'free readOnly rollback suppression',
        {
          id: 'mutator',
          kind: 'replace-path',
          readOnly: true,
          path: '/target',
          preIdentity: { kind: 'absent' },
          postIdentity: { kind: 'absent' },
          undoRef: 'mutating undo metadata',
        },
        /commands.*readOnly/i,
      ],
      [
        'a read precondition without a path',
        {
          id: 'source',
          kind: 'read-path-precondition',
          preIdentity: { kind: 'absent' },
          postIdentity: { kind: 'absent' },
          undoRef: JSON.stringify({
            schemaVersion: 1,
            type: 'path-precondition',
            expectedIdentity: { kind: 'absent' },
          }),
        },
        /commands.*requires.*path/i,
      ],
      [
        'a read precondition whose identities differ',
        {
          id: 'source',
          kind: 'read-path-precondition',
          path: '/source',
          preIdentity: { kind: 'absent' },
          postIdentity: { kind: 'symlink', target: 'replacement' },
          undoRef: JSON.stringify({
            schemaVersion: 1,
            type: 'path-precondition',
            expectedIdentity: { kind: 'absent' },
          }),
        },
        /commands.*identical preIdentity and postIdentity/i,
      ],
      [
        'a read precondition with mismatched undo metadata',
        {
          id: 'source',
          kind: 'read-path-precondition',
          path: '/source',
          preIdentity: { kind: 'absent' },
          postIdentity: { kind: 'absent' },
          undoRef: JSON.stringify({
            schemaVersion: 1,
            type: 'path-precondition',
            expectedIdentity: { kind: 'symlink', target: 'replacement' },
          }),
        },
        /commands.*undo metadata.*expectedIdentity/i,
      ],
      [
        'path-precondition undo metadata attached to a mutator',
        {
          id: 'mutator',
          kind: 'replace-path',
          path: '/target',
          preIdentity: { kind: 'absent' },
          postIdentity: { kind: 'absent' },
          undoRef: JSON.stringify({
            schemaVersion: 1,
            type: 'path-precondition',
            expectedIdentity: { kind: 'absent' },
          }),
        },
        /commands.*path-precondition undo metadata.*read-path-precondition/i,
      ],
    ] as const)('rejects a command containing %s', async (_label, operation, expected) => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          commands: [durableCommand(operation)],
        }),
      );

      await expect(readState(p)).rejects.toThrow(expected);
    });

    it('rejects duplicate durable command operation ids', async () => {
      const p = paths();
      const operation = {
        id: 'duplicate',
        kind: 'replace-path',
        path: '/target',
        preIdentity: { kind: 'absent' },
        postIdentity: { kind: 'absent' },
      };
      const command = durableCommand(operation);
      command.operations = [
        { state: 'applied', ...operation },
        { state: 'pending', ...operation, path: '/other-target' },
      ];
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          commands: [command],
        }),
      );

      await expect(readState(p)).rejects.toThrow(/duplicate.*operation id/i);
    });

    it('rejects invalid projection identities and non-string candidate blockers', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          globalProjections: [{
            schemaVersion: 2,
            id: 'projection-1',
            phase: 'active',
            baseline: { kind: 'teleported' },
            observed: { kind: 'absent' },
          }],
        }),
      );
      await expect(readState(p)).rejects.toThrow(/globalProjections.*baseline/i);

      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          candidates: [{
            schemaVersion: 2,
            id: 'candidate-1',
            ref: 'refs/candidate',
            worktree: '/candidate',
            fetchedAt: 1,
            touchedCanonicalPaths: ['environments/work/env.yaml'],
            phase: 'deferred',
            blockers: [7],
            reason: null,
            promotedRevision: null,
            expectedCanonicalRevision: 'abc',
            candidateRevision: 'def',
          }],
        }),
      );
      await expect(readState(p)).rejects.toThrow(/candidates.*blockers/i);
    });

    it('rejects incomplete quarantine and migration metadata', async () => {
      const p = paths();
      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          quarantine: [{
            schemaVersion: 2,
            id: 'rescue',
            kind: 'third-identity',
            path: '/surface',
            retainedPath: '/retained',
            reason: 'reason',
            createdAt: 'yesterday',
            resolved: false,
          }],
        }),
      );
      await expect(readState(p)).rejects.toThrow(/quarantine.*createdAt/i);

      writeFileSync(
        p.state,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION_STRING,
          items: [],
          migration: {
            schemaVersion: 2,
            id: 'migration',
            sourceFormat: 'invented-v1',
            phase: 'planned',
            gate: 'closed',
            commitPoint: false,
            backupRef: null,
            failure: null,
          },
        }),
      );
      await expect(readState(p)).rejects.toThrow(/migration.*sourceFormat/i);
    });
  });

  describe('query + mutation helpers', () => {
    it('finds who owns a path', () => {
      const manifest = emptyManifest();
      addItem(manifest, symlinkItem({ path: '/x/a', ownerEnv: 'work' }));
      addItem(manifest, symlinkItem({ path: '/x/b', ownerEnv: 'writing' }));

      expect(findOwner(manifest, '/x/b')?.ownerEnv).toBe('writing');
      expect(findOwner(manifest, '/x/missing')).toBeUndefined();
    });

    it('finds all owners of a shared path (config-keys share a file)', () => {
      const manifest = emptyManifest();
      addItem(manifest, {
        action: 'config-key',
        surface: 'config-keys',
        path: '/home/u/.claude.json',
        key: 'mcpServers.github',
        ownerEnv: 'work',
      } as ManifestItem);
      addItem(manifest, {
        action: 'config-key',
        surface: 'config-keys',
        path: '/home/u/.claude.json',
        key: 'mcpServers.linear',
        ownerEnv: 'work',
      } as ManifestItem);

      expect(findOwners(manifest, '/home/u/.claude.json')).toHaveLength(2);
      // Distinct identities (different key) => two records, not an upsert.
      expect(manifest.items).toHaveLength(2);
    });

    it('upserts by identity: same surface+path+key replaces, updating fields', () => {
      const manifest = emptyManifest();
      addItem(manifest, symlinkItem({ path: '/x/a', hash: 'old' }));
      addItem(manifest, symlinkItem({ path: '/x/a', hash: 'new' }));

      expect(manifest.items).toHaveLength(1);
      expect((manifest.items[0] as { hash?: string }).hash).toBe('new');
    });

    it('removes a record by identity and reports whether one was removed', () => {
      const manifest = emptyManifest();
      addItem(manifest, symlinkItem({ path: '/x/a' }));

      expect(removeItem(manifest, symlinkItem({ path: '/x/a' }))).toBe(true);
      expect(manifest.items).toHaveLength(0);
      // Removing again is a safe no-op.
      expect(removeItem(manifest, symlinkItem({ path: '/x/a' }))).toBe(false);
    });

    it('lists all items owned by an environment', () => {
      const manifest = emptyManifest();
      addItem(manifest, symlinkItem({ path: '/x/a', ownerEnv: 'work' }));
      addItem(manifest, symlinkItem({ path: '/x/b', ownerEnv: 'work' }));
      addItem(manifest, symlinkItem({ path: '/x/c', ownerEnv: 'writing' }));

      expect(findItemsByEnv(manifest, 'work')).toHaveLength(2);
      expect(findItemsByEnv(manifest, 'writing')).toHaveLength(1);
    });
  });
});
