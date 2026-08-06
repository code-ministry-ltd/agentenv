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
  commit: string;
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

export const API_ERROR_STATUS = {
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  COLLISION: 409,
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
      kind: 'conflict';
      resource: string;
      expectedRevision?: Revision;
      actualRevision?: Revision;
    }
  | { kind: 'pending-recovery'; commandId?: string };

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
