import { createHash, randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  storeToken,
  surfaceRootRelativePath,
  type Adapter,
  type ConfigFormat,
  type ConfigKeysInjection,
  type SurfaceDeclaration,
} from '../adapter.js';
import type { SurfaceComposition } from '../adapter-v2.js';
import type { JsonValue } from '../config-keys.js';
import { renderConfigKeysDriftReport } from '../drift.js';
import { appendRegion, closeMarker, openMarker } from '../file-block.js';
import { writeFileAtomic } from '../fs-atomic.js';
import type { Paths } from '../paths.js';
import { loadResolver, substituteSecretFields } from '../secrets.js';

/**
 * The session view composer (D15). Given an adapter, an env stack and the real
 * config root, it builds a **private config root** for the harness under
 * `~/.agentenv/live/<session>/<harness>/` following the two-bucket rule:
 *
 * - **Bucket 1 (state/identity)** — every real-root entry the adapter classifies
 *   `state` is a per-entry symlink to the real location, so auth/history/caches
 *   read AND write through (the harness stays logged in).
 * - **Bucket 2 (managed)** — each supported surface is composed with its
 *   mechanism: dir-merge (user's real items + env items, per-item, user wins),
 *   file-block (user content + env region), config-keys (real file seeded, env
 *   keys injected).
 *
 * Builds into a temp dir and publishes by **atomic rename**, so a kill mid-build
 * leaves only discardable debris — never a half-view that passes staleness.
 * Rebuilds lazily: only when the fingerprint of enumerated static inputs changed.
 */

/** Bump to force every view to rebuild when the composition logic changes. */
const COMPOSER_VERSION = 1;

/** A surface the composer did not fully apply, surfaced to `status` (D6/D7). */
export interface SurfaceSkip {
  surfaceId: string;
  /**
   * `unsupported` (adapter says so), `collision` (user/earlier item won), `format`
   * (TOML seeding unimplemented), or `secret-unresolved` (a substitute-rung `${VAR}`
   * resolved to nothing → the server is skipped, fail-closed per server, D6).
   */
  reason: 'unsupported' | 'collision' | 'format' | 'secret-unresolved';
  detail: string;
}

export interface ComposeRequest {
  paths: Paths;
  adapter: Adapter;
  /** The env stack; later entries win item-name conflicts, last is top (D5). */
  envs: readonly string[];
  /** The shell session id → `live/<session>/`. */
  session: string;
  /** Where the harness reads config absent an override — the composition source. */
  realConfigRoot: string;
  /**
   * The launch's project root (the harness cwd), threaded into config-keys
   * compilation so a project-path-keyed injection (Codex trust) is representable
   * (H3). `null`/absent when there is no project context.
   */
  projectRoot?: string | null;
  /**
   * Dedup hook (D15): return `true` for a real-root path already owned by
   * agentenv via `--global`, so the view represents it once (through the surface)
   * rather than doubling it as a bucket-1 symlink. Default: nothing is globally
   * owned (session-only, the Phase-1 case). Wired to the manifest by the launch.
   */
  isGloballyOwned?: (realPath: string) => boolean;
  /**
   * The shell env the harness will launch under. `secrets.env` layers over it to
   * resolve the substitute rung's `${VAR}` placeholders (D6). Defaults to
   * `process.env`; passing nothing is safe — passthrough surfaces never read it.
   */
  env?: NodeJS.ProcessEnv;
  onWarn?: (message: string) => void;
  /** Injectable clock for the build timestamp (tests). */
  now?: () => number;
}

export interface ComposeResult {
  /** The published private config root to point the harness at. */
  viewRoot: string;
  /** Whether this launch rebuilt the view (`false` = reused an up-to-date view). */
  rebuilt: boolean;
  /** The staleness fingerprint of enumerated static inputs. */
  fingerprint: string;
  /** Monotonic build counter — increments only on a rebuild (a failable check). */
  generation: number;
  /** Surfaces skipped (unsupported / collision), for `status`. */
  skipped: SurfaceSkip[];
}

/** Persisted beside the view: the staleness marker + build counter. */
interface ViewMeta {
  fingerprint: string;
  generation: number;
  builtAt: number;
  viewRoot: string;
}

const rand = (): string => randomBytes(6).toString('hex');

