import type { JsonValue } from './config-keys.js';

export interface CanonicalProjectionPointer {
  path: string;
  pointer: string;
  revision: string;
  baselineHash: string;
}

export interface RenderedProjectionPointer {
  path: string;
  pointer: string;
  baselineHash: string;
}

export interface ProjectionPlaceholder {
  renderedPointer: string;
  template: string;
}

export interface ProjectionRecord {
  schemaVersion: 2;
  id: string;
  canonical: CanonicalProjectionPointer;
  rendered: RenderedProjectionPointer;
  transform: string;
  placeholders: ProjectionPlaceholder[];
}

export type ProjectionPatch =
  | { op: 'add' | 'replace'; pointer: string; expectedHash: string; value: JsonValue }
  | { op: 'remove'; pointer: string; expectedHash: string };

export type InverseProjection =
  | { kind: 'lossless'; patches: ProjectionPatch[] }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'invalid'; reason: string };

export type ReverseProjectionDecision =
  | { action: 'unchanged' }
  | { action: 'apply'; patches: ProjectionPatch[] }
  | {
      action: 'quarantine';
      kind: 'concurrent-canonical-change' | 'ambiguous' | 'invalid';
      reason: string;
      retainBytes: true;
    };

export interface ReverseProjectionInput {
  record: ProjectionRecord;
  observedRenderedHash: string;
  currentCanonicalRevision: string;
  inverse: InverseProjection;
}

/** Decide three-way reverse projection without performing a canonical write. */
export function decideReverseProjection(input: ReverseProjectionInput): ReverseProjectionDecision {
  if (input.observedRenderedHash === input.record.rendered.baselineHash) {
    return { action: 'unchanged' };
  }
  if (input.currentCanonicalRevision !== input.record.canonical.revision) {
    return {
      action: 'quarantine',
      kind: 'concurrent-canonical-change',
      reason: 'canonical revision changed since this projection was rendered',
      retainBytes: true,
    };
  }
  if (input.inverse.kind !== 'lossless') {
    return {
      action: 'quarantine',
      kind: input.inverse.kind,
      reason: input.inverse.reason,
      retainBytes: true,
    };
  }
  return { action: 'apply', patches: input.inverse.patches };
}

/** Structural validation for durable projection provenance. */
export function validateProjectionRecord(record: ProjectionRecord): string | null {
  if (record.schemaVersion !== 2) return 'projection schema version must be 2';
  if (!record.id) return 'projection id is required';
  if (!record.canonical || typeof record.canonical !== 'object') {
    return 'canonical projection pointer is required';
  }
  if (!record.rendered || typeof record.rendered !== 'object') {
    return 'rendered projection pointer is required';
  }
  if (!record.canonical.path || !record.canonical.pointer) {
    return 'canonical path and pointer are required';
  }
  if (!record.canonical.revision) return 'canonical revision is required';
  if (!record.canonical.baselineHash) return 'canonical baseline hash is required';
  if (!record.rendered.path || !record.rendered.pointer) {
    return 'rendered path and pointer are required';
  }
  if (!record.rendered.baselineHash) return 'rendered baseline hash is required';
  if (!record.transform) return 'projection transform is required';
  if (!Array.isArray(record.placeholders)) return 'projection placeholders must be an array';
  for (const placeholder of record.placeholders) {
    if (!placeholder.renderedPointer || !placeholder.template) {
      return 'projection placeholders require a rendered pointer and template';
    }
  }
  return null;
}
