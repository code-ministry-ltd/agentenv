import type { Command, GlobalCliOptions, RunOptions, RunResult } from './command.js';
import { commands, findCommand } from './commands/index.js';
import {
  closeStoreSync,
  commitRequiredMutation,
  commitRequiredSteps,
  openStoreSync,
  withNotices,
} from './commands/store-sync.js';
import { recoverPendingFilesystemBundles } from './filesystem-bundle.js';
import { recoverPendingGlobalCommands } from './global-command.js';
import { resolvePaths } from './paths.js';
import { recoverPendingStagedCommands } from './staged-command.js';
import { getVersion } from './version.js';
import { legacyMigrationRequired, migrationGateClosed } from './migration.js';
import { recoverPendingRemoteReplacements } from './remote-transaction.js';
import { readState } from './state.js';

export type { RunResult, RunOptions } from './command.js';

function helpText(): string {
  const lines = [
    'agentenv - virtual environments for AI agents',
    '',
    'Usage:',
    '  agentenv <command> [options]',
    '',
  ];

  const visible = commands.filter((c) => !c.hidden);
  if (visible.length > 0) {
    const width = Math.max(...visible.map((c) => commandInvocation(c).length));
    lines.push('Commands:');
    for (const c of visible) {
      lines.push(`  ${commandInvocation(c).padEnd(width)}  ${c.summary}`);
    }
    lines.push('');
  }

  lines.push(
    'Options:',
    '  --json           Emit one machine-readable JSON result',
    '  --offline        Disable fetch, pull, push, and remote probes',
    '  --verbose        Include safe command diagnostics',
    '  -v, --version    Print the version and exit',
    '  -h, --help       Show this help and exit',
    '',
  );
  return lines.join('\n');
}

function commandInvocation(c: Command): string {
  return c.usage ? `${c.name} ${c.usage}` : c.name;
}

/**
 * The CLI entry point: parse argv (without the node/script prefix), dispatch to
 * a registered command, and return what to print plus an exit code. All I/O is
 * injected via {@link RunOptions} so the whole surface is unit-testable; the
 * executable wrapper in bin.ts performs the only real stream writes.
 */
