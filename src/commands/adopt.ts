import { randomUUID } from 'node:crypto';
import {
  findAdoptableItem,
  isForeignManagerSymlink,
  itemHasSecret,
  planAdoptionRecord,
  singular,
  type AdoptSurface,
} from '../adopt.js';
import { publishAdoptions } from '../adoption-publication.js';
import { parseArgs } from '../args.js';
import type { Command, CommandContext, RunResult } from '../command.js';
import { confirmDefault } from '../prompt.js';
import { capturePathIdentity, identitiesEqual } from '../path-identity.js';
import { environmentExists, validateEnvName } from '../store.js';
import { closeStoreSync, commitRequiredSteps, openStoreSync, withNotices } from './store-sync.js';

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
  const sourceIdentity = await capturePathIdentity(surfacePath);

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
  if (!identitiesEqual(sourceIdentity, await capturePathIdentity(surfacePath))) {
    return {
      stdout: '',
      stderr: `adopt: '${name}' changed while adoption was being confirmed\n`,
      code: 1,
    };
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

  const target: AdoptSurface = { ...surface, ownerEnv: into };
  const record = await planAdoptionRecord(paths, target, name, sourceIdentity);
  if (record.destinationIdentity.kind !== 'absent') {
    await closeStoreSync(syncCtx, notices);
    return withNotices({
      stdout: '',
      stderr: `adopt: destination already exists for '${name}' in environment '${into}'\n`,
      code: 1,
    }, notices);
  }
  const noun = singular(surface.storeKind);
  const transactionId = `adopt-${name}-${randomUUID()}`;
  try {
    const publication = await publishAdoptions({
      paths,
      transactionId,
      kind: 'manual-adopt',
      records: [record],
      notices,
      gitBookkeeping: (steps) =>
        commitRequiredSteps(syncCtx, steps, notices, transactionId),
    });
    if (publication === 'complete') await closeStoreSync(syncCtx, notices);
  } catch (error) {
    await closeStoreSync(syncCtx, notices);
    return withNotices({ stdout: '', stderr: `adopt: ${(error as Error).message}\n`, code: 1 }, notices);
  }

  return withNotices({ stdout: `Adopted ${noun} '${name}' → ${into}.\n`, code: 0 }, notices);
}
