import { describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  UI_CONTENT_KINDS,
  isTerminalGitCandidateSet,
  type ApiErrorResponse,
  type CandidateSetId,
  type CopyContentRequest,
  type CopyContentSuccess,
  type ContentItem,
  type GitCandidateSet,
} from '../src/ui/contract.js';

function describeContent(item: ContentItem): string {
  switch (item.kind) {
    case 'skill':
      return item.source === undefined
        ? item.name
        : `${item.name}@${item.source.shortCommit}`;
    case 'instruction':
      return `${item.name}:${item.scope}`;
    case 'mcp':
      return `${item.name}:${item.transport}`;
    case 'agent':
      return `${item.name}:agent`;
    case 'command':
      return `${item.name}:command`;
  }
}

describe('UI contract', () => {
  it('defines all five transferable content kinds exhaustively', () => {
    expect(UI_CONTENT_KINDS).toEqual([
      'skill',
      'instruction',
      'mcp',
      'agent',
      'command',
    ]);

    const item = {
      kind: 'instruction',
      name: 'base',
      revision: 'revision-1',
      scope: 'base',
    } as ContentItem;

    expect(describeContent(item)).toBe('base:base');
  });

  it('maps every stable error code to its intended HTTP status', () => {
    expect(API_ERROR_STATUS).toEqual({
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
    });
  });

  it('serializes failures through one safe error envelope', () => {
    const response: ApiErrorResponse = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The skill is invalid.',
        details: {
          kind: 'validation',
          issues: [
            {
              path: 'frontmatter.name',
              message: 'Must match the skill directory name.',
            },
          ],
        },
      },
    };

    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('distinguishes pending Git discovery from terminal outcomes', () => {
    const candidateSetId = 'candidate-set-1' as CandidateSetId;
    const states: readonly GitCandidateSet[] = [
      { status: 'PENDING', candidateSetId, phase: 'fetching' },
      {
        status: 'READY',
        candidateSetId,
        candidates: [],
        page: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
      },
      {
        status: 'FAILED',
        candidateSetId,
        error: {
          code: 'NOT_FOUND',
          message: 'The Git source could not be read.',
        },
      },
    ];

    expect(states.map(isTerminalGitCandidateSet)).toEqual([false, true, true]);
  });

  it('defines copy consent with public observed revisions and truthful refresh metadata', () => {
    const revision = 'r'.repeat(43) as CopyContentRequest['sourceItemRevision'];
    const request: CopyContentRequest = {
      operation: 'copy',
      kind: 'skill',
      name: 'drafting' as CopyContentRequest['name'],
      sourceEnvironment: 'writing' as CopyContentRequest['sourceEnvironment'],
      destinationEnvironment: 'research' as CopyContentRequest['destinationEnvironment'],
      collision: 'overwrite',
      sourceItemRevision: revision,
      sourceEnvironmentRevision: revision,
      sourceEnvironmentContainerRevision: revision,
      destinationEnvironmentRevision: revision,
      destinationEnvironmentContainerRevision: revision,
      destinationItemRevision: revision,
    };
    const result: CopyContentSuccess = {
      operation: 'copy',
      source: { environment: request.sourceEnvironment, kind: request.kind, name: request.name },
      destination: {
        environment: request.destinationEnvironment,
        kind: request.kind,
        name: request.name,
      },
      publication: 'git-pending',
      refreshRequired: true,
    };

    expect(JSON.parse(JSON.stringify({ request, result }))).toEqual({ request, result });
  });
});