/** Reject a value that could escape its intended single path segment (L5). */
function assertSafeSegment(value: string, label: string): void {
  if (value === '' || value === '.' || value === '..' || value.includes('..') || /[/\\]/.test(value)) {
    throw new Error(`unsafe ${label} '${value}': must be a single path segment without '..' or separators`);
  }
}

/** Compose (or reuse) the private view for one harness launch. */
export async function composeView(req: ComposeRequest): Promise<ComposeResult> {
  const { paths, adapter, session } = req;
  const onWarn = req.onWarn ?? ((m: string) => console.warn(m));
  const now = req.now ?? Date.now;

  // The session id becomes a path segment under live/; reject anything that could
  // escape it (empty, `.`/`..`, or a separator) before it is joined (L5). A throw
  // here fails open in the launch — a hostile session id never composes.
  assertSafeSegment(session, 'session id');

  const sessionDir = join(paths.live, session);
  const viewRoot = join(sessionDir, adapter.id);
  const metaPath = join(sessionDir, `${adapter.id}.meta.json`);

  await mkdir(sessionDir, { recursive: true });
  // Discard debris from any killed mid-build BEFORE anything reads the view, so a
  // half-built temp dir can never be mistaken for a published view (AC: kill mid-build).
  await discardDebris(sessionDir, adapter.id);

  const fingerprint = await fingerprintInputs(req);
  const prevMeta = await readMeta(metaPath);

  // Lazy generation: reuse an up-to-date, intact view (rebuild nothing).
  if (prevMeta && prevMeta.fingerprint === fingerprint && (await pathExists(viewRoot))) {
    return {
      viewRoot,
      rebuilt: false,
      fingerprint,
      generation: prevMeta.generation,
      skipped: [],
    };
  }

  // Rebuild: compose into a temp dir, then publish by atomic rename.
  const buildDir = join(sessionDir, `.build-${adapter.id}-${rand()}`);
  await mkdir(buildDir, { recursive: true });
  const skipped: SurfaceSkip[] = [];
  try {
    await composeBucketOne(req, buildDir);
    // config-keys surfaces are GROUPED by target file so a file shared by several
    // surfaces is seeded once and written once — composing them per-surface would
    // re-seed and re-write, clobbering earlier surfaces' injections (H4).
    const configKeysByFile = new Map<string, SessionSurfacePlan[]>();
    for (const plan of sessionSurfacePlans(adapter)) {
      const { surface } = plan;
      if (!surface.supported) {
        skipped.push({
          surfaceId: surface.id,
          reason: 'unsupported',
          detail: surface.unsupportedReason ?? `${adapter.id} does not support '${surface.id}'`,
        });
        continue;
      }
      if (surface.mechanism === 'config-keys') {
        const group = configKeysByFile.get(surface.rootRelativePath);
        if (group) group.push(plan);
        else configKeysByFile.set(surface.rootRelativePath, [plan]);
        continue;
      }
      await composeSurface(req, buildDir, plan, skipped, onWarn);
    }
    for (const group of configKeysByFile.values()) {
      await composeConfigKeysFile(req, buildDir, group, skipped, onWarn);
    }
    await publishAtomically(sessionDir, adapter.id, buildDir, viewRoot);
  } catch (err) {
    await rm(buildDir, { recursive: true, force: true });
    throw err;
  }

  const generation = (prevMeta?.generation ?? 0) + 1;
  const meta: ViewMeta = { fingerprint, generation, builtAt: now(), viewRoot };
  await writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  return { viewRoot, rebuilt: true, fingerprint, generation, skipped };
}

// ---------------------------------------------------------------------------
// Bucket 1 — pass-through symlinks for state/identity entries (D15)
// ---------------------------------------------------------------------------

