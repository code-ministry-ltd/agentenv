import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveContent } from '../src/application/content-transfer.js';
import { createContentTransferRuntime } from '../src/application/content-transfer-runtime.js';
import type {
  ContentTransferPublicationRequest,
  ContentTransferRuntime,
} from '../src/application/content-transfer-runtime.js';
import { capturePathIdentity } from '../src/path-identity.js';
import { resolvePaths } from '../src/paths.js';
import { readState } from '../src/state.js';
import { recoverPendingStagedCommands } from '../src/staged-command.js';
import { makeTempHome, type TempHome } from './helpers.js';
import { isMap, isScalar, parseDocument } from 'yaml';

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

describe('content transfer move', () => {
  it.each([
    ['instruction', 'instructions'],
    ['agent', 'agents'],
    ['command', 'commands'],
  ] as const)('moves one %s exactly with one atomic application publication', async (kind, directory) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(paths.envDir(environment), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const source = join(paths.envDir('source'), directory, 'safe.md');
    const destination = join(paths.envDir('destination'), directory, 'safe.md');
    mkdirSync(join(paths.envDir('source'), directory));
    writeFileSync(source, 'source bytes\n');
    let publication: ContentTransferPublicationRequest | undefined;
    const realRuntime = createContentTransferRuntime({ paths });
    const runtime: ContentTransferRuntime = {
      open: () => realRuntime.open(),
      close: () => realRuntime.close(),
      publish: async (request) => {
        publication = request;
        return realRuntime.publish(request);
      },
    };

    const result = await moveContent({
      paths,
      source: { kind, environment: 'source', name: 'safe' },
      destination: { kind, environment: 'destination', name: 'safe' },
      runtime,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'moved',
      operation: 'move',
      kind,
      name: 'safe',
      publication: 'complete',
    });
    expect(readFileSync(destination, 'utf8')).toBe('source bytes\n');
    expect(existsSync(source)).toBe(false);
    expect(publication?.kind).toBe('content-move');
    expect(publication?.entries.map((entry) => entry.id)).toEqual([
      'destination-environment',
      'source-environment',
    ]);
    expect(publication?.gitSteps).toHaveLength(1);
    expect(publication?.gitSteps?.[0]?.message).toBe(
      `agentenv: move ${kind} safe from source to destination`,
    );
    expect(publication?.gitSteps?.[0]?.paths).toEqual([destination, source]);
  });

  it.each([true, false])(
    'moves a skill and transfers exact provenance (source provenance: %s)',
    async (withSourceProvenance) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      const record = '!!map { repo: "owner/repo", path: \'skills/research\', ref: main, commit: abc, hash: deadbeef, future: [one, "two"] } # exact';
      const sourceYaml = [
        '# source header',
        'version: "1.0"',
        'description: source',
        'sources:',
        '  unrelated: { repo: keep/repo } # keep source',
        ...(withSourceProvenance ? [`  research: ${record}`] : []),
        '',
      ].join('\n');
      const destinationYaml = [
        '# destination header',
        'version: "1.0"',
        'description: destination',
        'sources:',
        '  unrelated: { repo: keep/repo } # keep destination',
        '  research: { repo: stale/repo } # stale',
        '',
      ].join('\n');
      mkdirSync(paths.envDir('source'), { recursive: true });
      mkdirSync(paths.envDir('destination'), { recursive: true });
      writeFileSync(paths.envYaml('source'), sourceYaml);
      writeFileSync(paths.envYaml('destination'), destinationYaml);
      const source = join(paths.envDir('source'), 'skills', 'research');
      const destination = join(paths.envDir('destination'), 'skills', 'research');
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'SKILL.md'), '---\nname: research\n---\nsource\n');

      const result = await moveContent({
        paths,
        source: { kind: 'skill', environment: 'source', name: 'research' },
        destination: { kind: 'skill', environment: 'destination', name: 'research' },
        collision: 'overwrite',
        runtime: createContentTransferRuntime({ paths }),
      });

      expect(result.status, JSON.stringify(result)).toBe('moved');
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain('source');
      expect(existsSync(source)).toBe(false);
      const sourceAfter = readFileSync(paths.envYaml('source'), 'utf8');
      const destinationAfter = readFileSync(paths.envYaml('destination'), 'utf8');
      expect(sourceAfter).toContain('  unrelated: { repo: keep/repo } # keep source\n');
      expect(destinationAfter).toContain('  unrelated: { repo: keep/repo } # keep destination\n');
      expect(parseDocument(sourceAfter).hasIn(['sources', 'research'])).toBe(false);
      const destinationNode = parseDocument(destinationAfter).getIn(['sources', 'research'], true);
      if (withSourceProvenance) {
        expect(isMap(destinationNode)).toBe(true);
        if (!isMap(destinationNode)) throw new Error('moved provenance is not a map');
        expect(destinationNode).toMatchObject({ flow: true, comment: ' exact' });
        const repo = destinationNode.get('repo', true);
        expect(isScalar(repo) && repo.type).toBe('QUOTE_DOUBLE');
      } else {
        expect(destinationNode).toBeUndefined();
      }
    },
  );

  it('moves one MCP AST node and preserves unrelated catalogue presentation', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    for (const environment of ['source', 'destination']) {
      mkdirSync(join(paths.envDir(environment), 'mcp'), { recursive: true });
      writeFileSync(paths.envYaml(environment), 'version: "1.0"\ndescription: test\n');
    }
    const sourcePath = join(paths.envDir('source'), 'mcp', 'servers.yaml');
    const destinationPath = join(paths.envDir('destination'), 'mcp', 'servers.yaml');
    writeFileSync(sourcePath, [
      '# source',
      'keep: { command: keep } # source keep',
      'server: !!map { command: "node", args: [one, \'two\'] } # exact server',
      '',
    ].join('\n'));
    writeFileSync(destinationPath, [
      '# destination',
      'keep: { command: destination } # destination keep',
      '',
    ].join('\n'));

    const result = await moveContent({
      paths,
      source: { kind: 'mcp', environment: 'source', name: 'server' },
      destination: { kind: 'mcp', environment: 'destination', name: 'server' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status, JSON.stringify(result)).toBe('moved');
    const sourceAfter = readFileSync(sourcePath, 'utf8');
    const destinationAfter = readFileSync(destinationPath, 'utf8');
    expect(sourceAfter).toContain('keep: { command: keep } # source keep\n');
    expect(destinationAfter).toContain('keep: { command: destination } # destination keep\n');
    expect(parseDocument(sourceAfter).has('server')).toBe(false);
    const moved = parseDocument(destinationAfter).get('server', true);
    expect(isMap(moved)).toBe(true);
    if (!isMap(moved)) throw new Error('moved MCP entry is not a map');
    expect(moved).toMatchObject({ flow: true, comment: ' exact server' });
  });

  it.each([
    ['skill', 'skills'],
    ['instruction', 'instructions'],
    ['mcp', 'mcp'],
    ['agent', 'agents'],
    ['command', 'commands'],
  ] as const)(
    'refuses a %s collision by default and explicit overwrite replaces only that item',
    async (kind, directory) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    const sourceYaml = [
      '# source manifest',
      'version: "1.0"',
      'description: source',
      'sources:',
      '  unrelated: { repo: source/keep } # source provenance',
      ...(kind === 'skill'
        ? ['  safe: { repo: source/repo, path: skills/safe, ref: main, commit: abc, hash: one } # moved']
        : []),
      '',
    ].join('\n');
    const destinationYaml = [
      '# destination manifest',
      'version: "1.0"',
      'description: destination',
      'sources:',
      '  unrelated: { repo: destination/keep } # destination provenance',
      ...(kind === 'skill'
        ? ['  safe: { repo: stale/repo, path: old, ref: old, commit: old, hash: old } # replaced']
        : []),
      '',
    ].join('\n');
    for (const [environment, yaml] of [
      ['source', sourceYaml],
      ['destination', destinationYaml],
    ] as const) {
      mkdirSync(join(paths.envDir(environment), directory), { recursive: true });
      writeFileSync(paths.envYaml(environment), yaml);
    }
    const source = kind === 'skill'
      ? join(paths.envDir('source'), directory, 'safe')
      : join(paths.envDir('source'), directory, kind === 'mcp' ? 'servers.yaml' : 'safe.md');
    const destination = kind === 'skill'
      ? join(paths.envDir('destination'), directory, 'safe')
      : join(paths.envDir('destination'), directory, kind === 'mcp' ? 'servers.yaml' : 'safe.md');
    const unrelated = kind === 'skill'
      ? join(paths.envDir('destination'), directory, 'unrelated', 'SKILL.md')
      : join(paths.envDir('destination'), directory, 'unrelated.md');
    if (kind === 'skill') {
      mkdirSync(source);
      mkdirSync(dirname(unrelated), { recursive: true });
      mkdirSync(destination);
      writeFileSync(join(source, 'SKILL.md'), '---\nname: safe\n---\nsource bytes\n');
      writeFileSync(join(destination, 'SKILL.md'), '---\nname: safe\n---\ndestination bytes\n');
      writeFileSync(unrelated, 'keep exactly\n');
    } else if (kind === 'mcp') {
      writeFileSync(source, [
        'unrelated: { command: source-keep } # source unrelated',
        'safe: { command: source-command } # source exact',
        '',
      ].join('\n'));
      writeFileSync(destination, [
        'unrelated: { command: destination-keep } # destination unrelated',
        'safe: { command: destination-command } # destination exact',
        '',
      ].join('\n'));
    } else {
      writeFileSync(source, 'source bytes\n');
      writeFileSync(destination, 'destination bytes\n');
      writeFileSync(unrelated, 'keep exactly\n');
    }
    const sourceBefore = await capturePathIdentity(paths.envDir('source'));
    const destinationBefore = await capturePathIdentity(paths.envDir('destination'));

    const refused = await moveContent({
      paths,
      source: { kind, environment: 'source', name: 'safe' },
      destination: { kind, environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
    });
    expect(refused).toEqual({ status: 'collision', kind, name: 'safe' });
    expect(await capturePathIdentity(paths.envDir('source'))).toEqual(sourceBefore);
    expect(await capturePathIdentity(paths.envDir('destination'))).toEqual(destinationBefore);

    const overwritten = await moveContent({
      paths,
      source: { kind, environment: 'source', name: 'safe' },
      destination: { kind, environment: 'destination', name: 'safe' },
      collision: 'overwrite',
      runtime: createContentTransferRuntime({ paths }),
    });
    expect(overwritten.status, JSON.stringify(overwritten)).toBe('moved');
    if (kind === 'skill') {
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain('source bytes');
      expect(readFileSync(unrelated, 'utf8')).toBe('keep exactly\n');
      const sourceAfter = readFileSync(paths.envYaml('source'), 'utf8');
      const destinationAfter = readFileSync(paths.envYaml('destination'), 'utf8');
      expect(sourceAfter).toContain('source provenance');
      expect(destinationAfter).toContain('destination provenance');
      expect(parseDocument(sourceAfter).hasIn(['sources', 'safe'])).toBe(false);
      expect(parseDocument(destinationAfter).getIn(['sources', 'safe', 'repo'])).toBe('source/repo');
    } else if (kind === 'mcp') {
      const sourceAfter = readFileSync(source, 'utf8');
      const destinationAfter = readFileSync(destination, 'utf8');
      expect(sourceAfter).toContain('source unrelated');
      expect(destinationAfter).toContain('destination unrelated');
      expect(parseDocument(sourceAfter).has('safe')).toBe(false);
      expect(parseDocument(destinationAfter).getIn(['safe', 'command']))
        .toBe('source-command');
      expect(readFileSync(paths.envYaml('source'), 'utf8')).toBe(sourceYaml);
      expect(readFileSync(paths.envYaml('destination'), 'utf8')).toBe(destinationYaml);
    } else {
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(destination, 'utf8')).toBe('source bytes\n');
      expect(readFileSync(unrelated, 'utf8')).toBe('keep exactly\n');
      expect(readFileSync(paths.envYaml('source'), 'utf8')).toBe(sourceYaml);
      expect(readFileSync(paths.envYaml('destination'), 'utf8')).toBe(destinationYaml);
    }
  });

  it('rejects same-environment, renamed, invalid, and missing moves without mutation', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    const runtime = createContentTransferRuntime({ paths });
    const source = { kind: 'command', environment: 'source', name: 'safe' } as const;

    const same = await moveContent({ paths, source, destination: source, runtime });
    const renamed = await moveContent({
      paths,
      source,
      destination: { kind: 'command', environment: 'destination', name: 'other' },
      runtime,
    });
    const invalid = await moveContent({
      paths,
      source: { kind: 'command', environment: '../escape', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime,
    });
    const missing = await moveContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'missing' },
      destination: { kind: 'command', environment: 'destination', name: 'missing' },
      runtime,
    });

    expect(same).toMatchObject({ status: 'invalid', field: 'destination' });
    expect(renamed).toMatchObject({ status: 'invalid', field: 'destination' });
    expect(invalid).toMatchObject({ status: 'invalid', field: 'source' });
    expect(missing).toEqual({ status: 'not-found', field: 'source' });
    expect(readFileSync(join(paths.envDir('source'), 'commands', 'safe.md'), 'utf8'))
      .toBe('source bytes\n');
  });

  it.each([
    ['source', (paths: ReturnType<typeof resolvePaths>) => {
      writeFileSync(join(paths.envDir('source'), 'commands', 'safe.md'), 'source replacement\n');
    }],
    ['destination', (paths: ReturnType<typeof resolvePaths>) => {
      mkdirSync(join(paths.envDir('destination'), 'commands'));
      writeFileSync(join(paths.envDir('destination'), 'commands', 'safe.md'), 'destination replacement\n');
    }],
    ['source-container', (paths: ReturnType<typeof resolvePaths>) => {
      const container = join(paths.envDir('source'), 'commands');
      const displaced = `${container}-old`;
      renameSync(container, displaced);
      mkdirSync(container);
      writeFileSync(join(container, 'safe.md'), 'source bytes\n');
    }],
    ['destination-container', (paths: ReturnType<typeof resolvePaths>) => {
      mkdirSync(join(paths.envDir('destination'), 'commands'));
    }],
  ] as const)('retains a concurrent %s change and returns stale', async (_field, mutate) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);

    const result = await moveContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
      faults: { afterStage: async () => mutate(paths) },
    });

    expect(result.status, JSON.stringify(result)).toBe('stale');
    expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md')))
      .toBe(_field === 'destination');
  });

  it.each(['source', 'destination'] as const)(
    'rejects a byte/mode-identical %s inode swap at the durable boundary',
    async (side) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      seedCommandTransfer(paths);
      const destination = join(paths.envDir('destination'), 'commands', 'safe.md');
      if (side === 'destination') {
        mkdirSync(join(paths.envDir('destination'), 'commands'));
        writeFileSync(destination, 'destination bytes\n');
      }
      const target = side === 'source'
        ? join(paths.envDir('source'), 'commands', 'safe.md')
        : destination;
      let swapped = false;

      const result = await moveContent({
        paths,
        source: { kind: 'command', environment: 'source', name: 'safe' },
        destination: { kind: 'command', environment: 'destination', name: 'safe' },
        ...(side === 'destination' ? { collision: 'overwrite' as const } : {}),
        runtime: createContentTransferRuntime({ paths }),
        faults: {
          afterPersist: async (plan) => {
            if (plan.phase !== 'planned' || swapped) return;
            swapped = true;
            const bytes = readFileSync(target);
            const mode = lstatSync(target).mode & 0o7777;
            const inode = lstatSync(target).ino;
            renameSync(target, `${target}.displaced`);
            writeFileSync(target, bytes);
            chmodSync(target, mode);
            expect(lstatSync(target).ino).not.toBe(inode);
          },
        },
      });

      expect(result).toMatchObject({ status: 'stale', field: side });
      expect(readFileSync(target)).toEqual(
        side === 'source' ? Buffer.from('source bytes\n') : Buffer.from('destination bytes\n'),
      );
    },
  );

  it('rejects unsafe links in either whole environment without touching their targets', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    const external = join(home.home, 'external.txt');
    writeFileSync(external, 'outside\n');
    symlinkSync(external, join(paths.envDir('source'), 'escape'));

    const result = await moveContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
    });

    expect(result.status).toBe('failure');
    expect(readFileSync(external, 'utf8')).toBe('outside\n');
    expect(readFileSync(join(paths.envDir('source'), 'commands', 'safe.md'), 'utf8'))
      .toBe('source bytes\n');
  });

  it.each(['destination-environment', 'source-environment'] as const)(
    'rolls back to the exact pre-state after an injected %s apply failure',
    async (failedEntry) => {
      const home = makeTempHome();
      homes.push(home);
      const paths = resolvePaths(home.env);
      seedCommandTransfer(paths);
      const source = join(paths.envDir('source'), 'commands', 'safe.md');
      const destination = join(paths.envDir('destination'), 'commands', 'safe.md');
      let closes = 0;

      const result = await moveContent({
        paths,
        source: { kind: 'command', environment: 'source', name: 'safe' },
        destination: { kind: 'command', environment: 'destination', name: 'safe' },
        runtime: createContentTransferRuntime({
          paths,
          close: async () => { closes += 1; },
        }),
        faults: {
          afterApply: async (operationId) => {
            if (operationId === failedEntry) throw new Error(`fail ${failedEntry}`);
          },
        },
      });

      expect(result.status).toBe('failure');
      expect(readFileSync(source, 'utf8')).toBe('source bytes\n');
      expect(existsSync(destination)).toBe(false);
      expect((await readState(paths)).commands).toEqual([]);
      expect(closes).toBe(1);
    },
  );

  it.each([
    ['planned', 'pending-recovery', false],
    ['committed', 'git-pending', true],
  ] as const)('reconciles an injected %s WAL interruption as %s', async (phase, status, post) => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    const source = join(paths.envDir('source'), 'commands', 'safe.md');
    const destination = join(paths.envDir('destination'), 'commands', 'safe.md');
    let interrupted = false;

    const result = await moveContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.phase !== phase || interrupted) return;
          interrupted = true;
          throw new Error(`interrupt ${phase}`);
        },
      },
    });

    expect(result.status).toBe(status);
    const transactionId = 'transactionId' in result ? result.transactionId : '';
    expect(transactionId).not.toBe('');
    expect((await readState(paths)).commands).toHaveLength(1);
    expect(existsSync(source)).toBe(!post);
    expect(existsSync(destination)).toBe(post);
    await recoverPendingStagedCommands(paths, undefined, transactionId);
    expect((await readState(paths)).commands).toEqual([]);
    expect(existsSync(source)).toBe(!post);
    expect(existsSync(destination)).toBe(post);
  });

  it('clears retained complete-phase truth and reports moved after the post-persist hook fails', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let interrupted = false;

    const result = await moveContent({
      paths,
      source: { kind: 'command', environment: 'source', name: 'safe' },
      destination: { kind: 'command', environment: 'destination', name: 'safe' },
      runtime: createContentTransferRuntime({ paths }),
      faults: {
        afterPersist: async (plan) => {
          if (plan.phase !== 'complete' || interrupted) return;
          interrupted = true;
          throw new Error('interrupt complete');
        },
      },
    });

    expect(result).toMatchObject({ status: 'moved', publication: 'complete' });
    expect((await readState(paths)).commands).toEqual([]);
    expect(existsSync(join(paths.envDir('source'), 'commands', 'safe.md'))).toBe(false);
    expect(readFileSync(join(paths.envDir('destination'), 'commands', 'safe.md'), 'utf8'))
      .toBe('source bytes\n');
  });

  it('validates hostile runtime outcomes and closes exactly once only when safe', async () => {
    const home = makeTempHome();
    homes.push(home);
    const paths = resolvePaths(home.env);
    seedCommandTransfer(paths);
    let closes = 0;
    const locator = { kind: 'command', environment: 'source', name: 'safe' } as const;
    const destination = { kind: 'command', environment: 'destination', name: 'safe' } as const;

    const invalidPublication = await moveContent({
      paths,
      source: locator,
      destination,
      runtime: {
        open: async () => ({ status: 'ready' }),
        close: async () => { closes += 1; },
        publish: async () => ({ status: 'hostile' }) as never,
      },
    });
    expect(invalidPublication.status).toBe('failure');
    expect(closes).toBe(1);
    expect(existsSync(join(paths.envDir('destination'), 'commands', 'safe.md'))).toBe(false);

    const pendingOpen = await moveContent({
      paths,
      source: locator,
      destination,
      runtime: {
        open: async () => ({ status: 'pending-recovery', transactionId: 'pending' }),
        close: async () => { closes += 1; },
        publish: async () => ({ status: 'complete' }),
      },
    });
    expect(pendingOpen).toEqual({ status: 'pending-recovery', transactionId: 'pending' });
    expect(closes).toBe(1);
  });
});
