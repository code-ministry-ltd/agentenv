import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMap, isNode, parseDocument } from 'yaml';
import type { CommandPlan } from '../command-plan.js';
import { CommandPathPreconditionError } from '../command-wal.js';
import {
  validateItemName,
  parseFrontmatter,
  validateSkillName,
} from '../content-items.js';
import {
  copyEnvSource,
  parseEnvConfig,
  removeEnvSource,
  type EnvConfig,
} from '../env-config.js';
import {
  captureExpectedPathIdentity,
  capturePathIdentity,
  capturePathLocationIdentity,
  identitiesEqual,
  type PathIdentity,
} from '../path-identity.js';
import { assertNoFollowContainment } from '../path-containment.js';
import type { Paths } from '../paths.js';
import { readState } from '../state.js';
import {
  StagedCommandExpectedIdentityError,
  StagedCommandPreconditionError,
  type StagedCommandEntry,
  type StagedCommandPrecondition,
} from '../staged-command.js';
import { validateEnvName } from '../store.js';
import type { ContentTransferRuntime } from './content-transfer-runtime.js';

export type ContentLocator =
  | { kind: 'skill'; environment: string; name: string }
  | { kind: 'instruction'; environment: string; name: string }
  | { kind: 'mcp'; environment: string; name: string }
  | { kind: 'agent'; environment: string; name: string }
  | { kind: 'command'; environment: string; name: string };

const CONTENT_KINDS = new Set<ContentLocator['kind']>([
  'skill',
  'instruction',
  'mcp',
  'agent',
  'command',
]);

export interface ContentTransferFaults {
  afterSourceCopy?: () => Promise<void>;
  afterStage?: () => Promise<void>;
  afterApply?: (operationId: string) => Promise<void>;
  afterPersist?: (plan: CommandPlan) => Promise<void>;
}

export interface CopyContentInput {
  paths: Paths;
  source: ContentLocator;
  destination: ContentLocator;
  collision?: 'fail' | 'overwrite';
  runtime: ContentTransferRuntime;
  faults?: ContentTransferFaults;
  /** Browser-observed public identities. When supplied, the authoritative copy
   * capture must still match them before collision consent can be applied. */
  observedRevisions?: {
    sourceItem: string;
    sourceEnvironment: string;
    sourceEnvironmentContainer: string;
    destinationEnvironment: string;
    destinationEnvironmentContainer: string;
    destinationItem: string | null;
  };
}

export type MoveContentInput = CopyContentInput;

export type CopyContentResult =
  | {
      status: 'copied';
      operation: 'copy';
      kind: ContentLocator['kind'];
      name: string;
      transactionId: string;
      publication: 'complete';
    }
  | {
      status: 'git-pending';
      operation: 'copy';
      kind: ContentLocator['kind'];
      name: string;
      transactionId: string;
      publication: 'git-pending';
    }
  | { status: 'invalid'; field: 'source' | 'destination'; message: string }
  | { status: 'not-found'; field: 'source' | 'destination' }
  | { status: 'collision'; kind: ContentLocator['kind']; name: string }
  | { status: 'pending-recovery'; transactionId: string }
  | {
      status: 'stale';
      field:
        | 'source'
        | 'destination'
        | 'source-container'
        | 'destination-container';
      message: string;
    }
  | { status: 'failure'; message: string };

export type MoveContentResult =
  | {
      status: 'moved';
      operation: 'move';
      kind: ContentLocator['kind'];
      name: string;
      transactionId: string;
      publication: 'complete';
    }
  | {
      status: 'git-pending';
      operation: 'move';
      kind: ContentLocator['kind'];
      name: string;
      transactionId: string;
      publication: 'git-pending';
    }
  | Exclude<CopyContentResult,
      { status: 'copied' } | { status: 'git-pending'; operation: 'copy' }>;

type TransferOperation = 'copy' | 'move';
type ContentTransferResult = CopyContentResult | MoveContentResult;