export async function run(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const parsed = parseGlobalOptions(argv);
  if ('error' in parsed) return parsed.error;
  const { globals, rest } = parsed;
  const first = rest[0];

  if (first === '--version' || first === '-v') {
    return { stdout: `${getVersion()}\n`, code: 0 };
  }

  // No command, or an explicit help request, prints usage and exits 0.
  if (first === undefined || first === '--help' || first === '-h') {
    return { stdout: helpText(), code: 0 };
  }

  const command = findCommand(first);
  if (!command) {
    return formatResult(first, globals, resolvePaths(env), {
      stderr: `agentenv: unknown command '${first}'\nRun 'agentenv --help' for usage.\n`,
      stdout: '',
      code: 1,
    });
  }

  const paths = resolvePaths(env);
  const recoveryCommands = new Set(['__shim', 'doctor', 'migrate', 'resolve', 'status']);
  const recoveryNotices: string[] = [];
  if (!recoveryCommands.has(command.name)) {
    if (await migrationGateClosed(paths)) {
      return formatResult(command.name, globals, paths, {
        stdout: '',
        stderr: `agentenv: migration gate is closed; only migrate, status, and doctor are available\n`,
        code: 2,
      });
    }
    if (await legacyMigrationRequired(paths)) {
      return formatResult(command.name, globals, paths, {
        stdout: '',
        stderr: `agentenv: this v1 installation must be migrated before mutation; run 'agentenv migrate'\n`,
        code: 2,
      });
    }
    // A global activation/drop carries every undo input in its durable plan, so
    // any normal invocation can settle it before doing unrelated work. `status`
    // and `doctor` remain observational/explicit recovery surfaces and therefore
    // intentionally report the pending intent instead.
    await recoverPendingRemoteReplacements(paths, env, options.gitRun);
    await recoverPendingGlobalCommands(paths);
    let manifest = await readState(paths);
    const pendingStaged = manifest.commands.find(
      (plan) => (plan as typeof plan & { executor?: unknown }).executor === 'staged-command',
    );
    if (pendingStaged) {
      const gitBookkeeping = pendingStaged.commitPoint && pendingStaged.gitRequired
        ? pendingStaged.gitSteps && pendingStaged.gitSteps.length > 0
          ? () => commitRequiredSteps(
              { paths, env, options: { ...options, globals } },
              pendingStaged.gitSteps!,
              recoveryNotices,
            )
          : undefined
        : undefined;
      await recoverPendingStagedCommands(paths, gitBookkeeping, pendingStaged.transactionId);
      manifest = await readState(paths);
    }
    const pendingBundle = manifest.commands.find(
      (plan) => plan.kind === 'filesystem-bundle',
    );
    if (pendingBundle) {
      const gitBookkeeping = pendingBundle.commitPoint
        ? pendingBundle.gitRequired && pendingBundle.gitMessage
          ? () => commitRequiredMutation(
              { paths, env, options: { ...options, globals } },
              pendingBundle.gitMessage!,
              recoveryNotices,
            )
          : undefined
        : undefined;
      await recoverPendingFilesystemBundles(paths, gitBookkeeping, pendingBundle.transactionId);
    }
  }

  const context = {
    args: rest.slice(1),
    paths,
    env,
    cwd,
    options: { ...options, globals },
  };
  let result: RunResult;
  const readOnlyPersistenceCommands = new Set(['list', 'show', 'status']);
  const servicePersistence =
    readOnlyPersistenceCommands.has(command.name) &&
    !(await migrationGateClosed(paths)) &&
    !(await legacyMigrationRequired(paths));
  if (servicePersistence) {
    const notices: string[] = [];
    const syncCtx = { paths, env, options: context.options };
    await openStoreSync(syncCtx, notices, { skipFetch: true });
    try {
      result = await command.run(context);
    } finally {
      await closeStoreSync(syncCtx, notices);
    }
    result = withNotices(result, notices);
  } else {
    result = await command.run(context);
  }
  return formatResult(command.name, globals, paths, withNotices(result, recoveryNotices));
}

function parseGlobalOptions(
  argv: readonly string[],
): { globals: GlobalCliOptions; rest: readonly string[] } | { error: RunResult } {
  const globals: GlobalCliOptions = { json: false, offline: false, verbose: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '--json') globals.json = true;
    else if (arg === '--offline') globals.offline = true;
    else if (arg === '--verbose') globals.verbose = true;
    else if (arg.startsWith('--') && arg !== '--help' && arg !== '--version') {
      const result: RunResult = {
        stdout: '',
        stderr: `agentenv: unknown global option '${arg}'\nRun 'agentenv --help' for usage.\n`,
        code: 1,
      };
      if (!globals.json) return { error: result };
      return {
        error: formatResult('(root)', globals, resolvePaths({}), result),
      };
    } else break;
    index += 1;
  }
  return { globals, rest: argv.slice(index) };
}

function formatResult(
  command: string,
  globals: GlobalCliOptions,
  paths: ReturnType<typeof resolvePaths>,
  result: RunResult,
): RunResult {
  const warnings = (result.stderr ?? '').trimEnd();
  const output = result.stdout.trimEnd();
  if (globals.json) {
    const payload = {
      schemaVersion: 1,
      ok: result.code === 0,
      command,
      code: result.code,
      data: result.data ?? { output },
      warnings: warnings === '' ? [] : warnings.split('\n'),
      ...(globals.verbose
        ? { diagnostics: { offline: globals.offline, agentenvHome: paths.base } }
        : {}),
    };
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, code: result.code };
  }
  if (!globals.verbose) return result;
  const diagnostic =
    `agentenv: command=${command} home=${paths.base} offline=${globals.offline ? 'yes' : 'no'}`;
  return {
    ...result,
    stderr: `${result.stderr ?? ''}${diagnostic}\n`,
  };
}
