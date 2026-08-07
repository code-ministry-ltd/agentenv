import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyContent } from '../src/application/content-transfer.js';
import { createContentTransferRuntime } from '../src/application/content-transfer-runtime.js';
import type {
  ContentTransferPublicationRequest,
  ContentTransferRuntime,
} from '../src/application/content-transfer-runtime.js';
import { parseEnvConfig } from '../src/env-config.js';
import { resolvePaths } from '../src/paths.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { advanceCommand, createCommandPlan } from '../src/command-plan.js';
import { emptyManifest, readState, writeState } from '../src/state.js';
import { recoverPendingStagedCommands } from '../src/staged-command.js';
import { makeTempHome, type TempHome } from './helpers.js';
import { isAlias, isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';

const homes: TempHome[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
});

function seedCommandTransfer(paths: ReturnType<typeof resolvePaths>): void {
  for (const environment of ['source', 'destination']) {
    mkdirSync(paths.envDir(environment), { recursive: true });
    writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
  }
  mkdirSync(join(paths.envDir('source'), 'commands'));
  writeFileSync(join(paths.envDir('source'), 'commands', 'safe.md'), 'source bytes\n');
}

describe('content transfer copy', () => {
  it('copies one skill exactly and independently between environments', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const sourceSkill = join(paths.envDir('source'), 'skills', 'thinking-partner');
    mkdirSync(sourceSkill, { recursive: true });
    writeFileSync(join(sourceSkill, 'SKILL.md'), '---\nname: thinking-partner\n---\nsource bytes\n');

    const result = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'thinking-partner' },
      destination: { kind: 'skill', environment: 'destination', name: 'thinking-partner' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'copied',
      kind: 'skill',
      name: 'thinking-partner',
    });
    const copied = join(paths.envDir('destination'), 'skills', 'thinking-partner', 'SKILL.md');
    expect(readFileSync(copied, 'utf8')).toBe(readFileSync(join(sourceSkill, 'SKILL.md'), 'utf8'));
    writeFileSync(copied, 'destination mutation\n');
    expect(readFileSync(join(sourceSkill, 'SKILL.md'), 'utf8')).toContain('source bytes');
  });

  it.each([
    { sourceRecord: true, expected: 'source' },
    { sourceRecord: false, expected: 'absent' },
  ] as const)(
    'makes destination skill provenance $expected without changing source metadata',
    async ({ sourceRecord, expected }) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      const record = [
        '    repo: owner/repo',
        '    path: skills/research',
        '    ref: main',
        '    commit: abcdef123456',
        '    hash: deadbeef',
      ].join('\n');
      const sourceYaml = [
        'version: "1.0"',
        'description: source',
        ...(sourceRecord ? ['sources:', '  research:', record] : []),
        '',
      ].join('\n');
      const destinationYaml = [
        'version: "1.0"',
        'description: destination',
        'sources:',
        '  research:',
        '    repo: stale/repo',
        '    path: old',
        '    ref: old',
        '    commit: old',
        '    hash: old',
        '  unrelated:',
        record,
        '',
      ].join('\n');
      for (const [environment, yaml] of [
        ['source', sourceYaml],
        ['destination', destinationYaml],
      ] as const) {
        mkdirSync(paths.envDir(environment), { recursive: true });
        writeFileSync(paths.envYaml(environment), yaml);
      }
      const skill = join(paths.envDir('source'), 'skills', 'research');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: research\n---\nsource\n');

      const result = await copyContent({
        paths,
        source: { kind: 'skill', environment: 'source', name: 'research' },
        destination: { kind: 'skill', environment: 'destination', name: 'research' },
        runtime: createContentTransferRuntime({ paths }),
      });

      expect(result.status, JSON.stringify(result)).toBe('copied');
      expect(readFileSync(paths.envYaml('source'), 'utf8')).toBe(sourceYaml);
      const destination = parseEnvConfig(
        readFileSync(paths.envYaml('destination'), 'utf8'),
        paths.envYaml('destination'),
      );
      expect(destination.sources?.unrelated).toBeDefined();
      if (expected === 'source') {
        expect(destination.sources?.research).toEqual(
          parseEnvConfig(sourceYaml, paths.envYaml('source')).sources?.research,
        );
      } else {
        expect(destination.sources?.research).toBeUndefined();
      }
    },
  );

  it('preserves the selected skill provenance AST and unrelated destination presentation', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const sourceYaml = [
      'version: "1.0"',
      'description: source',
      'sources:',
      '  research: !!map { repo: "owner/repo", path: \'skills/research\', ref: main, commit: abc123, hash: deadbeef, future: &opts [one, "two"], mirror: *opts } # exact provenance',
      '',
    ].join('\n');
    const destinationYaml = [
      '# destination header',
      'version: "1.0"',
      'description: destination',
      'sources:',
      '  unrelated: { repo: "keep/repo", path: \'keep\', ref: main, commit: keep, hash: keep } # byte stable',
      '  research: { repo: stale/repo, path: stale, ref: stale, commit: stale, hash: stale } # replace',
      '',
    ].join('\n');
    for (const [environment, yaml] of [
      ['source', sourceYaml],
      ['destination', destinationYaml],
    ] as const) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), yaml);
    }
    const skill = join(paths.envDir('source'), 'skills', 'research');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: research\n---\nsource\n');

    const result = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'research' },
      destination: { kind: 'skill', environment: 'destination', name: 'research' },
      collision: 'overwrite',
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status, JSON.stringify(result)).toBe('copied');
    expect(readFileSync(paths.envYaml('source'), 'utf8')).toBe(sourceYaml);
    const copiedText = readFileSync(paths.envYaml('destination'), 'utf8');
    expect(copiedText).toContain(
      '  unrelated: { repo: "keep/repo", path: \'keep\', ref: main, commit: keep, hash: keep } # byte stable\n',
    );
    const copiedNode = parseDocument(copiedText).getIn(['sources', 'research'], true);
    expect(isMap(copiedNode)).toBe(true);
    if (!isMap(copiedNode)) throw new Error('copied provenance is not a YAML map');
    expect(copiedNode).toMatchObject({
      flow: true,
      tag: 'tag:yaml.org,2002:map',
      comment: ' exact provenance',
    });
    const repo = copiedNode.get('repo', true);
    const path = copiedNode.get('path', true);
    const future = copiedNode.get('future', true);
    const mirror = copiedNode.get('mirror', true);
    expect(isScalar(repo) && repo.type).toBe('QUOTE_DOUBLE');
    expect(isScalar(path) && path.type).toBe('QUOTE_SINGLE');
    expect(isSeq(future) && future.flow).toBe(true);
    expect(isSeq(future) && future.anchor).toBe('opts');
    expect(isAlias(mirror) && mirror.source).toBe('opts');
    expect(copiedNode.items.map((item) => isScalar(item.key) ? item.key.value : undefined)).toEqual([
      'repo', 'path', 'ref', 'commit', 'hash', 'future', 'mirror',
    ]);
  });

  it('removes stale unprovenanced skill metadata without rewriting unrelated YAML', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const sourceYaml = 'version: "1.0"\ndescription: source\n';
    const destinationYaml = [
      '# destination header',
      'version: "1.0"',
      'description: destination',
      'sources:',
      '  unrelated: { repo: "keep/repo", future: [ one, "two" ] } # byte stable',
      '  research: !!map { repo: stale/repo, path: stale, ref: stale, commit: stale, hash: stale, unknown: tagged } # remove all',
      '',
    ].join('\n');
    mkdirSync(paths.envDir('source'), { recursive: true });
    mkdirSync(paths.envDir('destination'), { recursive: true });
    writeFileSync(paths.envYaml('source'), sourceYaml);
    writeFileSync(paths.envYaml('destination'), destinationYaml);
    const skill = join(paths.envDir('source'), 'skills', 'research');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: research\n---\nsource\n');

    const result = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'research' },
      destination: { kind: 'skill', environment: 'destination', name: 'research' },
      collision: 'overwrite',
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status, JSON.stringify(result)).toBe('copied');
    expect(readFileSync(paths.envYaml('source'), 'utf8')).toBe(sourceYaml);
    expect(readFileSync(paths.envYaml('destination'), 'utf8')).toBe([
      '# destination header',
      'version: "1.0"',
      'description: destination',
      'sources:',
      '  unrelated: { repo: "keep/repo", future: [ one, "two" ] } # byte stable',
      '',
    ].join('\n'));
  });

  it('rejects invalid locators before constructing store paths', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const runtime = createContentTransferRuntime({ paths });

    const invalidEnvironment = await copyContent({
      paths,
      source: { kind: 'command', environment: '../escape', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime,
    });
    const invalidName = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: '../escape' },
      destination: { kind: 'skill', environment: 'destination', name: 'safe' },
      runtime,
    });
    const invalidKind = await copyContent({
      paths,
      source: { kind: 'hostile', environment: 'source', name: 'safe' } as never,
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime,
    });
    const renamed = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'renamed' },
      runtime,
    });
    const invalidCollision = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      collision: 'merge' as never,
      runtime,
    });

    expect(invalidEnvironment).toMatchObject({ status: 'invalid', field: 'source' });
    expect(invalidName).toMatchObject({ status: 'invalid', field: 'source' });
    expect(invalidKind).toMatchObject({ status: 'invalid', field: 'source' });
    expect(renamed).toMatchObject({ status: 'invalid', field: 'destination' });
    expect(invalidCollision).toMatchObject({ status: 'invalid', field: 'destination' });
    expect(existsSync(paths.store)).toBe(false);
  });

  it.each([
    ['source environment', { kind: 'command', environment: 7, name: 'safe' }, 'source'],
    ['source name', { kind: 'command', environment: 'source', name: false }, 'source'],
    ['destination environment', { kind: 'command', environment: {}, name: 'safe' }, 'destination'],
    ['destination name', { kind: 'command', environment: 'destination', name: [] }, 'destination'],
    ['locator kind', { kind: 7, environment: 'source', name: 'safe' }, 'source'],
  ] as const)('returns typed invalid for hostile non-string %s', async (_label, hostile, field) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const result = await copyContent({
      paths,
      source: (field === 'source'
        ? hostile
        : { kind: 'command', environment: 'source', name: 'safe' }) as never,
      destination: (field === 'destination'
        ? hostile
        : { kind: 'command', environment: 'destination', name: 'safe' }) as never,
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result).toMatchObject({ status: 'invalid', field });
    expect(existsSync(paths.store)).toBe(false);
  });

  it('publishes a skill and its provenance as one whole-destination entry with scoped Git paths', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const sourceSkill = join(paths.envDir('source'), 'skills', 'atomic');
    mkdirSync(sourceSkill, { recursive: true });
    writeFileSync(join(sourceSkill, 'SKILL.md'), '---\nname: atomic\n---\nsource\n');
    let publication: ContentTransferPublicationRequest | undefined;
    const runtime: ContentTransferRuntime = {
      open: async () => ({ status: 'ready' }),
      close: async () => {},
      publish: async (request) => {
        publication = request;
        throw new Error('inspection-only publication');
      },
    };

    const result = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'atomic' },
      destination: { kind: 'skill', environment: 'destination', name: 'atomic' },
      runtime,
    });

    expect(result.status).toBe('failure');
    expect(publication?.entries).toHaveLength(1);
    expect(publication?.entries[0]).toMatchObject({
      id: 'destination-environment',
      target: paths.envDir('destination'),
    });
    expect(publication?.gitSteps?.[0]?.paths).toEqual([
      join(paths.envDir('destination'), 'skills', 'atomic'),
      paths.envYaml('destination'),
    ]);
  });

  it.each(['source', 'destination'] as const)(
    'refuses an absent %s environment without creating it',
    async (missing) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      mkdirSync(paths.environments, { recursive: true });
      const present = missing === 'source' ? 'destination' : 'source';
      mkdirSync(paths.envDir(present));
      writeFileSync(paths.envYaml(present), 'version: "1.0"\ndescription: test\n');
      if (present === 'source') {
        mkdirSync(join(paths.envDir(present), 'commands'));
        writeFileSync(join(paths.envDir(present), 'commands', 'safe.md'), 'source\n');
      }

      const result = await copyContent({
        paths,
        source: { kind: 'command', environment: 'source', name: 'safe' },
        destination: { kind: 'command', environment: 'destination', name: 'safe' },
        runtime: createContentTransferRuntime({ paths }),
      });

      expect(result).toEqual({ status: 'not-found', field: missing });
      expect(existsSync(paths.envDir(missing))).toBe(false);
    },
  );

  it('reports an absent source item without staging a destination', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    mkdirSync(join(paths.envDir('source'), 'commands'));

    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'missing' },
      destination: { kind: 'command', environment: 'destination', name: 'missing' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result).toEqual({ status: 'not-found', field: 'source' });
    expect(existsSync(join(paths.envDir('destination'), 'commands'))).toBe(false);
  });

  it('rejects unsafe skill symlinks and destination container symlinks without following them', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const source = join(paths.envDir('source'), 'skills', 'unsafe');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: unsafe\n---\nsource\n');
    const external = join(home.home, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'secret'), 'do not touch\n');
    symlinkSync(join(external, 'secret'), join(source, 'escape'));

    const unsafeSource = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'unsafe' },
      destination: { kind: 'skill', environment: 'destination', name: 'unsafe' },
      runtime: createContentTransferRuntime({ paths }),
    });
    expect(unsafeSource.status).toBe('failure');
    expect(existsSync(join(paths.envDir('destination'), 'skills'))).toBe(false);
    expect(readFileSync(join(external, 'secret'), 'utf8')).toBe('do not touch\n');

    unlinkSync(join(source, 'escape'));
    symlinkSync(external, join(paths.envDir('destination'), 'skills'));
    const unsafeDestination = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'unsafe' },
      destination: { kind: 'skill', environment: 'destination', name: 'unsafe' },
      runtime: createContentTransferRuntime({ paths }),
    });
    expect(unsafeDestination.status).toBe('failure');
    expect(readFileSync(join(external, 'secret'), 'utf8')).toBe('do not touch\n');
  });

  it('maps source, destination, and physical-container races to stale without partial copy', async () => {
    const runRace = async (
      mutate: (paths: ReturnType<typeof resolvePaths>) => void,
    ) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      for (const environment of ['source', 'destination']) {
        mkdirSync(paths.envDir(environment), { recursive: true });
        writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
      }
      mkdirSync(join(paths.envDir('source'), 'commands'));
      writeFileSync(join(paths.envDir('source'), 'commands', 'safe.md'), 'source\n');
      const result = await copyContent({
        paths,
        source: { kind: 'command', environment: 'source', name: 'safe' },
        destination: { kind: 'command', environment: 'destination', name: 'safe' },
        runtime: createContentTransferRuntime({ paths }),
        faults: { afterStage: async () => mutate(paths) },
      });
      return { paths, result };
    };

    const sourceRace = await runRace((paths) => {
      writeFileSync(join(paths.envDir('source'), 'commands', 'safe.md'), 'external source\n');
    });
    expect(sourceRace.result).toMatchObject({ status: 'stale', field: 'source' });
    expect(existsSync(join(sourceRace.paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);

    const destinationRace = await runRace((paths) => {
      mkdirSync(join(paths.envDir('destination'), 'commands'));
      writeFileSync(join(paths.envDir('destination'), 'commands', 'safe.md'), 'external destination\n');
    });
    expect(destinationRace.result).toMatchObject({ status: 'stale', field: 'destination' });
    expect(readFileSync(join(destinationRace.paths.envDir('destination'), 'commands', 'safe.md'), 'utf8')).toBe(
      'external destination\n',
    );

    const containerRace = await runRace((paths) => {
      mkdirSync(join(paths.envDir('destination'), 'commands'));
    });
    expect(containerRace.result).toMatchObject({
      status: 'stale',
      field: 'destination-container',
    });
    expect(existsSync(join(containerRace.paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);
  });

  it('refuses a pre-existing pending recovery before staging', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const manifest = emptyManifest();
    manifest.commands = [createCommandPlan({
      transactionId: 'already-pending',
      kind: 'test',
      operations: [],
    })];
    await writeState(paths, manifest);

    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result).toEqual({ status: 'pending-recovery', transactionId: 'already-pending' });
    expect((await readState(paths)).commands).toHaveLength(1);
  });

  it.each(['before-wal', 'after-apply'] as const)(
    'publishes no destination after an injected %s failure',
    async (point) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      seedCommandTransfer(paths);
      let closes = 0;
      const runtime = createContentTransferRuntime({
        paths,
        close: async () => { closes += 1; },
      });
      const fail = async () => { throw new Error(`injected ${point}`); };

      const result = await copyContent({
        paths,
        source: { kind: 'command', environment: 'source', name: 'safe' },
        destination: { kind: 'command', environment: 'destination', name: 'safe' },
        runtime,
        faults: point === 'before-wal'
          ? { afterStage: fail }
          : { afterApply: fail },
      });

      expect(result.status).toBe('failure');
      expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);
      expect((await readState(paths)).commands).toEqual([]);
      expect(closes).toBe(1);
    },
  );

  it('retains an interrupted pre-commit WAL and recovers to no destination', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let closes = 0;

    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({
        paths,
        close: async () => { closes += 1; },
      }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.phase === 'planned') throw new Error('injected after initial WAL persist');
        },
      },
    });

    expect(result.status).toBe('pending-recovery');
    expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);
    expect((await readState(paths)).commands).toHaveLength(1);
    expect(closes).toBe(0);
    const transactionId = result.status === 'pending-recovery' ? result.transactionId : '';
    expect(existsSync(join(paths.live, 'commands', transactionId))).toBe(true);

    await recoverPendingStagedCommands(paths, undefined, transactionId);
    expect((await readState(paths)).commands).toEqual([]);
    expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);
    expect(existsSync(join(paths.live, 'commands', transactionId))).toBe(false);
  });

  it('reports post-commit failure as git-pending and recovery retains the complete copy', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let closes = 0;

    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({
        paths,
        close: async () => { closes += 1; },
      }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.phase === 'committed') throw new Error('injected after commit point');
        },
      },
    });

    expect(result).toMatchObject({ status: 'git-pending', publication: 'git-pending' });
    expect(readFileSync(join(paths.envDir('destination'), 'commands', 'safe.md'), 'utf8')).toBe(
      'source bytes\n',
    );
    expect((await readState(paths)).commands).toHaveLength(1);
    expect(closes).toBe(0);
    const transactionId = result.status === 'git-pending' ? result.transactionId : '';
    expect(existsSync(join(paths.live, 'commands', transactionId))).toBe(true);

    await recoverPendingStagedCommands(paths, undefined, transactionId);
    expect((await readState(paths)).commands).toEqual([]);
    expect(readFileSync(join(paths.envDir('destination'), 'commands', 'safe.md'), 'utf8')).toBe(
      'source bytes\n',
    );
    expect(existsSync(join(paths.live, 'commands', transactionId))).toBe(false);
  });

  it('closes exactly once on completion and not when open reports pending recovery', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let completeCloses = 0;
    const complete = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({
        paths,
        close: async () => { completeCloses += 1; },
      }),
    });
    expect(complete.status).toBe('copied');
    expect(completeCloses).toBe(1);

    writeFileSync(join(paths.envDir('source'), 'commands', 'other.md'), 'other source\n');
    let pendingCloses = 0;
    const pending = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'other' },
      destination: { kind: 'command', environment: 'destination', name: 'other' },
      runtime: createContentTransferRuntime({
        paths,
        open: async () => ({ status: 'pending-recovery', transactionId: 'from-open' }),
        close: async () => { pendingCloses += 1; },
      }),
    });
    expect(pending).toEqual({ status: 'pending-recovery', transactionId: 'from-open' });
    expect(pendingCloses).toBe(0);
  });

  it.each([
    ['instruction', 'instructions', 'base'],
    ['agent', 'agents', 'reviewer'],
    ['command', 'commands', 'summarize'],
  ] as const)('copies one %s file byte-exactly and independently', async (kind, directory, name) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const source = join(paths.envDir('source'), directory, `${name}.md`);
    mkdirSync(join(paths.envDir('source'), directory), { recursive: true });
    writeFileSync(source, Buffer.from([0, 1, 2, 10, 255]));

    const result = await copyContent({
      paths,
      source: { kind, environment: 'source', name },
      destination: { kind, environment: 'destination', name },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status, JSON.stringify(result)).toBe('copied');
    const destination = join(paths.envDir('destination'), directory, `${name}.md`);
    expect(readFileSync(destination)).toEqual(readFileSync(source));
    writeFileSync(destination, 'destination-only\n');
    expect(readFileSync(source)).toEqual(Buffer.from([0, 1, 2, 10, 255]));
  });

  it('copies exactly one MCP mapping entry while preserving unrelated destination semantics', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(join(paths.envDir(environment), 'mcp'), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const sourcePath = join(paths.envDir('source'), 'mcp', 'servers.yaml');
    const destinationPath = join(paths.envDir('destination'), 'mcp', 'servers.yaml');
    const sourceText = [
      'github:',
      '  transport: stdio',
      '  command: npx',
      '  args: [-y, server-github]',
      'source-only:',
      '  transport: http',
      '  url: https://source.invalid',
      '',
    ].join('\n');
    const destinationText = [
      '# keep this destination comment',
      'unrelated:',
      '  transport: sse',
      '  url: https://destination.invalid',
      '',
    ].join('\n');
    writeFileSync(sourcePath, sourceText);
    writeFileSync(destinationPath, destinationText);

    const result = await copyContent({
      paths,
      source: { kind: 'mcp', environment: 'source', name: 'github' },
      destination: { kind: 'mcp', environment: 'destination', name: 'github' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status, JSON.stringify(result)).toBe('copied');
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceText);
    const copied = readFileSync(destinationPath, 'utf8');
    expect(copied).toContain('# keep this destination comment');
    expect(parseYaml(copied)).toEqual({
      unrelated: { transport: 'sse', url: 'https://destination.invalid' },
      github: { transport: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
    });
    expect(copied).not.toContain('source-only');
  });

  it('copies the selected MCP AST node without rewriting unrelated destination presentation', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(join(paths.envDir(environment), 'mcp'), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const sourcePath = join(paths.envDir('source'), 'mcp', 'servers.yaml');
    const destinationPath = join(paths.envDir('destination'), 'mcp', 'servers.yaml');
    const sourceText = [
      '# source catalogue',
      'github: &github { transport: "stdio", command: \'npx\', args: [ "-y", server-github ] } # exact selected node',
      'source-only: { command: never-copy }',
      '',
    ].join('\n');
    const destinationText = [
      '# destination catalogue',
      'unrelated: { transport: "sse", url: \'https://destination.invalid\' } # byte stable',
      'github: { old: "presentation" } # stale',
      '',
    ].join('\n');
    writeFileSync(sourcePath, sourceText);
    writeFileSync(destinationPath, destinationText);

    const result = await copyContent({
      paths,
      source: { kind: 'mcp', environment: 'source', name: 'github' },
      destination: { kind: 'mcp', environment: 'destination', name: 'github' },
      collision: 'overwrite',
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status, JSON.stringify(result)).toBe('copied');
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceText);
    expect(readFileSync(destinationPath, 'utf8')).toBe([
      '# destination catalogue',
      'unrelated: { transport: "sse", url: \'https://destination.invalid\' } # byte stable',
      'github: &github { transport: "stdio", command: \'npx\', args: [ "-y", server-github ] } # exact selected node',
      '',
    ].join('\n'));
  });

  it.each([
    ['skill', 'skills', 'research', 'directory'],
    ['instruction', 'instructions', 'base', 'file'],
    ['mcp', 'mcp', 'github', 'mapping'],
    ['agent', 'agents', 'reviewer', 'file'],
    ['command', 'commands', 'summarize', 'file'],
  ] as const)(
    'refuses a %s collision by default and overwrites only the declared destination',
    async (kind, directory, name, shape) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      for (const environment of ['source', 'destination']) {
        mkdirSync(join(paths.envDir(environment), directory), { recursive: true });
        writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
        writeFileSync(join(paths.envDir(environment), 'unrelated.txt'), `${environment} unrelated\n`);
      }
      const sourceTarget = kind === 'skill'
        ? join(paths.envDir('source'), directory, name)
        : join(paths.envDir('source'), directory, kind === 'mcp' ? 'servers.yaml' : `${name}.md`);
      const destinationTarget = kind === 'skill'
        ? join(paths.envDir('destination'), directory, name)
        : join(paths.envDir('destination'), directory, kind === 'mcp' ? 'servers.yaml' : `${name}.md`);
      if (shape === 'directory') {
        mkdirSync(sourceTarget);
        mkdirSync(destinationTarget);
        writeFileSync(join(sourceTarget, 'SKILL.md'), `---\nname: ${name}\n---\nsource\n`);
        writeFileSync(join(destinationTarget, 'SKILL.md'), `---\nname: ${name}\n---\ndestination\n`);
      } else if (shape === 'mapping') {
        writeFileSync(sourceTarget, `${name}:\n  command: source\nsource-only:\n  command: no\n`);
        writeFileSync(destinationTarget, `${name}:\n  command: destination\nunrelated:\n  command: keep\n`);
      } else {
        writeFileSync(sourceTarget, 'source bytes\n');
        writeFileSync(destinationTarget, 'destination bytes\n');
      }
      const beforeCollision = await capturePathIdentity(paths.envDir('destination'));
      const source = { kind, environment: 'source', name } as const;
      const destination = { kind, environment: 'destination', name } as const;

      const refused = await copyContent({
        paths,
        source,
        destination,
        runtime: createContentTransferRuntime({ paths }),
      });
      expect(refused).toMatchObject({ status: 'collision', kind, name });
      expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(beforeCollision);

      const overwritten = await copyContent({
        paths,
        source,
        destination,
        collision: 'overwrite',
        runtime: createContentTransferRuntime({ paths }),
      });
      expect(overwritten.status, JSON.stringify(overwritten)).toBe('copied');
      expect(readFileSync(join(paths.envDir('destination'), 'unrelated.txt'), 'utf8')).toBe(
        'destination unrelated\n',
      );
      if (shape === 'directory') {
        expect(readFileSync(join(destinationTarget, 'SKILL.md'), 'utf8')).toBe(
          readFileSync(join(sourceTarget, 'SKILL.md'), 'utf8'),
        );
      } else if (shape === 'mapping') {
        expect(parseYaml(readFileSync(destinationTarget, 'utf8'))).toEqual({
          [name]: { command: 'source' },
          unrelated: { command: 'keep' },
        });
      } else {
        expect(readFileSync(destinationTarget)).toEqual(readFileSync(sourceTarget));
      }
    },
  );

  it('rolls back a parent replacement at the single environment apply seam without splitting skill provenance', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const sourceYaml = [
      'version: "1.0"',
      'description: source',
      'sources:',
      '  atomic:',
      '    repo: owner/repo',
      '    path: skills/atomic',
      '    ref: main',
      '    commit: abc123',
      '    hash: deadbeef',
      '',
    ].join('\n');
    const destinationYaml = 'version: "1.0"\ndescription: destination\n';
    mkdirSync(paths.envDir('source'), { recursive: true });
    mkdirSync(paths.envDir('destination'), { recursive: true });
    writeFileSync(paths.envYaml('source'), sourceYaml);
    writeFileSync(paths.envYaml('destination'), destinationYaml);
    writeFileSync(join(paths.envDir('destination'), 'unrelated.txt'), 'original\n');
    const skill = join(paths.envDir('source'), 'skills', 'atomic');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: atomic\n---\nsource\n');
    const destinationBefore = await capturePathIdentity(paths.envDir('destination'));
    const appliedAway = join(home.home, 'applied-away');

    const result = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'atomic' },
      destination: { kind: 'skill', environment: 'destination', name: 'atomic' },
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterApply: async (operationId) => {
          expect(operationId).toBe('destination-environment');
          renameSync(paths.envDir('destination'), appliedAway);
          mkdirSync(paths.envDir('destination'));
          writeFileSync(paths.envYaml('destination'), destinationYaml);
          writeFileSync(join(paths.envDir('destination'), 'unrelated.txt'), 'original\n');
        },
      },
    });

    expect(result).toMatchObject({ status: 'stale' });
    expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);
    expect(existsSync(join(paths.envDir('destination'), 'skills', 'atomic'))).toBe(false);
    expect(parseEnvConfig(readFileSync(paths.envYaml('destination'), 'utf8'), 'destination').sources?.atomic)
      .toBeUndefined();
    expect(readFileSync(join(appliedAway, 'skills', 'atomic', 'SKILL.md'), 'utf8')).toContain('source');
    expect(parseEnvConfig(readFileSync(join(appliedAway, 'env.yaml'), 'utf8'), 'applied').sources?.atomic)
      .toBeDefined();
  });

  it('recovers a fresh-process after-apply skill WAL with content and provenance together', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    mkdirSync(paths.envDir('source'), { recursive: true });
    mkdirSync(paths.envDir('destination'), { recursive: true });
    writeFileSync(paths.envYaml('source'), [
      'version: "1.0"',
      'description: source',
      'sources:',
      '  atomic:',
      '    repo: owner/repo',
      '    path: skills/atomic',
      '    ref: main',
      '    commit: abc123',
      '    hash: deadbeef',
      '',
    ].join('\n'));
    writeFileSync(paths.envYaml('destination'), 'version: "1.0"\ndescription: destination\n');
    const skill = join(paths.envDir('source'), 'skills', 'atomic');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: atomic\n---\nsource\n');
    const destinationBefore = await capturePathIdentity(paths.envDir('destination'));

    const result = await copyContent({
      paths,
      source: { kind: 'skill', environment: 'source', name: 'atomic' },
      destination: { kind: 'skill', environment: 'destination', name: 'atomic' },
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.operations.some((operation) =>
            operation.id === 'destination-environment' && operation.state === 'applied')) {
            throw new Error('simulated process exit after apply');
          }
        },
      },
    });

    expect(result.status).toBe('pending-recovery');
    expect(existsSync(join(paths.envDir('destination'), 'skills', 'atomic', 'SKILL.md'))).toBe(true);
    expect(parseEnvConfig(readFileSync(paths.envYaml('destination'), 'utf8'), 'destination').sources?.atomic)
      .toBeDefined();
    const transactionId = result.status === 'pending-recovery' ? result.transactionId : '';
    await recoverPendingStagedCommands(paths, undefined, transactionId);
    expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);
    expect(existsSync(join(paths.envDir('destination'), 'skills', 'atomic'))).toBe(false);
    expect(parseEnvConfig(readFileSync(paths.envYaml('destination'), 'utf8'), 'destination').sources?.atomic)
      .toBeUndefined();
  });

  it.each(['command', 'skill'] as const)('rejects a %s source replacement after private staging', async (kind) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const source = kind === 'skill'
      ? join(paths.envDir('source'), 'skills', 'replace-me')
      : join(paths.envDir('source'), 'commands', 'replace-me.md');
    mkdirSync(kind === 'skill' ? source : join(paths.envDir('source'), 'commands'), { recursive: true });
    writeFileSync(
      kind === 'skill' ? join(source, 'SKILL.md') : source,
      kind === 'skill' ? '---\nname: replace-me\n---\nsource\n' : 'source\n',
    );

    const result = await copyContent({
      paths,
      source: { kind, environment: 'source', name: 'replace-me' },
      destination: { kind, environment: 'destination', name: 'replace-me' },
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterSourceCopy: async () => {
          writeFileSync(
            kind === 'skill' ? join(source, 'SKILL.md') : source,
            kind === 'skill' ? '---\nname: replace-me\n---\nreplacement\n' : 'replacement\n',
          );
        },
      },
    });

    expect(result).toMatchObject({ status: 'stale', field: 'source' });
    expect(await capturePathIdentity(paths.envDir('destination'))).toEqual({
      kind: 'directory',
      digest: expect.any(String),
      mode: expect.any(Number),
    });
    expect(existsSync(kind === 'skill'
      ? join(paths.envDir('destination'), 'skills', 'replace-me')
      : join(paths.envDir('destination'), 'commands', 'replace-me.md'))).toBe(false);
  });

  it('rejects an identical-byte source pathname replacement at the durable publication boundary', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    const source = join(paths.envDir('source'), 'commands', 'safe.md');
    const displaced = join(home.home, 'displaced-safe.md');
    const destinationBefore = await capturePathIdentity(paths.envDir('destination'));
    let swapped = false;

    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.phase !== 'planned' || swapped) return;
          swapped = true;
          renameSync(source, displaced);
          writeFileSync(source, readFileSync(displaced));
        },
      },
    });

    expect(result).toMatchObject({ status: 'stale', field: 'source' });
    expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);
    expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);
  });

  it.each(['nested-file', 'nested-directory'] as const)(
    'rejects a byte/mode-identical skill %s inode replacement after WAL persistence',
    async (replacement) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      for (const environment of ['source', 'destination']) {
        mkdirSync(paths.envDir(environment), { recursive: true });
        writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
      }
      const skill = join(paths.envDir('source'), 'skills', 'stable');
      const nestedDirectory = join(skill, 'references', 'deep');
      const nestedFile = join(nestedDirectory, 'guide.md');
      mkdirSync(nestedDirectory, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: stable\n---\nsource\n');
      writeFileSync(nestedFile, 'nested source bytes\n');
      const destinationBefore = await capturePathIdentity(paths.envDir('destination'));
      let transactionId = '';
      let swapped = false;

      const result = await copyContent({
        paths,
        source: { kind: 'skill', environment: 'source', name: 'stable' },
        destination: { kind: 'skill', environment: 'destination', name: 'stable' },
        runtime: createContentTransferRuntime({ paths }),
        faults: {
          afterPersist: async (plan) => {
            if (plan.phase !== 'planned' || swapped) return;
            swapped = true;
            transactionId = plan.transactionId;
            const target = replacement === 'nested-file'
              ? nestedFile
              : join(skill, 'references');
            const displaced = join(home.home, replacement);
            const contentIdentity = await capturePathIdentity(target);
            const inode = lstatSync(target).ino;
            renameSync(target, displaced);
            if (replacement === 'nested-file') {
              writeFileSync(target, readFileSync(displaced));
              chmodSync(target, lstatSync(displaced).mode & 0o7777);
            } else {
              cpSync(displaced, target, { recursive: true, preserveTimestamps: true });
            }
            expect(await capturePathIdentity(target)).toEqual(contentIdentity);
            expect(lstatSync(target).ino).not.toBe(inode);
          },
        },
      });

      expect(result).toMatchObject({ status: 'stale', field: 'source' });
      expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);
      expect(existsSync(join(paths.envDir('destination'), 'skills', 'stable'))).toBe(false);
      expect((await readState(paths)).commands).toEqual([]);
      expect(transactionId).not.toBe('');
      expect(existsSync(join(paths.live, 'commands', transactionId))).toBe(false);
    },
  );

  it.each(['source-content', 'source-manifest'] as const)(
    'rejects a skill %s symlink swap at the durable publication boundary',
    async (swap) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      for (const environment of ['source', 'destination']) {
        mkdirSync(paths.envDir(environment), { recursive: true });
        writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
      }
      const skill = join(paths.envDir('source'), 'skills', 'stable');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: stable\n---\nsource\n');
      const destinationBefore = await capturePathIdentity(paths.envDir('destination'));
      let swapped = false;

      const result = await copyContent({
        paths,
        source: { kind: 'skill', environment: 'source', name: 'stable' },
        destination: { kind: 'skill', environment: 'destination', name: 'stable' },
        runtime: createContentTransferRuntime({ paths }),
        faults: {
          afterPersist: async (plan) => {
            if (plan.phase !== 'planned' || swapped) return;
            swapped = true;
            const target = swap === 'source-content' ? skill : paths.envYaml('source');
            const displaced = join(home.home, swap);
            renameSync(target, displaced);
            symlinkSync(displaced, target);
          },
        },
      });

      expect(result).toMatchObject({ status: 'stale', field: 'source' });
      expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);
      expect(existsSync(join(paths.envDir('destination'), 'skills', 'stable'))).toBe(false);
    },
  );

  it('rejects hostile runtime outcomes and reconciles retained WAL truth', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    const locator = { kind: 'command', environment: 'source', name: 'safe' } as const;
    const destination = { kind: 'command', environment: 'destination', name: 'safe' } as const;

    const hostileOpen = await copyContent({
      paths,
      source: locator,
      destination,
      runtime: {
        open: async () => ({ status: 'hostile' }) as never,
        close: async () => {},
        publish: async () => ({ status: 'complete' }),
      },
    });
    expect(hostileOpen.status).toBe('failure');

    let invalidCloses = 0;
    const hostilePublication = await copyContent({
      paths,
      source: locator,
      destination,
      runtime: {
        open: async () => ({ status: 'ready' }),
        close: async () => { invalidCloses += 1; },
        publish: async () => ({ status: 'hostile' }) as never,
      },
    });
    expect(hostilePublication.status).toBe('failure');
    expect(invalidCloses).toBe(1);

    const falseComplete = await copyContent({
      paths,
      source: locator,
      destination,
      runtime: {
        open: async () => ({ status: 'ready' }),
        close: async () => {},
        publish: async () => ({ status: 'complete' }),
      },
    });
    expect(falseComplete.status).toBe('failure');
    expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);

    const retainedComplete = await copyContent({
      paths,
      source: locator,
      destination,
      runtime: {
        open: async () => ({ status: 'ready' }),
        close: async () => {},
        publish: async (request) => {
          const manifest = emptyManifest();
          manifest.commands = [createCommandPlan({
            transactionId: request.transactionId,
            kind: 'content-copy',
            operations: [],
          })];
          await writeState(paths, manifest);
          return { status: 'complete' };
        },
      },
    });
    expect(retainedComplete).toMatchObject({ status: 'pending-recovery' });
  });

  it('reports durable commit-point truth as git-pending despite a claimed complete outcome', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: {
        open: async () => ({ status: 'ready' }),
        close: async () => {},
        publish: async (request) => {
          const planned = createCommandPlan({
            transactionId: request.transactionId,
            kind: 'content-copy',
            operations: [],
          });
          const committed = advanceCommand(advanceCommand(planned, 'applying'), 'committed');
          const manifest = emptyManifest();
          manifest.commands = [committed];
          await writeState(paths, manifest);
          return { status: 'complete' };
        },
      },
    });

    expect(result).toMatchObject({ status: 'git-pending', publication: 'git-pending' });
  });

  it('returns typed failure when initial state cannot be read', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    mkdirSync(paths.base, { recursive: true });
    writeFileSync(paths.state, '{not-json');

    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status).toBe('failure');
  });

  it('reports a different authoritative WAL appearing during publication and never closes it', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let closes = 0;
    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: {
        open: async () => ({ status: 'ready' }),
        close: async () => { closes += 1; },
        publish: async () => {
          const manifest = emptyManifest();
          manifest.commands = [createCommandPlan({
            transactionId: 'different-pending',
            kind: 'other',
            operations: [],
          })];
          await writeState(paths, manifest);
          throw new Error('publication raced');
        },
      },
    });

    expect(result).toEqual({ status: 'pending-recovery', transactionId: 'different-pending' });
    expect(closes).toBe(0);
  });

  it('does not let a close failure mask durable completion', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let closes = 0;
    const result = await copyContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({
        paths,
        close: async () => {
          closes += 1;
          throw new Error('close failed');
        },
      }),
    });

    expect(result.status).toBe('copied');
    expect(closes).toBe(1);
    expect(readFileSync(join(paths.envDir('destination'), 'commands', 'safe.md'), 'utf8'))
      .toBe('source bytes\n');
  });
});
