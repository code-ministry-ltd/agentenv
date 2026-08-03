import {
  adoptItem,
  findAdoptableItem,
  isForeignManagerSymlink,
  itemHasSecret,
  singular,
  type AdoptSurface,
} from '../adopt.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { confirmDefault } from '../prompt.js';
import { environmentExists, validateEnvName } from '../store.js';
import { closeStoreSync, commitMutation, openStoreSync, withNotices } from './store-sync.js';

/**
 * `agentenv adopt <name> --into <env>` — manually adopt a new unowned item into
 * a CHOSEN (typically non-top) env (design D10). This is the deliberate path for
 * an item the auto-sweep would place elsewhere (or not at all — e.g. a project
 * item, which the sweep never auto-adopts but a user may deliberately pull in).
 *
 * Two guardrails still apply, since a foreign symlink or a secret is dangerous
 * regardless of intent: a foreign-manager symlink is REFUSED (moving its target
 * would corrupt that manager); secret-bearing content PROMPTS first.
 */
export const adoptCommand: Command = {
  name: 'adopt',
  usage: '<name> --into <env>',
  summary: 'Manually adopt a new item into a chosen environment',

  async run(ctx): Promise<RunResult> {
    const parsed = parseArgs(ctx.args, { values: ['into'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `adopt: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'adopt: missing item name\nUsage: agentenv adopt <name> --into <env>\n', code: 1 };
    }
    if (parsed.positionals.length > 1) {
      return {
        stdout: '',
        stderr: `adopt: unexpected argument '${parsed.positionals[1]}'\nUsage: agentenv adopt <name> --into <env>\n`,
        code: 1,
      };
    }
    const into = parsed.values.get('into');
    if (into === undefined) {
      return { stdout: '', stderr: 'adopt: --into <env> is required (use `agentenv capture` to auto-adopt into the top env)\n', code: 1 };
    }
    const nameError = validateEnvName(into);
    if (nameError) {
      return { stdout: '', stderr: `adopt: --into: ${nameError}\n`, code: 1 };
    }
    if (!(await environmentExists(ctx.paths, into))) {
      return { stdout: '', stderr: `adopt: --into: environment '${into}' does not exist\n`, code: 1 };
    }
    return adoptInto(ctx, name, into);
  },
};

async function adoptInto(ctx: CommandContext, name: string, into: string): Promise<RunResult> {
  const { paths, env, options } = ctx;

  const matches = await findAdoptableItem(paths, name);
  if (matches.length === 0) {
    return {
      stdout: '',
      stderr: `adopt: no adoptable item named '${name}' — it is already owned, or not in an activated managed dir\n`,
      code: 1,
    };
  }
  if (matches.length > 1) {
    const where = matches.map((m) => `  ${m.surfacePath}`).join('\n');
    return { stdout: '', stderr: `adopt: '${name}' is ambiguous — found in more than one surface:\n${where}\n`, code: 1 };
  }
  const { surface, surfacePath } = matches[0]!;

  // Guardrail 1 (foreign manager): NEVER touch a symlink into a non-agentenv root.
  if (await isForeignManagerSymlink(surfacePath, paths.store)) {
    return {
      stdout: '',
      stderr: `adopt: refusing '${name}' — it is a symlink into another manager's root; adopting it would corrupt that manager\n`,
      code: 1,
    };
  }
  // Guardrail 2 (secret): prompt before adopting secret-bearing content.
  if (await itemHasSecret(surfacePath)) {
    const confirm = options.confirm ?? confirmDefault;
    const ok = await confirm(`agentenv: '${name}' looks like it contains a secret. Adopt it into '${into}' anyway? [y/N] `);
    if (!ok) {
      return { stdout: `Did not adopt '${name}' (declined — it matches a secret pattern).\n`, code: 0 };
    }
  }

  const notices: string[] = [];
  const syncCtx = { paths, env, options };
  // `skipAdopt`: this command adopts exactly the named item itself — the lifecycle
  // sweep must not also auto-adopt other pending items behind it.
  const before = await openStoreSync(syncCtx, notices, { skipAdopt: true });
  if (before.quarantined) {
    await closeStoreSync(syncCtx, notices);
    return withNotices({ stdout: `Did NOT adopt '${name}' — pulled store changes were quarantined.\n`, code: 0 }, notices);
  }

  // Place into the CHOSEN env — same surface metadata (scope/realDir), overridden owner.
  const target: AdoptSurface = { ...surface, ownerEnv: into };
  await adoptItem(paths, target, name);
  const noun = singular(surface.storeKind);
  await commitMutation(syncCtx, `agentenv: adopt ${noun} ${name} → ${into}`, notices);
  await closeStoreSync(syncCtx, notices);

  return withNotices({ stdout: `Adopted ${noun} '${name}' → ${into}.\n`, code: 0 }, notices);
}