class ContentLocationError extends Error {
  constructor(readonly field: 'source' | 'destination', readonly missing: boolean) {
    super('content location is unavailable');
    this.name = 'ContentLocationError';
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function stableStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function stableDirectoryStatsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function publicRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function canonicalPathIdentity(identity: PathIdentity): PathIdentity {
  switch (identity.kind) {
    case 'absent': return { kind: 'absent' };
    case 'file': return { kind: 'file', digest: identity.digest, mode: identity.mode };
    case 'directory': return { kind: 'directory', digest: identity.digest, mode: identity.mode };
    case 'directory-location': return {
      kind: 'directory-location',
      device: identity.device,
      inode: identity.inode,
      mode: identity.mode,
    };
    case 'symlink': return { kind: 'symlink', target: identity.target };
  }
}

function publicIdentityRevision(identity: PathIdentity): string {
  return publicRevision(canonicalPathIdentity(identity));
}

/** Read one regular file without following its final component and prove the
 * descriptor stayed stable and still names the current directory entry. */
async function readStableRegularFile(path: string): Promise<{
  bytes: Buffer;
  identity: Extract<PathIdentity, { kind: 'file' }>;
  entry: { device: string; inode: string };
}> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('expected a regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!stableStatsEqual(before, after)) throw new Error('file changed while being read');
    const current = await lstat(path, { bigint: true });
    if (!stableStatsEqual(current, after)) throw new Error('file path changed while being read');
    return {
      bytes,
      identity: {
        kind: 'file',
        digest: createHash('sha256').update(bytes).digest('hex'),
        mode: Number(after.mode & 0o7777n),
      },
      entry: { device: String(after.dev), inode: String(after.ino) },
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Capture a complete physical directory identity without following any
 * symlink, optionally materialising the exact bytes and modes in a private
 * destination. Every file is read through a stable O_NOFOLLOW descriptor. */
async function snapshotStablePhysicalTree(
  source: string,
  destination?: string,
): Promise<Extract<PathIdentity, { kind: 'directory' }> & {
  device: string;
  inode: string;
  treeDigest: string;
}> {
  const hash = createHash('sha256');
  const entryHash = createHash('sha256');
  const physicalRoot = resolve(source);
  const walk = async (sourceDirectory: string, destinationDirectory: string | undefined, prefix: string) => {
    const before = await lstat(sourceDirectory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('expected a physical directory');
    }
    if (prefix === '') {
      entryHash
        .update('.\0d\0')
        .update(String(before.dev))
        .update('\0')
        .update(String(before.ino))
        .update('\0');
    }
    if (destinationDirectory) {
      await mkdir(destinationDirectory, { recursive: true });
      await chmod(destinationDirectory, Number(before.mode & 0o7777n));
    }
    const entries = (await readdir(sourceDirectory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('\0')) {
        throw new Error('directory contains an unsafe entry name');
      }
      const sourceChild = join(sourceDirectory, entry.name);
      const destinationChild = destinationDirectory
        ? join(destinationDirectory, entry.name)
        : undefined;
      const childStats = await lstat(sourceChild, { bigint: true });
      const childRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childKind = childStats.isSymbolicLink()
        ? 'l'
        : childStats.isDirectory()
          ? 'd'
          : childStats.isFile()
            ? 'f'
            : 'x';
      entryHash
        .update(childRelative)
        .update('\0')
        .update(childKind)
        .update('\0')
        .update(String(childStats.dev))
        .update('\0')
        .update(String(childStats.ino))
        .update('\0');
      hash
        .update(childRelative)
        .update('\0')
        .update(String(childStats.mode & 0o7777n))
        .update('\0');
      if (childStats.isSymbolicLink()) {
        const target = await readlink(sourceChild);
        const afterLink = await lstat(sourceChild, { bigint: true });
        if (
          !afterLink.isSymbolicLink() ||
          childStats.dev !== afterLink.dev ||
          childStats.ino !== afterLink.ino ||
          childStats.mode !== afterLink.mode ||
          childStats.size !== afterLink.size ||
          childStats.mtimeNs !== afterLink.mtimeNs ||
          childStats.ctimeNs !== afterLink.ctimeNs ||
          isAbsolute(target) ||
          !isContained(physicalRoot, resolve(dirname(sourceChild), target))
        ) {
          throw new Error('directory contains an unsafe symbolic link');
        }
        hash.update('l\0').update(target).update('\0');
        if (destinationChild) await symlink(target, destinationChild);
        continue;
      }
      if (childStats.isDirectory()) {
        hash.update('d\0');
        await walk(sourceChild, destinationChild, childRelative);
        continue;
      }
      if (!childStats.isFile()) throw new Error('directory contains an unsupported entry');
      const file = await readStableRegularFile(sourceChild);
      const stableStats = await lstat(sourceChild, { bigint: true });
      if (!stableStatsEqual(childStats, stableStats)) {
        throw new Error('directory file changed while being snapshotted');
      }
      hash.update('f\0').update(file.bytes).update('\0');
      if (destinationChild) {
        await writeFile(destinationChild, file.bytes);
        await chmod(destinationChild, file.identity.mode);
      }
    }
    const afterEntries = (await readdir(sourceDirectory)).sort((left, right) =>
      left.localeCompare(right));
    const after = await lstat(sourceDirectory, { bigint: true });
    if (
      !stableDirectoryStatsEqual(before, after) ||
      afterEntries.length !== entries.length ||
      afterEntries.some((name, index) => name !== entries[index]?.name)
    ) {
      throw new Error('directory changed while being snapshotted');
    }
    return before;
  };
  const root = await walk(source, destination, '');
  return {
    kind: 'directory',
    digest: hash.digest('hex'),
    mode: Number(root.mode & 0o7777n),
    device: String(root.dev),
    inode: String(root.ino),
    treeDigest: entryHash.digest('hex'),
  };
}

function itemNameError(locator: ContentLocator): string | null {
  return locator.kind === 'skill'
    ? validateSkillName(locator.name)
    : validateItemName(locator.kind, locator.name);
}

function contentPath(paths: Paths, locator: ContentLocator): string {
  const root = paths.envDir(locator.environment);
  switch (locator.kind) {
    case 'skill': return join(root, 'skills', locator.name);
    case 'instruction': return join(root, 'instructions', `${locator.name}.md`);
    case 'mcp': return join(root, 'mcp', 'servers.yaml');
    case 'agent': return join(root, 'agents', `${locator.name}.md`);
    case 'command': return join(root, 'commands', `${locator.name}.md`);
  }
}

function contentContainer(paths: Paths, locator: ContentLocator): string {
  const root = paths.envDir(locator.environment);
  switch (locator.kind) {
    case 'skill': return join(root, 'skills');
    case 'instruction': return join(root, 'instructions');
    case 'mcp': return join(root, 'mcp');
    case 'agent': return join(root, 'agents');
    case 'command': return join(root, 'commands');
  }
}

interface InspectedEnvironment {
  identity: PathIdentity;
  stableEntry?: { device: string; inode: string; treeDigest: string };
  locationIdentity: PathIdentity;
  yamlIdentity: PathIdentity;
  yamlEntry: { device: string; inode: string };
  yamlText: string;
  config: EnvConfig;
}

async function inspectEnvironment(
  paths: Paths,
  environment: string,
  field: 'source' | 'destination',
  stableTree = false,
): Promise<InspectedEnvironment> {
  const environmentPath = paths.envDir(environment);
  await assertNoFollowContainment(paths.environments, environmentPath, {
    includeCandidate: true,
    label: 'content environment',
  });
  const locationIdentity = await capturePathLocationIdentity(environmentPath);
  if (locationIdentity.kind === 'absent') throw new ContentLocationError(field, true);
  if (locationIdentity.kind !== 'directory-location') throw new ContentLocationError(field, false);
  const stableEnvironment = stableTree
    ? await snapshotStablePhysicalTree(environmentPath)
    : undefined;
  const environmentIdentity = stableEnvironment ?? await capturePathIdentity(environmentPath);
  const observedYamlIdentity = await capturePathIdentity(paths.envYaml(environment));
  if (observedYamlIdentity.kind !== 'file') {
    throw new ContentLocationError(field, observedYamlIdentity.kind === 'absent');
  }
  const yaml = await readStableRegularFile(paths.envYaml(environment));
  if (!identitiesEqual(observedYamlIdentity, yaml.identity)) {
    throw new ContentLocationError(field, false);
  }
  const yamlText = yaml.bytes.toString('utf8');
  return {
    identity: environmentIdentity,
    ...(stableEnvironment === undefined ? {} : {
      stableEntry: {
        device: stableEnvironment.device,
        inode: stableEnvironment.inode,
        treeDigest: stableEnvironment.treeDigest,
      },
    }),
    locationIdentity,
    yamlIdentity: yaml.identity,
    yamlEntry: yaml.entry,
    yamlText,
    config: parseEnvConfig(yamlText, 'environment manifest'),
  };
}

async function inspectContainer(
  environmentRoot: string,
  path: string,
  required: boolean,
  field: 'source' | 'destination',
): Promise<PathIdentity> {
  await assertNoFollowContainment(environmentRoot, path, {
    includeCandidate: true,
    label: 'content container',
  });
  const identity = await capturePathIdentity(path);
  if (identity.kind === 'absent') {
    if (required) throw new ContentLocationError(field, true);
    return identity;
  }
  if (identity.kind !== 'directory') throw new ContentLocationError(field, false);
  return capturePathLocationIdentity(path);
}

async function validateSkillTree(
  path: string,
): Promise<Extract<PathIdentity, { kind: 'directory' }> & {
  device: string;
  inode: string;
  treeDigest: string;
}> {
  const before = await snapshotStablePhysicalTree(path);
  const skillMd = await readStableRegularFile(join(path, 'SKILL.md'));
  const frontmatter = parseFrontmatter(skillMd.bytes.toString('utf8'));
  const name = frontmatter?.name;
  if (
    typeof name !== 'string' ||
    validateSkillName(name) !== null ||
    name !== basename(path)
  ) {
    throw new Error('skill source is invalid');
  }
  const after = await snapshotStablePhysicalTree(path);
  if (!identitiesEqual(before, after)) throw new Error('skill source changed during validation');
  return before;
}

function copyMcpEntry(
  sourceText: string,
  destinationText: string | undefined,
  sourceName: string,
  destinationName: string,
): { text: string; collision: boolean } {
  const source = parseDocument(sourceText);
  const destination = parseDocument(destinationText ?? '{}\n');
  if (
    source.errors.length > 0 ||
    destination.errors.length > 0 ||
    !isMap(source.contents) ||
    !isMap(destination.contents)
  ) {
    throw new Error('MCP catalogue must be a mapping');
  }
  const sourceNode = source.get(sourceName, true);
  if (!isNode(sourceNode)) {
    throw new ContentLocationError('source', true);
  }
  const collision = destination.has(destinationName);
  destination.set(destinationName, sourceNode.clone());
  return { text: destination.toString(), collision };
}

function removeMcpEntry(sourceText: string, sourceName: string): string {
  const source = parseDocument(sourceText);
  if (source.errors.length > 0 || !isMap(source.contents) || !source.has(sourceName)) {
    throw new ContentLocationError('source', true);
  }
  source.delete(sourceName);
  return source.toString();
}

function staleField(id: string): ContentTransferResult & { status: 'stale' } {
  if (
    id === 'source-content' ||
    id === 'source-manifest' ||
    id === 'source-environment' ||
    id === 'source-environment-snapshot'
  ) {
    return { status: 'stale', field: 'source', message: 'source content changed before copy' };
  }
  if (id === 'source-container') {
    return {
      status: 'stale',
      field: 'source-container',
      message: 'source container changed before copy',
    };
  }
  if (id === 'destination-environment' || id === 'destination-container' || id === 'environment-container') {
    return {
      status: 'stale',
      field: 'destination-container',
      message: 'destination container changed before copy',
    };
  }
  return { status: 'stale', field: 'destination', message: 'destination changed before copy' };
}

async function transferContent(
  input: CopyContentInput,
  operation: TransferOperation,
): Promise<ContentTransferResult> {
  for (const [field, locator] of [
    ['source', input.source],
    ['destination', input.destination],
  ] as const) {
    if (!locator || typeof locator !== 'object') {
      return { status: 'invalid', field, message: 'invalid content locator' };
    }
    if (
      typeof locator.kind !== 'string' ||
      typeof locator.environment !== 'string' ||
      typeof locator.name !== 'string'
    ) {
      return { status: 'invalid', field, message: 'invalid content locator' };
    }
    if (!CONTENT_KINDS.has(locator.kind as ContentLocator['kind'])) {
      return { status: 'invalid', field, message: 'invalid content kind' };
    }
    const environmentError = validateEnvName(locator.environment);
    const nameError = itemNameError(locator);
    if (environmentError || nameError) {
      return {
        status: 'invalid',
        field,
        message: environmentError ? 'invalid environment name' : 'invalid content name',
      };
    }
  }
  if (input.source.kind !== input.destination.kind) {
    return { status: 'invalid', field: 'destination', message: 'content kinds must match' };
  }
  if (
    operation === 'move' &&
    input.source.environment === input.destination.environment
  ) {
    return {
      status: 'invalid',
      field: 'destination',
      message: 'a content move requires different environments',
    };
  }
  if (input.source.name !== input.destination.name) {
    return {
      status: 'invalid',
      field: 'destination',
      message: `a content ${operation} must preserve its name`,
    };
  }
  if (input.collision !== undefined && (
    typeof input.collision !== 'string' ||
    (input.collision !== 'fail' && input.collision !== 'overwrite')
  )) {
    return { status: 'invalid', field: 'destination', message: 'invalid collision policy' };
  }

  let pendingBeforeOpen;
  try {
    pendingBeforeOpen = (await readState(input.paths)).commands[0];
  } catch {
    return { status: 'failure', message: 'content transfer state is unavailable' };
  }
  if (pendingBeforeOpen) {
    return { status: 'pending-recovery', transactionId: pendingBeforeOpen.transactionId };
  }

  let environmentContainerIdentity: PathIdentity;
  let sourceEnvironment: InspectedEnvironment;
  let destinationEnvironment: InspectedEnvironment;
  let sourceContainerIdentity: PathIdentity;
  let destinationContainerIdentity: PathIdentity;
  const sourcePath = contentPath(input.paths, input.source);
  const destinationPath = contentPath(input.paths, input.destination);
  try {
    await assertNoFollowContainment(input.paths.store, input.paths.environments, {
      includeCandidate: true,
      label: 'environment container',
    });
    environmentContainerIdentity = await capturePathLocationIdentity(input.paths.environments);
    sourceEnvironment = await inspectEnvironment(
      input.paths,
      input.source.environment,
      'source',
      true,
    );
    destinationEnvironment = await inspectEnvironment(
      input.paths,
      input.destination.environment,
      'destination',
      true,
    );
    sourceContainerIdentity = await inspectContainer(
      input.paths.envDir(input.source.environment),
      contentContainer(input.paths, input.source),
      true,
      'source',
    );
    destinationContainerIdentity = await inspectContainer(
      input.paths.envDir(input.destination.environment),
      contentContainer(input.paths, input.destination),
      false,
      'destination',
    );
  } catch (error) {
    if (error instanceof ContentLocationError && error.missing) {
      return { status: 'not-found', field: error.field };
    }
    return { status: 'failure', message: 'content location is not a physical store path' };
  }

  let sourceIdentity: PathIdentity;
  let sourceEntry: { device: string; inode: string; treeDigest?: string };
  let sourceFile: Awaited<ReturnType<typeof readStableRegularFile>> | undefined;
  let destinationIdentity: PathIdentity;
  let destinationEntry: { device: string; inode: string; treeDigest?: string } | undefined;
  let destinationFile: Awaited<ReturnType<typeof readStableRegularFile>> | undefined;
  try {
    if (input.source.kind === 'skill') {
      const sourceTree = await validateSkillTree(sourcePath);
      sourceIdentity = sourceTree;
      sourceEntry = {
        device: sourceTree.device,
        inode: sourceTree.inode,
        treeDigest: sourceTree.treeDigest,
      };
    } else {
      sourceFile = await readStableRegularFile(sourcePath);
      sourceIdentity = sourceFile.identity;
      sourceEntry = sourceFile.entry;
    }
    destinationIdentity = await capturePathIdentity(destinationPath);
    if (input.destination.kind === 'skill' && destinationIdentity.kind === 'directory') {
      const destinationTree = await snapshotStablePhysicalTree(destinationPath);
      if (!identitiesEqual(destinationIdentity, destinationTree)) {
        throw new Error('destination content changed while being inspected');
      }
      destinationEntry = {
        device: destinationTree.device,
        inode: destinationTree.inode,
        treeDigest: destinationTree.treeDigest,
      };
    } else if (input.destination.kind !== 'skill' && destinationIdentity.kind === 'file') {
      destinationFile = await readStableRegularFile(destinationPath);
      if (!identitiesEqual(destinationIdentity, destinationFile.identity)) {
        throw new Error('destination content changed while being inspected');
      }
      destinationEntry = destinationFile.entry;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'not-found', field: 'source' };
    }
    return { status: 'failure', message: 'source content is not safe to copy' };
  }
  if (input.source.kind !== 'skill' && input.source.kind !== 'mcp' && sourceIdentity.kind !== 'file') {
    return { status: 'failure', message: 'source content must be a physical file' };
  }
  if (input.source.kind === 'mcp' && sourceIdentity.kind !== 'file') {
    return { status: 'failure', message: 'MCP source must be a physical file' };
  }
  if (destinationIdentity.kind === 'symlink') {
    return { status: 'failure', message: 'destination content must not be a symbolic link' };
  }
  if (
    destinationIdentity.kind !== 'absent' &&
    (input.source.kind === 'skill'
      ? destinationIdentity.kind !== 'directory'
      : destinationIdentity.kind !== 'file')
  ) {
    return { status: 'failure', message: 'destination content has the wrong physical type' };
  }

  let mcpText: string | undefined;
  let mcpCollision = false;
  if (input.source.kind === 'mcp') {
    try {
      const stableDestination = destinationIdentity.kind === 'absent'
        ? undefined
        : destinationFile!;
      if (stableDestination && !identitiesEqual(destinationIdentity, stableDestination.identity)) {
        return {
          status: 'stale',
          field: 'destination',
          message: 'destination changed before copy',
        };
      }
      const copied = copyMcpEntry(
        sourceFile!.bytes.toString('utf8'),
        stableDestination?.bytes.toString('utf8'),
        input.source.name,
        input.destination.name,
      );
      mcpText = copied.text;
      mcpCollision = copied.collision;
    } catch (error) {
      if (error instanceof ContentLocationError) return { status: 'not-found', field: 'source' };
      return { status: 'failure', message: 'MCP catalogue is not safe to copy' };
    }
  }
  const collision = input.source.kind === 'mcp'
    ? mcpCollision
    : destinationIdentity.kind !== 'absent';
  if (input.observedRevisions !== undefined) {
    const sourceItemRevision = input.source.kind === 'mcp'
      ? publicRevision({
          canonicalIdentity: canonicalPathIdentity(sourceIdentity),
          name: input.source.name,
        })
      : publicIdentityRevision(sourceIdentity);
    const destinationItemRevision = !collision
      ? null
      : input.destination.kind === 'mcp'
        ? publicRevision({
            canonicalIdentity: canonicalPathIdentity(destinationIdentity),
            name: input.destination.name,
          })
        : publicIdentityRevision(destinationIdentity);
    if (
      sourceItemRevision !== input.observedRevisions.sourceItem ||
      publicIdentityRevision(sourceEnvironment.identity) !==
        input.observedRevisions.sourceEnvironment ||
      publicIdentityRevision(environmentContainerIdentity) !==
        input.observedRevisions.sourceEnvironmentContainer
    ) {
      return { status: 'stale', field: 'source', message: 'source changed before copy' };
    }
    if (
      publicIdentityRevision(destinationEnvironment.identity) !==
        input.observedRevisions.destinationEnvironment ||
      publicIdentityRevision(environmentContainerIdentity) !==
        input.observedRevisions.destinationEnvironmentContainer ||
      destinationItemRevision !== input.observedRevisions.destinationItem
    ) {
      return {
        status: 'stale',
        field: 'destination',
        message: 'destination changed before copy',
      };
    }
  }
  if (collision && input.collision !== 'overwrite') {
    return { status: 'collision', kind: input.source.kind, name: input.destination.name };
  }

  let opened: unknown;
  try {
    opened = await input.runtime.open();
  } catch {
    return { status: 'failure', message: 'content transfer could not be opened safely' };
  }
  if (!opened || typeof opened !== 'object' || typeof (opened as { status?: unknown }).status !== 'string') {
    return { status: 'failure', message: 'content transfer returned an invalid open outcome' };
  }
  if ((opened as { status: string }).status === 'pending-recovery') {
    const transactionId = (opened as { transactionId?: unknown }).transactionId;
    return typeof transactionId === 'string'
      ? { status: 'pending-recovery', transactionId }
      : { status: 'failure', message: 'content transfer returned an invalid open outcome' };
  }
  if ((opened as { status: string }).status !== 'ready') {
    return { status: 'failure', message: 'content transfer returned an invalid open outcome' };
  }

  const transactionId = `${operation}-${input.source.kind}-${randomUUID()}`;
  const stagingRoot = join(input.paths.live, 'commands', transactionId);
  const stagedEnvironment = join(stagingRoot, 'destination-environment');
  const stagedSourceEnvironment = join(stagingRoot, 'source-environment');
  const stagedContent = join(
    stagedEnvironment,
    relative(input.paths.envDir(input.destination.environment), destinationPath),
  );
  const stagedSourceContent = join(
    stagedSourceEnvironment,
    relative(input.paths.envDir(input.source.environment), sourcePath),
  );
  let closeAllowed = false;
  let observedExactPost = false;
  try {
    await mkdir(stagingRoot, { recursive: true });
    const snapshottedDestinationIdentity = await snapshotStablePhysicalTree(
      input.paths.envDir(input.destination.environment),
      stagedEnvironment,
    );
    if (!identitiesEqual(destinationEnvironment.identity, snapshottedDestinationIdentity)) {
      return { status: 'stale', field: 'destination', message: `destination changed before ${operation}` };
    }
    if (operation === 'move') {
      const snapshottedSourceEnvironment = await snapshotStablePhysicalTree(
        input.paths.envDir(input.source.environment),
        stagedSourceEnvironment,
      );
      if (!identitiesEqual(sourceEnvironment.identity, snapshottedSourceEnvironment)) {
        return { status: 'stale', field: 'source', message: 'source changed before move' };
      }
    }
    await rm(stagedContent, { recursive: true, force: true });
    await mkdir(dirname(stagedContent), { recursive: true });
    if (input.source.kind === 'mcp') {
      await writeFile(stagedContent, mcpText!, 'utf8');
      await chmod(
        stagedContent,
        destinationIdentity.kind === 'file'
          ? destinationIdentity.mode
          : (sourceIdentity as Extract<PathIdentity, { kind: 'file' }>).mode,
      );
    } else if (input.source.kind === 'skill') {
      const snapshottedSourceIdentity = await snapshotStablePhysicalTree(sourcePath, stagedContent);
      if (!identitiesEqual(sourceIdentity, snapshottedSourceIdentity)) {
        return { status: 'stale', field: 'source', message: 'source content changed while copying' };
      }
    } else {
      await writeFile(stagedContent, sourceFile!.bytes);
      await chmod(stagedContent, sourceFile!.identity.mode);
    }
    if (operation === 'move') {
      if (input.source.kind === 'mcp') {
        const sourceMcpAfter = removeMcpEntry(
          sourceFile!.bytes.toString('utf8'),
          input.source.name,
        );
        await writeFile(stagedSourceContent, sourceMcpAfter, 'utf8');
        await chmod(stagedSourceContent, sourceFile!.identity.mode);
      } else {
        await rm(stagedSourceContent, { recursive: true, force: true });
      }
    }
    await input.faults?.afterSourceCopy?.();
    const sourceAfter = input.source.kind === 'skill'
      ? await snapshotStablePhysicalTree(sourcePath)
      : (await readStableRegularFile(sourcePath)).identity;
    if (!identitiesEqual(sourceIdentity, sourceAfter)) {
      return { status: 'stale', field: 'source', message: 'source content changed while copying' };
    }
    if (input.source.kind === 'skill') await validateSkillTree(stagedContent);
    if (
      input.source.kind !== 'mcp' &&
      !identitiesEqual(sourceIdentity, await capturePathIdentity(stagedContent))
    ) {
      return { status: 'stale', field: 'source', message: 'staged content does not match source' };
    }

    const entries: StagedCommandEntry[] = [{
      id: 'destination-environment',
      target: input.paths.envDir(input.destination.environment),
      staged: stagedEnvironment,
      expectedPreIdentity: destinationEnvironment.identity,
    }];
    if (operation === 'move') {
      entries.push({
        id: 'source-environment',
        target: input.paths.envDir(input.source.environment),
        staged: stagedSourceEnvironment,
        expectedPreIdentity: sourceEnvironment.identity,
      });
    }
    const preconditions: StagedCommandPrecondition[] = [
      { id: 'environment-container', path: input.paths.environments, expectedIdentity: environmentContainerIdentity },
      {
        id: 'source-content',
        path: sourcePath,
        expectedIdentity: sourceIdentity,
        observation: input.source.kind === 'skill' ? 'stable-tree' : 'stable-file',
        expectedEntry: sourceEntry,
      },
      {
        id: operation === 'move' ? 'source-environment-snapshot' : 'source-environment',
        path: input.paths.envDir(input.source.environment),
        expectedIdentity: sourceEnvironment.identity,
        observation: 'stable-tree',
        expectedEntry: sourceEnvironment.stableEntry!,
      },
      { id: 'source-container', path: contentContainer(input.paths, input.source), expectedIdentity: sourceContainerIdentity },
    ];
    if (operation === 'move') {
      preconditions.push({
        id: 'destination-environment-snapshot',
        path: input.paths.envDir(input.destination.environment),
        expectedIdentity: destinationEnvironment.identity,
        observation: 'stable-tree',
        expectedEntry: destinationEnvironment.stableEntry!,
      });
      if (destinationEntry) {
        preconditions.push({
          id: 'destination-content',
          path: destinationPath,
          expectedIdentity: destinationIdentity,
          observation: input.destination.kind === 'skill' ? 'stable-tree' : 'stable-file',
          expectedEntry: destinationEntry,
        });
      }
    }

    if (input.source.kind === 'skill') {
      const stagedManifest = join(stagedEnvironment, 'env.yaml');
      const yamlAfter = copyEnvSource(
        sourceEnvironment.yamlText,
        destinationEnvironment.yamlText,
        input.destination.name,
      );
      parseEnvConfig(yamlAfter, 'staged environment manifest');
      await writeFile(stagedManifest, yamlAfter, 'utf8');
      await chmod(
        stagedManifest,
        (destinationEnvironment.yamlIdentity as Extract<PathIdentity, { kind: 'file' }>).mode,
      );
      if (operation === 'move') {
        const stagedSourceManifest = join(stagedSourceEnvironment, 'env.yaml');
        const sourceYamlAfter = removeEnvSource(
          sourceEnvironment.yamlText,
          input.source.name,
        );
        parseEnvConfig(sourceYamlAfter, 'staged source environment manifest');
        await writeFile(stagedSourceManifest, sourceYamlAfter, 'utf8');
        await chmod(
          stagedSourceManifest,
          (sourceEnvironment.yamlIdentity as Extract<PathIdentity, { kind: 'file' }>).mode,
        );
      }
      preconditions.push({
        id: 'source-manifest',
        path: input.paths.envYaml(input.source.environment),
        expectedIdentity: sourceEnvironment.yamlIdentity,
        observation: 'stable-file',
        expectedEntry: sourceEnvironment.yamlEntry,
      });
      if (operation === 'move') {
        preconditions.push({
          id: 'destination-manifest',
          path: input.paths.envYaml(input.destination.environment),
          expectedIdentity: destinationEnvironment.yamlIdentity,
          observation: 'stable-file',
          expectedEntry: destinationEnvironment.yamlEntry,
        });
      }
    }

    await input.faults?.afterStage?.();
    if (!identitiesEqual(await capturePathIdentity(destinationPath), destinationIdentity)) {
      return { status: 'stale', field: 'destination', message: 'destination changed before copy' };
    }
    if (!identitiesEqual(
      await captureExpectedPathIdentity(
        contentContainer(input.paths, input.destination),
        destinationContainerIdentity,
      ),
      destinationContainerIdentity,
    )) {
      return {
        status: 'stale',
        field: 'destination-container',
        message: 'destination container changed before copy',
      };
    }
    const stagedEnvironmentIdentity = await snapshotStablePhysicalTree(stagedEnvironment);
    const stagedSourceEnvironmentIdentity = operation === 'move'
      ? await snapshotStablePhysicalTree(stagedSourceEnvironment)
      : undefined;
    let appliedDestinationEntry:
      | Awaited<ReturnType<typeof snapshotStablePhysicalTree>>
      | undefined;
    const publication: unknown = await input.runtime.publish({
      paths: input.paths,
      transactionId,
      kind: `content-${operation}`,
      stagingRoot,
      allowedRoots: [input.paths.store],
      entries,
      preconditions,
      gitSteps: [{
        id: `${operation}-content`,
        message: operation === 'move'
          ? `agentenv: move ${input.source.kind} ${input.source.name} from ` +
            `${input.source.environment} to ${input.destination.environment}`
          : `agentenv: copy ${input.source.kind} ${input.source.name}`,
        paths: [
          destinationPath,
          ...(operation === 'move' ? [sourcePath] : []),
          ...(input.source.kind === 'skill'
            ? [
                input.paths.envYaml(input.destination.environment),
                ...(operation === 'move'
                  ? [input.paths.envYaml(input.source.environment)]
                  : []),
              ]
            : []),
        ],
      }],
      ...(operation === 'move' ? {
        effectGuard: async (operationId, effect) => {
          if (operationId === 'source-environment') {
            const destinationNow = await snapshotStablePhysicalTree(
              input.paths.envDir(input.destination.environment),
            );
            const sourceNow = await snapshotStablePhysicalTree(
              input.paths.envDir(input.source.environment),
            );
            if (
              !appliedDestinationEntry ||
              !identitiesEqual(destinationNow, stagedEnvironmentIdentity) ||
              destinationNow.device !== appliedDestinationEntry.device ||
              destinationNow.inode !== appliedDestinationEntry.inode ||
              destinationNow.treeDigest !== appliedDestinationEntry.treeDigest
            ) {
              throw new StagedCommandExpectedIdentityError(
                'destination-environment',
                input.paths.envDir(input.destination.environment),
                'pre-apply',
              );
            }
            if (
              !identitiesEqual(sourceNow, sourceEnvironment.identity) ||
              sourceNow.device !== sourceEnvironment.stableEntry?.device ||
              sourceNow.inode !== sourceEnvironment.stableEntry.inode ||
              sourceNow.treeDigest !== sourceEnvironment.stableEntry.treeDigest
            ) {
              throw new StagedCommandExpectedIdentityError(
                'source-environment',
                input.paths.envDir(input.source.environment),
                'pre-apply',
              );
            }
          }
          await effect();
        },
      } : {}),
      afterApply: async (operationId) => {
        await input.faults?.afterApply?.(operationId);
        const observedDestination = await snapshotStablePhysicalTree(
          input.paths.envDir(input.destination.environment),
        );
        if (!identitiesEqual(observedDestination, stagedEnvironmentIdentity)) {
          throw new StagedCommandExpectedIdentityError(
            'destination-environment',
            input.paths.envDir(input.destination.environment),
            'pre-apply',
          );
        }
        if (operationId === 'destination-environment') {
          appliedDestinationEntry = observedDestination;
        }
        if (operation === 'move' && operationId === 'source-environment') {
          const observedSource = await snapshotStablePhysicalTree(
            input.paths.envDir(input.source.environment),
          );
          if (!identitiesEqual(observedSource, stagedSourceEnvironmentIdentity!)) {
            throw new StagedCommandExpectedIdentityError(
              'source-environment',
              input.paths.envDir(input.source.environment),
              'pre-apply',
            );
          }
          observedExactPost = true;
        } else if (operation === 'copy') {
          observedExactPost = true;
        }
      },
      ...(input.faults?.afterPersist ? { afterPersist: input.faults.afterPersist } : {}),
    });
    if (
      !publication ||
      typeof publication !== 'object' ||
      ((publication as { status?: unknown }).status !== 'complete' &&
        (publication as { status?: unknown }).status !== 'git-pending')
    ) {
      throw new Error('content transfer returned an invalid publication outcome');
    }
    const common = {
      kind: input.source.kind,
      name: input.destination.name,
      transactionId,
    };
    const completed = (): ContentTransferResult => operation === 'copy'
      ? { ...common, status: 'copied', operation: 'copy', publication: 'complete' }
      : { ...common, status: 'moved', operation: 'move', publication: 'complete' };
    const gitPending = (): ContentTransferResult => operation === 'copy'
      ? { ...common, status: 'git-pending', operation: 'copy', publication: 'git-pending' }
      : { ...common, status: 'git-pending', operation: 'move', publication: 'git-pending' };
    let commands;
    try {
      commands = (await readState(input.paths)).commands;
    } catch (error) {
      const observed = observedExactPost
        ? await snapshotStablePhysicalTree(input.paths.envDir(input.destination.environment))
          .catch(() => undefined)
        : undefined;
      const observedSource = operation === 'move' && observedExactPost
        ? await snapshotStablePhysicalTree(input.paths.envDir(input.source.environment))
          .catch(() => undefined)
        : undefined;
      if (
        !observed ||
        !identitiesEqual(observed, stagedEnvironmentIdentity) ||
        (operation === 'move' && (
          !observedSource ||
          !identitiesEqual(observedSource, stagedSourceEnvironmentIdentity!)
        ))
      ) throw error;
      closeAllowed = (publication as { status: string }).status === 'complete';
      return (publication as { status: string }).status === 'git-pending'
        ? gitPending()
        : completed();
    }
    const retained = commands.find((command) => command.transactionId === transactionId);
    const otherPending = commands.find((command) => command.transactionId !== transactionId);
    if (retained) {
      if (retained.phase === 'complete') return completed();
      if (retained.phase === 'committed' || retained.phase === 'git-pending') {
        return gitPending();
      }
      return { status: 'pending-recovery', transactionId };
    } else if (otherPending) {
      return { status: 'pending-recovery', transactionId: otherPending.transactionId };
    } else if ((publication as { status: string }).status === 'git-pending') {
      throw new Error('git-pending publication has no retained command');
    } else {
      const observedDestination = observedExactPost
        ? await snapshotStablePhysicalTree(input.paths.envDir(input.destination.environment))
          .catch(() => undefined)
        : undefined;
      const observedSource = operation === 'move' && observedExactPost
        ? await snapshotStablePhysicalTree(input.paths.envDir(input.source.environment))
          .catch(() => undefined)
        : undefined;
      if (
        !observedDestination ||
        !identitiesEqual(observedDestination, stagedEnvironmentIdentity) ||
        (operation === 'move' && (
          !observedSource ||
          !identitiesEqual(observedSource, stagedSourceEnvironmentIdentity!)
        ))
      ) {
        throw new Error('complete publication did not produce the staged destination');
      }
      closeAllowed = true;
    }
    return (publication as { status: string }).status === 'git-pending'
      ? gitPending()
      : completed();
  } catch (error) {
    let commands;
    try {
      commands = (await readState(input.paths)).commands;
    } catch {
      return { status: 'failure', message: `content ${operation} failed safely` };
    }
    const retained = commands.find((command) => command.transactionId === transactionId);
    if (retained) {
      if (retained.phase === 'complete') {
        return operation === 'copy'
          ? {
              status: 'copied',
              operation: 'copy',
              kind: input.source.kind,
              name: input.destination.name,
              transactionId,
              publication: 'complete',
            }
          : {
              status: 'moved',
              operation: 'move',
              kind: input.source.kind,
              name: input.destination.name,
              transactionId,
              publication: 'complete',
            };
      }
      if (retained.phase === 'committed' || retained.phase === 'git-pending') {
        return operation === 'copy'
          ? {
              status: 'git-pending',
              operation: 'copy',
              kind: input.source.kind,
              name: input.destination.name,
              transactionId,
              publication: 'git-pending',
            }
          : {
              status: 'git-pending',
              operation: 'move',
              kind: input.source.kind,
              name: input.destination.name,
              transactionId,
              publication: 'git-pending',
            };
      }
      return { status: 'pending-recovery', transactionId };
    }
    const otherPending = commands[0];
    if (otherPending) {
      return { status: 'pending-recovery', transactionId: otherPending.transactionId };
    }
    closeAllowed = true;
    if (error instanceof StagedCommandExpectedIdentityError) return staleField(error.entryId);
    const id = error instanceof StagedCommandPreconditionError
      ? error.preconditionId
      : error instanceof CommandPathPreconditionError
        ? error.operationId
        : undefined;
    if (id) return staleField(id);
    return { status: 'failure', message: `content ${operation} failed safely` };
  } finally {
    try {
      closeAllowed = !(await readState(input.paths)).commands.length;
    } catch {
      // Keep the last authoritative publication decision; cleanup is best effort.
    }
    if (closeAllowed) {
      try {
        await rm(stagingRoot, { recursive: true, force: true });
      } catch {
        // Cleanup failure must not mask publication truth or skip runtime close.
      }
      try {
        await input.runtime.close();
      } catch {
        // Closing is best effort after publication truth has been established.
      }
    }
  }
}

export function copyContent(input: CopyContentInput): Promise<CopyContentResult> {
  return transferContent(input, 'copy') as Promise<CopyContentResult>;
}

export function moveContent(input: MoveContentInput): Promise<MoveContentResult> {
  return transferContent(input, 'move') as Promise<MoveContentResult>;
}
