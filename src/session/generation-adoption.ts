import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  isAdoptableItemShape,
  isForeignManagerSymlink,
  itemHasSecret,
  itemMatchesCaptureIgnore,
} from '../adopt.js';
import type { StagedBundleEntry } from '../filesystem-bundle.js';
import { capturePathIdentity, identitiesEqual } from '../path-identity.js';
import type { Paths } from '../paths.js';
import { environmentExists, readEnvConfig, validateEnvName } from '../store.js';
import type { ViewGeneration } from '../view-generation.js';

type AdoptableStoreKind = 'skills' | 'agents' | 'commands';

export interface GenerationAdoptionRecord {
  name: string;
  storeKind: AdoptableStoreKind;
  ownerEnv: string;
  sourcePath: string;
  storePath: string;
}

export interface GenerationAdoptionPlan {
  entries: StagedBundleEntry[];
  adopted: GenerationAdoptionRecord[];
  ignored: GenerationAdoptionRecord[];
}

export interface PlanGenerationAdoptionsRequest {
  paths: Paths;
  generation: ViewGeneration;
  stagingRoot: string;
}

function isAdoptableStoreKind(value: string): value is AdoptableStoreKind {
  return value === 'skills' || value === 'agents' || value === 'commands';
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function listNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function singular(kind: AdoptableStoreKind): string {
  return kind === 'skills' ? 'skill' : kind === 'agents' ? 'agent' : 'command';
}

/**
 * Plan safe canonical copies for items created inside an immutable session
 * generation. Sources remain in the retained generation; the filesystem command
 * WAL publishes only staged canonical copies, so rollback never destroys the
 * session-born identity.
 */
export async function planSessionGenerationAdoptions(
  req: PlanGenerationAdoptionsRequest,
): Promise<GenerationAdoptionPlan> {
  const result: GenerationAdoptionPlan = { entries: [], adopted: [], ignored: [] };
  const viewRoot = req.generation.viewRoot;
  if (!viewRoot || !containedBy(join(req.paths.live, 'generations', req.generation.id), viewRoot)) {
    throw new Error('generation view root is missing or outside its retained generation');
  }

  const destinations = new Set<string>();
  const configByOwner = new Map<string, readonly string[]>();
  for (const inventory of req.generation.inventory ?? []) {
    if (
      inventory.mechanism !== 'dir-merge' ||
      !isAdoptableStoreKind(inventory.storeKind) ||
      !Array.isArray(inventory.baseline)
    ) {
      continue;
    }
    if (!containedBy(viewRoot, inventory.path)) {
      throw new Error(`generation inventory '${inventory.surfaceId}' escapes its retained view`);
    }
    const names = (await listNames(inventory.path)).filter(
      (name) => !inventory.baseline.includes(name),
    );
    if (names.length === 0) continue;

    const owner = inventory.ownerEnv;
    const launchOwner = req.generation.envs.at(-1) ?? null;
    if (
      !owner ||
      validateEnvName(owner) !== null ||
      owner !== launchOwner ||
      !(await environmentExists(req.paths, owner))
    ) {
      throw new Error(
        `session-born ${inventory.storeKind} retained because launch-time owner ` +
          `'${owner ?? '(none)'}' is no longer valid`,
      );
    }
    let ignore = configByOwner.get(owner);
    if (!ignore) {
      ignore = (await readEnvConfig(req.paths, owner)).capture?.ignore ?? [];
      configByOwner.set(owner, ignore);
    }

    for (const name of names) {
      const sourcePath = join(inventory.path, name);
      const storePath = join(req.paths.envDir(owner), inventory.storeKind, name);
      const record: GenerationAdoptionRecord = {
        name,
        storeKind: inventory.storeKind,
        ownerEnv: owner,
        sourcePath,
        storePath,
      };
      if (await itemMatchesCaptureIgnore(ignore, inventory.storeKind, name, sourcePath)) {
        result.ignored.push(record);
        continue;
      }
      if (name.startsWith('.')) {
        throw new Error(`session-born ${singular(inventory.storeKind)} '${name}' has an invalid hidden name`);
      }
      if (await isForeignManagerSymlink(sourcePath, req.paths.store)) {
        result.ignored.push(record);
        continue;
      }
      if (!(await isAdoptableItemShape(inventory.storeKind, sourcePath))) {
        throw new Error(
          `session-born ${singular(inventory.storeKind)} '${name}' is malformed; retained for explicit resolution`,
        );
      }
      if (await itemHasSecret(sourcePath)) {
        throw new Error(
          `session-born ${singular(inventory.storeKind)} '${name}' has suspected secret content; ` +
            'retained for explicit confirmation',
        );
      }
      if (destinations.has(resolve(storePath))) {
        throw new Error(`session-born item '${name}' has ambiguous duplicate ownership`);
      }
      const destinationIdentity = await capturePathIdentity(storePath);
      if (destinationIdentity.kind !== 'absent') {
        throw new Error(
          `session-born ${singular(inventory.storeKind)} '${name}' destination already exists; ` +
            'both identities were retained',
        );
      }

      const sourceBefore = await capturePathIdentity(sourcePath);
      const staged = join(req.stagingRoot, `adoption-${result.entries.length}`);
      await mkdir(dirname(staged), { recursive: true });
      await cp(sourcePath, staged, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      const sourceAfter = await capturePathIdentity(sourcePath);
      if (!identitiesEqual(sourceBefore, sourceAfter)) {
        throw new Error(`session-born item '${name}' changed while its canonical copy was staged`);
      }
      const stagedIdentity = await capturePathIdentity(staged);
      if (!identitiesEqual(sourceBefore, stagedIdentity)) {
        throw new Error(`session-born item '${name}' could not be staged byte-for-byte`);
      }
      destinations.add(resolve(storePath));
      result.entries.push({ id: `adoption-${result.entries.length}`, target: storePath, staged });
      result.adopted.push(record);
    }
  }
  return result;
}
