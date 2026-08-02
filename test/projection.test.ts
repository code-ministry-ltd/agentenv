import { describe, expect, it } from 'vitest';
import {
  decideReverseProjection,
  validateProjectionRecord,
  type ProjectionRecord,
} from '../src/projection.js';

function record(): ProjectionRecord {
  return {
    schemaVersion: 2,
    id: 'projection-1',
    canonical: {
      path: '/store/environments/work/mcp/servers.yaml',
      pointer: '/linear/url',
      revision: 'canonical-r1',
      baselineHash: 'sha256:canonical-before',
    },
    rendered: {
      path: '/view/.mcp.json',
      pointer: '/mcpServers/linear/url',
      baselineHash: 'sha256:rendered-before',
    },
    transform: 'claude-mcp-v2',
    placeholders: [{ renderedPointer: '/headers/Authorization', template: 'Bearer ${LINEAR_TOKEN}' }],
  };
}

describe('reverse projection contract', () => {
  it('does nothing when the rendered value still matches its baseline', () => {
    expect(
      decideReverseProjection({
        record: record(),
        observedRenderedHash: 'sha256:rendered-before',
        currentCanonicalRevision: 'canonical-r1',
        inverse: { kind: 'lossless', patches: [] },
      }),
    ).toEqual({ action: 'unchanged' });
  });

  it('applies only a lossless field patch against the same canonical revision', () => {
    const patches = [
      {
        op: 'replace' as const,
        pointer: '/linear/url',
        expectedHash: 'sha256:canonical-before',
        value: 'https://new.invalid/mcp',
      },
    ];
    expect(
      decideReverseProjection({
        record: record(),
        observedRenderedHash: 'sha256:rendered-after',
        currentCanonicalRevision: 'canonical-r1',
        inverse: { kind: 'lossless', patches },
      }),
    ).toEqual({ action: 'apply', patches });
  });

  it('quarantines a concurrent canonical edit instead of overwriting it', () => {
    expect(
      decideReverseProjection({
        record: record(),
        observedRenderedHash: 'sha256:rendered-after',
        currentCanonicalRevision: 'canonical-r2',
        inverse: { kind: 'lossless', patches: [] },
      }),
    ).toMatchObject({ action: 'quarantine', kind: 'concurrent-canonical-change', retainBytes: true });
  });

  it('quarantines an ambiguous inverse without carrying rendered values in the reason', () => {
    const result = decideReverseProjection({
      record: record(),
      observedRenderedHash: 'sha256:rendered-after',
      currentCanonicalRevision: 'canonical-r1',
      inverse: { kind: 'ambiguous', reason: 'transport discriminators conflict' },
    });
    expect(result).toEqual({
      action: 'quarantine',
      kind: 'ambiguous',
      reason: 'transport discriminators conflict',
      retainBytes: true,
    });
    expect(JSON.stringify(result)).not.toContain('LINEAR_TOKEN');
  });

  it('requires complete pointers, baselines, revision, transform, and placeholders', () => {
    expect(validateProjectionRecord(record())).toBeNull();
    const invalid = record();
    invalid.canonical.revision = '';
    expect(validateProjectionRecord(invalid)).toMatch(/canonical revision/i);
  });
});
