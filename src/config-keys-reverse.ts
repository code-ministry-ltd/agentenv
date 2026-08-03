import { relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { Adapter, ConfigKeysSurface } from './adapter.js';
import {
  inspectRetainedConfigKey,
  type JsonValue,
  type RetainedConfigKeysProvenance,
} from './config-keys.js';
import { scanTextForSecrets } from './git.js';
import { capturePathIdentity, identitiesEqual, type PathIdentity } from './path-identity.js';
import type { Paths } from './paths.js';

interface CanonicalPatch {
  entry: string;
  value?: JsonValue;
}

interface CanonicalFilePlan {
  path: string;
  baseline: PathIdentity;
  patches: CanonicalPatch[];
  text?: string;
}

export interface RetainedConfigCanonicalWrite {
  path: string;
  text: string;
  mode?: number;
}

function containedPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function findSurface(
  adapters: readonly Adapter[],
  adapterId: string,
  surfaceId: string,
): { adapter: Adapter; surface: ConfigKeysSurface } | null {
  const adapter = adapters.find((candidate) => candidate.id === adapterId);
  const surface = adapter?.surfaces.find(
    (candidate): candidate is ConfigKeysSurface =>
      candidate.id === surfaceId && candidate.mechanism === 'config-keys',
  );
  return adapter && surface ? { adapter, surface } : null;
}

/** Plan and apply lossless entry-level inversions from one retained config file. */
export async function reconcileRetainedConfigKeysProjection(
  paths: Paths,
  retainedPath: string,
  provenance: RetainedConfigKeysProvenance,
  adapters: readonly Adapter[],
): Promise<RetainedConfigCanonicalWrite[]> {
  const plans = new Map<string, CanonicalFilePlan>();

  for (const entry of provenance.items) {
    const observed = await inspectRetainedConfigKey(retainedPath, entry.item);
    if (observed.kind === 'unchanged') continue;
    const match = findSurface(adapters, entry.adapterId, entry.surfaceId);
    if (!match?.adapter.reverseConfigKeysDrift) {
      throw new Error(`adapter '${entry.adapterId}' cannot reverse retained config fields`);
    }
    if (!entry.canonicalPath || !entry.canonicalBaseline) {
      throw new Error('retained config-key canonical provenance is incomplete');
    }
    const envRoot = paths.envDir(entry.item.ownerEnv);
    const reversed = await match.adapter.reverseConfigKeysDrift(
      match.surface,
      {
        style: entry.item.mode,
        keyPath: entry.item.keyPath,
        removed: observed.kind === 'removed',
        ...(observed.kind === 'changed' ? { canonicalValue: observed.canonicalValue } : {}),
      },
      { envContentDir: envRoot, projectRoot: null },
    );
    if (reversed.kind !== 'lossless') {
      throw new Error(`retained config-key inversion is ${reversed.kind}: ${reversed.reason}`);
    }
    const target = resolve(envRoot, reversed.storeRelativePath);
    if (!containedPath(envRoot, target) || target !== resolve(entry.canonicalPath)) {
      throw new Error('adapter reverse target does not match retained canonical provenance');
    }
    if (!identitiesEqual(await capturePathIdentity(target), entry.canonicalBaseline)) {
      throw new Error(`canonical config changed concurrently for entry '${reversed.entry}'`);
    }
    const current = plans.get(target);
    if (current && !identitiesEqual(current.baseline, entry.canonicalBaseline)) {
      throw new Error('retained entries disagree about their canonical baseline');
    }
    const plan = current ?? {
      path: target,
      baseline: entry.canonicalBaseline,
      patches: [],
    };
    if (plan.patches.some((patch) => patch.entry === reversed.entry)) {
      throw new Error(`duplicate retained patch for canonical entry '${reversed.entry}'`);
    }
    plan.patches.push({
      entry: reversed.entry,
      ...('value' in reversed ? { value: reversed.value } : {}),
    });
    plans.set(target, plan);
  }

  for (const plan of plans.values()) {
    const input = await readFile(plan.path, 'utf8');
    const document = parseDocument(input);
    if (document.errors.length > 0) {
      throw new Error(`canonical config is malformed at '${plan.path}'`);
    }
    for (const patch of plan.patches) {
      if (patch.value === undefined) document.deleteIn([patch.entry]);
      else document.setIn([patch.entry], patch.value);
    }
    plan.text = String(document);
    const secretCount = scanTextForSecrets(plan.text).length;
    if (secretCount > 0) {
      throw new Error(
        `reverse-projected canonical config has ${secretCount} suspected secret finding(s)`,
      );
    }
  }

  return [...plans.values()].map((plan) => ({
    path: plan.path,
    text: plan.text!,
    ...(plan.baseline.kind === 'file' ? { mode: plan.baseline.mode } : {}),
  }));
}