async function composeBucketOne(req: ComposeRequest, buildDir: string): Promise<void> {
  const { adapter, realConfigRoot } = req;
  // An argument-based additional view (Claude) leaves the real config/auth layer
  // active in the child, so copying or linking config-root state into the view is
  // both unnecessary and an isolation/auth regression.
  if (adapter.definition?.session.supported && !adapter.definition.session.launch.rootOverride) {
    return;
  }
  const isGloballyOwned = req.isGloballyOwned ?? (() => false);

  // The top-level names every surface targets. A surface target is bucket-2
  // territory and is composed privately by its mechanism — it must NEVER become a
  // wholesale pass-through symlink, regardless of what classifyEntry says (H2). A
  // mis-classified target would otherwise be symlinked to the real dir and then
  // have per-item env symlinks written THROUGH it into the user's real location.
  const surfaceTargets = new Set(adapter.surfaces.map((s) => topLevelSegment(surfaceRootRelativePath(s))));

  let entries;
  try {
    entries = await readdir(realConfigRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // fresh machine, no real root
    throw err;
  }
  for (const entry of entries) {
    if (surfaceTargets.has(entry.name)) continue; // a surface owns this — never symlink it
    if (adapter.classifyEntry(entry.name) !== 'state') continue; // bucket 2 → composed by a surface
    const realPath = join(realConfigRoot, entry.name);
    if (isGloballyOwned(realPath)) continue; // represented once via --global (D15 dedup)
    // Per-entry symlink: reads AND writes pass through to the real location.
    await symlink(realPath, join(buildDir, entry.name));
  }
}

/** The first path segment of a config-root-relative path (`rules/x` → `rules`). */
function topLevelSegment(rel: string): string {
  return rel.split(/[\\/]/)[0] ?? rel;
}

// ---------------------------------------------------------------------------
// Bucket 2 — the three surface mechanisms, composed into the view
// ---------------------------------------------------------------------------

/** A config-keys surface, narrowed from the discriminated union. */
type ConfigKeysSurfaceDecl = Extract<SurfaceDeclaration, { mechanism: 'config-keys' }>;

interface SessionSurfacePlan {
  /** Session-mode declaration with its explicit view-relative destination. */
  surface: SurfaceDeclaration;
  /** V1 declaration still identifies the user's real source path. */
  source: SurfaceDeclaration;
  inheritUserContent: boolean;
}

function declarationForSession(
  adapter: Adapter,
  source: SurfaceDeclaration,
): SessionSurfacePlan {
  const logical = adapter.definition?.surfaces.find((surface) => surface.id === source.id);
  if (!logical) return { surface: source, source, inheritUserContent: true };
  const mode = logical.session;
  if (!mode.supported) {
    return {
      source,
      inheritUserContent: false,
      surface: { ...source, supported: false, unsupportedReason: mode.reason },
    };
  }
  if (mode.destination.root !== 'view') {
    throw new Error(`session surface '${source.id}' must target the view root`);
  }
  const common = {
    id: source.id,
    storeKind: source.storeKind,
    supported: true as const,
    rootRelativePath: mode.destination.relativePath,
  };
  const composition: SurfaceComposition = mode.composition ?? logical.composition;
  let surface: SurfaceDeclaration;
  if (composition.mechanism === 'dir-merge') {
    surface = { ...common, mechanism: 'dir-merge', ...(composition.mode ? { mode: composition.mode } : {}) };
  } else if (composition.mechanism === 'file-block') {
    surface = { ...common, mechanism: 'file-block', layering: composition.layering };
  } else {
    surface = {
      ...common,
      mechanism: 'config-keys',
      format: composition.format,
      style: composition.style,
      keyPath: composition.keyPath,
      ...(composition.substitutePlaceholders ? { substitutePlaceholders: true } : {}),
    };
  }
  return { surface, source, inheritUserContent: mode.inheritUserContent ?? true };
}

function sessionSurfacePlans(adapter: Adapter): SessionSurfacePlan[] {
  return adapter.surfaces.map((surface) => declarationForSession(adapter, surface));
}

async function composeSurface(
  req: ComposeRequest,
  buildDir: string,
  plan: SessionSurfacePlan,
  skipped: SurfaceSkip[],
  onWarn: (m: string) => void,
): Promise<void> {
  const surface = plan.surface;
  switch (surface.mechanism) {
    case 'dir-merge':
      return composeDirMerge(req, buildDir, plan, skipped, onWarn);
    case 'file-block':
      return composeFileBlock(req, buildDir, plan);
    case 'config-keys':
      throw new Error(`config-keys surface '${surface.id}' was not grouped`);
  }
}

/**
 * dir-merge: a private surface dir holding one link per item — the user's real
 * items first (a non-owned item always wins, D7), then env items with later envs
 * winning earlier ones (D5). Env items go IN-ROOT, never `~/.agents/` (D15).
 */
async function composeDirMerge(
  req: ComposeRequest,
  buildDir: string,
  plan: SessionSurfacePlan,
  skipped: SurfaceSkip[],
  onWarn: (m: string) => void,
): Promise<void> {
  const surface = plan.surface;
  if (surface.mechanism !== 'dir-merge') throw new Error('expected dir-merge surface');
  const { paths, envs, realConfigRoot } = req;
  const targetDir = join(buildDir, surface.rootRelativePath);
  await mkdir(targetDir, { recursive: true });
  const placed = new Set<string>();
  const place = async (name: string, source: string): Promise<void> => {
    if (surface.mode === 'copy') await copyPath(source, join(targetDir, name));
    else await symlink(source, join(targetDir, name));
    placed.add(name);
  };

  // 1. The user's real items win every collision (D7).
  if (plan.inheritUserContent) {
    const sourcePath = surfaceRootRelativePath(plan.source);
    const realDir = join(realConfigRoot, sourcePath);
    for (const name of await listNames(realDir)) {
      await place(name, join(realDir, name));
    }
  }

  // 2. Env items, reversed so a LATER env in the stack wins an EARLIER one (D5).
  for (const env of [...envs].reverse()) {
    const envDir = join(paths.envDir(env), surface.storeKind);
    for (const name of await listNames(envDir)) {
      if (placed.has(name)) {
        const detail = `'${name}' from env '${env}' shadowed in ${surface.id}`;
        onWarn(`agentenv: skipping ${detail} (a user or higher-precedence item wins)`);
        skipped.push({ surfaceId: surface.id, reason: 'collision', detail });
        continue;
      }
      await place(name, join(envDir, name));
    }
  }
}

/**
 * file-block: the generated instruction file layers the user's real content
 * (from the real root) and each env's managed region (D2). Env sub-block edits
 * write back to the store via the sweep (hook point); user-content edits are
 * discarded at session end (D15).
 */
async function composeFileBlock(
  req: ComposeRequest,
  buildDir: string,
  plan: SessionSurfacePlan,
): Promise<void> {
  const surface = plan.surface;
  if (surface.mechanism !== 'file-block') throw new Error('expected file-block surface');
  const { paths, adapter, envs, realConfigRoot } = req;
  const userContent = plan.inheritUserContent
    ? await readFileOrEmpty(join(realConfigRoot, surfaceRootRelativePath(plan.source)))
    : '';

  const regions: string[] = [];
  for (const env of envs) {
    const sources = await instructionSources(paths, adapter, env);
    for (const src of sources) {
      const body =
        surface.layering === 'import' ? `@${src.storePath}` : await readFileOrEmpty(src.storePath);
      if (body.trim() === '') continue;
      regions.push(`${openMarker(env, src.source)}\n${body}\n${closeMarker(env, src.source)}`);
    }
  }

  if (userContent.trim() === '' && regions.length === 0) return; // nothing to write
  const region = regions.join('\n\n');
  const composed = region === '' ? userContent : appendRegion(userContent, region);
  await writeFileAtomic(join(buildDir, surface.rootRelativePath), composed);
}

/** The store instruction files an env contributes: base.md then <harness>.md (D2). */
async function instructionSources(
  paths: Paths,
  adapter: Adapter,
  env: string,
): Promise<{ source: string; storePath: string }[]> {
  const dir = join(paths.envDir(env), 'instructions');
  const out: { source: string; storePath: string }[] = [];
  for (const name of ['base.md', `${storeToken(adapter)}.md`]) {
    const storePath = join(dir, name);
    if (await pathExists(storePath)) out.push({ source: name, storePath });
  }
  return out;
}

/**
 * config-keys: seed the view's config file ONCE from the real one (a discardable
 * copy — mixed-file drift is dropped at session end, D15), then apply the compiled
 * keys of EVERY surface that targets this file, then write ONCE (H4). A shared
 * file (Pi's two-array `settings.json`) is otherwise clobbered by re-seeding per
 * surface. A pre-existing user value wins a collision (D7); later envs win earlier
 * ones (D5). Format-aware: JSON/JSONC parse + reserialise via jsonc-parser/JSON;
 * TOML (Codex `config.toml`, Task 4.1) via smol-toml — a whole-file reserialise is
 * fine for the EPHEMERAL view (unlike the real-config injection, which must be
 * surgical). All surfaces grouped on one file share its format.
 */
async function composeConfigKeysFile(
  req: ComposeRequest,
  buildDir: string,
  plans: readonly SessionSurfacePlan[],
  skipped: SurfaceSkip[],
  onWarn: (m: string) => void,
): Promise<void> {
  const { paths, adapter, envs, realConfigRoot } = req;
  const first = plans[0]!;
  const firstSurface = first.surface;
  if (firstSurface.mechanism !== 'config-keys') throw new Error('expected config-keys surface');
  const file = firstSurface.rootRelativePath;
  const format = firstSurface.format;

  // Secrets resolver for the substitute rung (D6): secrets.env first, then the
  // launching shell's env. The private view is derived and never synced, so a
  // resolved literal here reaches only the ephemeral view — never the store.
  const resolver = await loadResolver(paths, req.env ?? process.env);

  const sourceFile = join(realConfigRoot, surfaceRootRelativePath(first.source));
  const seedText = first.inheritUserContent ? await readFileOrEmpty(sourceFile) : '';
  const seed = parseConfigDoc(format, seedText);
  const userSnapshot = structuredClone(seed);
  // Which env last set each keyed path, so a later env overriding an earlier one
  // records a skip that NAMES the loser (L2 / D5), as dir-merge already does.
  const keyedOwner = new Map<string, string>();

  for (const plan of plans) {
    const surface = plan.surface;
    if (surface.mechanism !== 'config-keys') throw new Error('expected config-keys surface');
    for (const env of envs) {
      let injections: ConfigKeysInjection[];
      try {
        injections = await adapter.compileConfigKeys(surface, {
          envContentDir: paths.envDir(env),
          projectRoot: req.projectRoot ?? null,
          onWarn,
        });
      } catch (err) {
        onWarn(`agentenv: env '${env}' ${surface.id} compile failed: ${(err as Error).message}`);
        continue;
      }
      // Substitute rung (D6): a surface the harness can't interpolate has its
      // compiled `secretFields` placeholders resolved to literals HERE, so the
      // private view is functional; a passthrough surface keeps the `${VAR}`.
      for (const inj of injections) {
        if (inj.style === 'keyed') {
          // A value the USER already had at this path wins (D7); an earlier env's is
          // overwritten by this (later) env (D5).
          const userValue = getAtPath(userSnapshot, inj.keyPath);
          if (userValue.found) {
            const detail = `${surface.id} key '${inj.keyPath.join('.')}' — user value wins`;
            onWarn(`agentenv: skipping ${detail} (env '${env}')`);
            skipped.push({ surfaceId: surface.id, reason: 'collision', detail });
            // The user's own entry and the canonical store DISAGREE — the session-mode
            // form of the same drift the global sweep reports. Say exactly how, so a
            // session user learns it from the launch rather than never (the private view
            // is rebuilt from canonical every launch, so nothing else would surface it).
            // Reporting only: `mcp/servers.yaml` is not touched here either.
            if (plan.inheritUserContent) {
              await reportUserValueDrift(
                req,
                surface,
                sourceFile,
                env,
                inj.keyPath,
                userValue.value,
                onWarn,
              );
            }
            continue;
          }
          // Resolve substitute-rung placeholders; unresolved → fail closed per server.
          let value = inj.value;
          if (
            surface.substitutePlaceholders &&
            inj.secretFields &&
            Object.keys(inj.secretFields).length > 0
          ) {
            const sub = substituteSecretFields(inj.value, inj.secretFields, (n) => resolver.resolve(n));
            if (sub.unresolved.length > 0) {
              const detail = `${surface.id} key '${inj.keyPath.join('.')}' skipped — unresolved secret(s): ${sub.unresolved.join(', ')}`;
              onWarn(`agentenv: ${detail} (env '${env}')`);
              skipped.push({ surfaceId: surface.id, reason: 'secret-unresolved', detail });
              continue;
            }
            value = sub.value;
          }
          const pathKey = JSON.stringify([...inj.keyPath]);
          const prevEnv = keyedOwner.get(pathKey);
          if (prevEnv !== undefined && prevEnv !== env) {
            const detail = `${surface.id} key '${inj.keyPath.join('.')}' — env '${prevEnv}' overridden by env '${env}'`;
            onWarn(`agentenv: ${detail}`);
            skipped.push({ surfaceId: surface.id, reason: 'collision', detail });
          }
          keyedOwner.set(pathKey, env);
          setAtPath(seed, inj.keyPath, value);
        } else {
          const arr = ensureArray(seed, inj.arrayPath);
          if (!arr.some((v) => stableEqual(v, inj.value))) arr.push(inj.value);
        }
      }
    }
  }

  await writeFileAtomic(join(buildDir, file), serializeConfigDoc(format, seed));
}

/**
 * Report how a USER'S OWN value at an owned key path disagrees with the env's canonical
 * store — the session-mode half of the "detect and report, never write" contract.
 *
 * In global mode agentenv owns keys in the real config, so the drift sweep sees an edit
 * and reports it. In session mode it owns nothing there: the private view is rebuilt from
 * canonical each launch and a pre-existing user entry simply WINS (D7). Without this the
 * disagreement would never be surfaced at all — the user would keep getting their own
 * entry with no hint that the store says something different.
 *
 * Reporting only. Nothing under `environments/<env>/` is written here (the classifier
 * reads canonical to diff against), and a classifier failure is swallowed — a launch must
 * never fail because a report could not be produced.
 */
async function reportUserValueDrift(
  req: ComposeRequest,
  surface: ConfigKeysSurfaceDecl,
  configFile: string,
  env: string,
  keyPath: readonly (string | number)[],
  userValue: unknown,
  onWarn: (m: string) => void,
): Promise<void> {
  const describe = req.adapter.describeConfigKeysDrift;
  if (!describe) return;
  const envContentDir = req.paths.envDir(env);
  try {
    const report = await describe.call(
      req.adapter,
      surface,
      { style: 'keyed', keyPath, canonicalValue: userValue as JsonValue },
      { envContentDir, projectRoot: req.projectRoot ?? null, onWarn },
    );
    if (!report || report.changes.length === 0) return;
    onWarn(
      renderConfigKeysDriftReport({
        adapterId: req.adapter.id,
        surfaceId: surface.id,
        configFile,
        ownerEnv: env,
        canonicalFile: join(envContentDir, report.storeRelativePath),
        report,
      }),
    );
  } catch {
    // A report is a courtesy; never let one break a launch.
  }
}

/** Parse a config-keys document by format; an empty/absent file is an empty object. */
function parseConfigDoc(format: ConfigFormat, text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  if (format === 'toml') return parseToml(text) as Record<string, unknown>;
  return parseJsonc(text) as Record<string, unknown>;
}

/** Reserialise a config-keys document by format, with a trailing newline. */
function serializeConfigDoc(format: ConfigFormat, seed: Record<string, unknown>): string {
  if (format === 'toml') return `${stringifyToml(seed)}\n`;
  return `${JSON.stringify(seed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Atomic publish + debris discard
// ---------------------------------------------------------------------------

/**
 * Publish `buildDir` to `viewRoot` by rename, so the published view is only ever
 * whole. `rename` cannot replace a non-empty dir, so an existing view is moved
 * aside first and deleted after — a brief absence, never a partial view.
 */
async function publishAtomically(
  sessionDir: string,
  harnessId: string,
  buildDir: string,
  viewRoot: string,
): Promise<void> {
  const graveyard = join(sessionDir, `${harnessId}.old-${rand()}`);
  let hadOld = false;
  try {
    await rename(viewRoot, graveyard);
    hadOld = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await rename(buildDir, viewRoot);
  if (hadOld) await rm(graveyard, { recursive: true, force: true });
}

/** Remove any leftover build/graveyard dirs for this harness (killed mid-build). */
async function discardDebris(sessionDir: string, harnessId: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const buildPrefix = `.build-${harnessId}-`;
  const oldPrefix = `${harnessId}.old-`;
  for (const entry of entries) {
    if (entry.name.startsWith(buildPrefix) || entry.name.startsWith(oldPrefix)) {
      await rm(join(sessionDir, entry.name), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Staleness fingerprint (D15) — hash of enumerated static inputs
// ---------------------------------------------------------------------------

/**
 * Fingerprint every static input the view is composed from, so an unchanged
 * input set reuses the view and any change triggers a rebuild: the env stack and
 * adapter, the real root's top-level listing (a new state file appears next
 * launch), and per-surface the env store content (content-hashed — it is ours
 * and small) plus the real target the surface reads.
 */
async function fingerprintInputs(req: ComposeRequest): Promise<string> {
  const { paths, adapter, envs, realConfigRoot } = req;
  const parts: unknown[] = [
    COMPOSER_VERSION,
    adapter.id,
    // Adapter structural declaration (L1): a surface/mechanism/path/keyPath change
    // or an override-env change — i.e. an adapter UPGRADE — invalidates stale views.
    adapter.surfaces,
    adapter.configRootEnv,
    [...envs],
    req.projectRoot ?? null,
    await dirSignature(realConfigRoot),
  ];

  for (const surface of adapter.surfaces) {
    if (!surface.supported) {
      parts.push([surface.id, 'unsupported']);
      continue;
    }
    const storeSigs: string[] = [];
    for (const env of envs) {
      // Cheap immediate-children signature (name/kind/size/mtime), matching what
      // real dir-merge targets already use — NOT a full recursive content hash of
      // the store tree on every launch (M4, a startup-perf footgun). This catches
      // the cases that matter: file-block reads flat instruction files, config-keys
      // reads flat store files, and symlink dir-merge references the store live.
      const storeDir =
        surface.mechanism === 'file-block'
          ? join(paths.envDir(env), 'instructions')
          : join(paths.envDir(env), surface.storeKind);
      storeSigs.push(await dirSignature(storeDir));
    }
    let realSig: string;
    if (surface.mechanism === 'dir-merge') {
      realSig = await dirSignature(join(realConfigRoot, surface.rootRelativePath));
    } else {
      realSig = await fileSignature(join(realConfigRoot, surface.rootRelativePath));
    }
    parts.push([surface.id, storeSigs, realSig]);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Immediate-children signature (name/kind/size/mtime): a change in listing rebuilds. */
async function dirSignature(dir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 'absent';
  }
  const rows: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : 'f';
    let sz = '';
    let mt = '';
    try {
      const st = await lstat(join(dir, e.name));
      sz = String(st.size);
      mt = String(st.mtimeMs);
    } catch {
      /* raced away */
    }
    rows.push(`${e.name}:${kind}:${sz}:${mt}`);
  }
  return rows.join('|');
}

/** Content hash of a file (store content is ours and small), or `absent`. */
async function fileSignature(file: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch {
    return 'absent';
  }
}

// ---------------------------------------------------------------------------
// small fs + json helpers
// ---------------------------------------------------------------------------

async function readMeta(metaPath: string): Promise<ViewMeta | null> {
  try {
    const data = JSON.parse(await readFile(metaPath, 'utf8')) as ViewMeta;
    if (typeof data.fingerprint === 'string' && typeof data.generation === 'number') return data;
  } catch {
    /* absent or corrupt → treat as stale */
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function copyPath(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest);
  } else if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const e of await readdir(src, { withFileTypes: true })) {
      await copyPath(join(src, e.name), join(dest, e.name));
    }
  } else {
    await mkdir(join(dest, '..'), { recursive: true });
    await copyFile(src, dest);
  }
}

interface PathProbe {
  found: boolean;
  value: unknown;
}
function getAtPath(root: unknown, path: readonly (string | number)[]): PathProbe {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || seg < 0 || seg >= cur.length) return { found: false, value: undefined };
      cur = cur[seg];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[seg as string];
    }
  }
  return { found: true, value: cur };
}

function setAtPath(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    const next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cur[last as string] = value;
}

function ensureArray(root: Record<string, unknown>, path: readonly (string | number)[]): unknown[] {
  const probe = getAtPath(root, path);
  if (probe.found && Array.isArray(probe.value)) return probe.value as unknown[];
  const arr: unknown[] = [];
  setAtPath(root, path, arr);
  return arr;
}

/**
 * Order-insensitive structural equality for array-element dedup (L4): two object
 * values that differ only in key ORDER are the same element, so a re-run does not
 * append a duplicate. Sorts object keys recursively before stringifying.
 */
function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
