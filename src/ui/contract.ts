declare const uiContractBrand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [uiContractBrand]: Name;
};

export type EnvironmentName = Brand<string, 'EnvironmentName'>;
export type ContentName = Brand<string, 'ContentName'>;
export type CandidateSetId = Brand<string, 'CandidateSetId'>;
export type CandidateId = Brand<string, 'CandidateId'>;
export type Revision = Brand<string, 'Revision'>;

export const UI_CONTENT_KINDS = [
  'skill',
  'instruction',
  'mcp',
  'agent',
  'command',
] as const;

export type ContentKind = (typeof UI_CONTENT_KINDS)[number];
export type TransferOperation = 'copy' | 'move';
export type CollisionPolicy = 'fail' | 'overwrite';

interface ContentItemBase {
  name: ContentName;
  revision: Revision;
}

export interface SkillSource {
  repository: string;
  path: string;
  ref?: string;
  shortCommit: string;
}

export interface SkillContentItem extends ContentItemBase {
  kind: 'skill';
  description?: string;
  source?: SkillSource;
}

export interface InstructionContentItem extends ContentItemBase {
  kind: 'instruction';
  scope: 'base' | 'harness';
  harness?: string;
}

export interface McpContentItem extends ContentItemBase {
  kind: 'mcp';
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
}

export interface AgentContentItem extends ContentItemBase {
  kind: 'agent';
}

export interface CommandContentItem extends ContentItemBase {
  kind: 'command';
}

export type ContentItem =
  | SkillContentItem
  | InstructionContentItem
  | McpContentItem
  | AgentContentItem
  | CommandContentItem;

export interface PageInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PageResponse<Item> {
  items: readonly Item[];
  page: PageInfo;
}

export interface ContentCounts {
  skill: number;
  instruction: number;
  mcp: number;
  agent: number;
  command: number;
}

export interface EnvironmentSummary {
  name: EnvironmentName;
  description: string;
  active: boolean;
  counts: ContentCounts;
  revision: Revision;
  /** Opaque physical identity of the containing environments directory. */
  containerRevision: Revision;
}

export type EnvironmentCatalogPage = PageResponse<EnvironmentSummary>;

export interface EnvironmentInventory extends EnvironmentSummary {
  items: readonly ContentItem[];
}

export const UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH = 1_000;

export interface CreateEnvironmentRequest {
  operation: 'create';
  name: EnvironmentName;
  description?: string;
}

export interface CloneEnvironmentRequest {
  operation: 'clone';
  name: EnvironmentName;
  source: EnvironmentName;
}

export type EnvironmentLifecycleRequest =
  | CreateEnvironmentRequest
  | CloneEnvironmentRequest;

export interface DeleteEnvironmentRequest {
  operation: 'delete';
  name: EnvironmentName;
  confirmation: string;
  targetRevision: Revision;
  containerRevision: Revision;
}

export interface EnvironmentLifecycleSuccess {
  operation: 'create' | 'clone';
  name: EnvironmentName;
  source?: EnvironmentName;
  publication: 'complete';
  /**
   * A best-effort projection captured after durable publication. Publication is
   * still complete when a concurrent catalogue change prevents this read; the
   * client must then reconcile through the catalogue routes.
   */
  environment?: EnvironmentInventory;
}

export interface EnvironmentDeleteSuccess {
  operation: 'delete';
  name: EnvironmentName;
  publication: 'complete' | 'git-pending';
}

export interface CopyContentRequest {
  operation: 'copy';
  kind: ContentKind;
  name: ContentName;
  sourceEnvironment: EnvironmentName;
  destinationEnvironment: EnvironmentName;
  collision: CollisionPolicy;
  sourceItemRevision: Revision;
  sourceEnvironmentRevision: Revision;
  sourceEnvironmentContainerRevision: Revision;
  destinationEnvironmentRevision: Revision;
  destinationEnvironmentContainerRevision: Revision;
  destinationItemRevision: Revision | null;
}

export interface TransferContentReference {
  environment: EnvironmentName;
  kind: ContentKind;
  name: ContentName;
}

export interface CopyContentSuccess {
  operation: 'copy';
  source: TransferContentReference;
  destination: TransferContentReference;
  publication: 'complete' | 'git-pending';
  refreshRequired: boolean;
  sourceEnvironment?: EnvironmentInventory;
  destinationEnvironment?: EnvironmentInventory;
}

export const API_ERROR_STATUS = {
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  COLLISION: 409,
  ACTIVE_ENVIRONMENT: 409,
  DRIFT_BLOCKED: 409,
  STALE_REVISION: 409,
  PENDING_RECOVERY: 409,
  VALIDATION_FAILED: 422,
  INTERNAL_ERROR: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export interface ValidationIssue {
  path?: string;
  message: string;
}

export type ApiErrorDetails =
  | { kind: 'validation'; issues: readonly ValidationIssue[] }
  | {
      kind: 'active-environment';
      session: boolean;
      globalStack: boolean;
      materialised: boolean;
    }
  | { kind: 'blocked-drift'; secretBearing: boolean }
  | {
      kind: 'conflict';
      resource: string;
      expectedRevision?: Revision;
      actualRevision?: Revision;
    }
  | {
      kind: 'pending-recovery';
      commandId?: string;
      publication?: 'environment-published';
    }
  | {
      kind: 'transfer-collision';
      environment: EnvironmentName;
      contentKind: ContentKind;
      name: ContentName;
      destinationItemRevision: Revision;
      destinationEnvironmentRevision: Revision;
      destinationEnvironmentContainerRevision: Revision;
    };

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetails;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface ApiSuccessResponse<Data> {
  data: Data;
}

export type GitDiscoveryPhase = 'resolving' | 'fetching' | 'scanning';

export interface GitCandidate {
  candidateId: CandidateId;
  name: ContentName;
  description: string;
  repositoryPath: string;
  ref?: string;
  commit: string;
  shortCommit: string;
}

export interface PendingGitCandidateSet {
  status: 'PENDING';
  candidateSetId: CandidateSetId;
  phase: GitDiscoveryPhase;
}

export interface ReadyGitCandidateSet {
  status: 'READY';
  candidateSetId: CandidateSetId;
  candidates: readonly GitCandidate[];
  page: PageInfo;
}

export interface FailedGitCandidateSet {
  status: 'FAILED';
  candidateSetId: CandidateSetId;
  error: ApiError;
}

export type GitCandidateSet =
  | PendingGitCandidateSet
  | ReadyGitCandidateSet
  | FailedGitCandidateSet;

export function isTerminalGitCandidateSet(
  candidateSet: GitCandidateSet,
): candidateSet is ReadyGitCandidateSet | FailedGitCandidateSet {
  return candidateSet.status !== 'PENDING';
}
