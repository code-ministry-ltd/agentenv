import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import type { Revision, SkillDocument } from '../../src/ui/contract.js';
import { getSkillDocument, UiApiError } from './api.js';

type WorkspaceMode = 'source' | 'preview' | 'split';

type DocumentState =
  | { status: 'loading' }
  | {
      status: 'ready' | 'refreshing';
      document: SkillDocument;
      draft: string;
      notice?: string;
      pendingDocument?: SkillDocument;
    }
  | {
      status: 'error';
      kind: 'missing' | 'stale' | 'failure';
      document?: SkillDocument;
      draft?: string;
      pendingDocument?: SkillDocument;
    };

function CodeMirrorEditor({
  identity,
  layout,
  value,
  onChange,
}: {
  identity: string;
  layout: WorkspaceMode;
  value: string;
  onChange(value: string): void;
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const configurationRef = useRef<Compartment | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const parent = parentRef.current;
    if (parent === null) return;
    const configuration = new Compartment();
    configurationRef.current = configuration;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        configuration.of(EditorView.contentAttributes.of({
          'aria-label': 'Skill Markdown source editor',
          'data-layout': layout,
        })),
      ],
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    view.focus();
    return () => {
      viewRef.current = undefined;
      configurationRef.current = undefined;
      view.destroy();
    };
    // A different document identity receives a fresh undo history and focus.
  }, [identity]);

  useEffect(() => {
    const view = viewRef.current;
    const configuration = configurationRef.current;
    if (view === undefined || configuration === undefined) return;
    view.dispatch({
      effects: configuration.reconfigure(EditorView.contentAttributes.of({
        'aria-label': 'Skill Markdown source editor',
        'data-layout': layout,
      })),
    });
    if (layout !== 'preview') {
      view.requestMeasure();
      view.focus();
    }
  }, [layout]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === undefined || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  return <div className="skill-code-editor" ref={parentRef} />;
}

function safeLoadError(
  error: unknown,
): Extract<DocumentState, { status: 'error' }>['kind'] {
  if (error instanceof UiApiError && error.code === 'NOT_FOUND') return 'missing';
  if (error instanceof UiApiError && error.code === 'STALE_REVISION') return 'stale';
  return 'failure';
}

const MODES: readonly { mode: WorkspaceMode; label: string }[] = [
  { mode: 'source', label: 'Source' },
  { mode: 'preview', label: 'Preview' },
  { mode: 'split', label: 'Split' },
];

function ModeTabs({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange(mode: WorkspaceMode): void;
}): React.JSX.Element {
  const refs = useRef(new Map<WorkspaceMode, HTMLButtonElement>());
  const select = (next: WorkspaceMode): void => {
    onChange(next);
    refs.current.get(next)?.focus();
  };
  const move = (current: WorkspaceMode, direction: number): void => {
    const index = MODES.findIndex((candidate) => candidate.mode === current);
    const next = MODES[(index + direction + MODES.length) % MODES.length]!;
    select(next.mode);
  };
  return (
    <div aria-label="Skill document view" className="skill-editor-tabs" role="tablist">
      {MODES.map((candidate) => (
        <button
          aria-controls="skill-document-panel"
          aria-selected={candidate.mode === mode}
          className="button-secondary"
          id={`skill-editor-tab-${candidate.mode}`}
          key={candidate.mode}
          onClick={() => onChange(candidate.mode)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              move(candidate.mode, -1);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              move(candidate.mode, 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              select(MODES[0]!.mode);
            } else if (event.key === 'End') {
              event.preventDefault();
              select(MODES.at(-1)!.mode);
            }
          }}
          ref={(element) => {
            if (element === null) refs.current.delete(candidate.mode);
            else refs.current.set(candidate.mode, element);
          }}
          role="tab"
          tabIndex={candidate.mode === mode ? 0 : -1}
          type="button"
        >
          {candidate.label}
        </button>
      ))}
    </div>
  );
}

function RetainedError({
  kind,
  retry,
}: {
  kind: Extract<DocumentState, { status: 'error' }>['kind'];
  retry(): void;
}): React.JSX.Element {
  const message = kind === 'missing'
    ? 'This skill document is no longer available.'
    : kind === 'stale'
      ? 'The skill document changed while it was loading.'
      : 'The skill document request failed.';
  return (
    <div className="skill-editor-message inventory-error" role="alert">
      <div>
        <strong>{message}</strong>
        <span>Any draft already in this workspace has been retained.</span>
      </div>
      <button type="button" onClick={retry}>Retry skill document</button>
    </div>
  );
}

export function SkillEditor({
  environment,
  itemRevision,
  skill,
  onClose,
}: {
  environment: string;
  itemRevision: Revision;
  skill: string;
  onClose(): void;
}): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const [mode, setMode] = useState<WorkspaceMode>('source');
  const [state, setState] = useState<DocumentState>({ status: 'loading' });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const controller = new AbortController();
    let acceptResponse = true;
    setState((current) => current.status === 'ready' || current.status === 'refreshing'
      ? { ...current, status: 'refreshing' }
      : current.status === 'error' && current.document !== undefined && current.draft !== undefined
        ? {
            status: 'refreshing',
            document: current.document,
            draft: current.draft,
            ...(current.pendingDocument === undefined
              ? {}
              : { pendingDocument: current.pendingDocument }),
          }
        : { status: 'loading' });
    void getSkillDocument(environment, skill, controller.signal).then(
      (document) => {
        if (!acceptResponse || document.environment !== environment || document.skill !== skill) {
          return;
        }
        setState((current) => {
          const retained = current.status === 'ready' || current.status === 'refreshing'
            ? current
            : current.status === 'error' && current.document !== undefined && current.draft !== undefined
              ? { status: 'ready' as const, document: current.document, draft: current.draft }
              : undefined;
          if (retained !== undefined && retained.draft !== retained.document.text) {
            const changed = document.revision !== retained.document.revision ||
              document.text !== retained.document.text;
            return {
              status: 'ready',
              document: retained.document,
              draft: retained.draft,
              ...(changed
                ? {
                    pendingDocument: document,
                    notice: 'A newer response was available, but your local draft was retained.',
                  }
                : {}),
            };
          }
          return { status: 'ready', document, draft: document.text };
        });
      },
      (error: unknown) => {
        if (!acceptResponse || (error instanceof DOMException && error.name === 'AbortError')) return;
        const current = stateRef.current;
        const retained = current.status === 'ready' || current.status === 'refreshing'
          ? current
          : current.status === 'error'
            ? current
            : undefined;
        setState({
          status: 'error',
          kind: safeLoadError(error),
          ...(retained?.document === undefined ? {} : { document: retained.document }),
          ...(retained?.draft === undefined ? {} : { draft: retained.draft }),
          ...(retained?.pendingDocument === undefined
            ? {}
            : { pendingDocument: retained.pendingDocument }),
        });
      },
    );
    return () => {
      acceptResponse = false;
      controller.abort();
    };
  }, [environment, itemRevision, request, skill]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const retained = state.status === 'ready' || state.status === 'refreshing'
    ? state
    : state.status === 'error' && state.document !== undefined && state.draft !== undefined
      ? { document: state.document, draft: state.draft }
      : undefined;
  const updateDraft = (draft: string): void => {
    setState((current) => {
      if (current.status === 'ready' || current.status === 'refreshing') {
        if (draft === current.document.text && current.pendingDocument !== undefined) {
          return {
            status: 'ready',
            document: current.pendingDocument,
            draft: current.pendingDocument.text,
          };
        }
        return { ...current, draft };
      }
      if (current.status === 'error' && current.document !== undefined) {
        if (draft === current.document.text && current.pendingDocument !== undefined) {
          return {
            status: 'ready',
            document: current.pendingDocument,
            draft: current.pendingDocument.text,
          };
        }
        return { ...current, draft };
      }
      return current;
    });
  };
  const editorIdentity = retained === undefined
    ? undefined
    : `${retained.document.environment}/${retained.document.skill}@${retained.document.revision}`;

  return (
    <section className="skill-editor" aria-labelledby="skill-editor-title">
      <div className="skill-editor-heading">
        <div>
          <p className="eyebrow">Skill workspace</p>
          <h2 id="skill-editor-title" ref={headingRef} tabIndex={-1}>{skill} SKILL.md</h2>
          {retained === undefined ? null : (
            <p className="environment-revision" title={retained.document.revision}>
              Revision {retained.document.revision.slice(0, 10)}
            </p>
          )}
        </div>
        <div className="skill-editor-actions">
          <button disabled type="button" title="Saving will be available in the next editing step">
            Save unavailable
          </button>
          <button className="button-secondary" type="button" onClick={onClose}>
            Close workspace
          </button>
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="skill-editor-message" role="status" aria-busy="true">
          <span aria-hidden="true" className="status-pulse" />
          Loading {skill} SKILL.md…
        </div>
      ) : null}
      {state.status === 'refreshing' ? (
        <div className="skill-editor-message" role="status" aria-busy="true">
          Refreshing the document while retaining this draft…
        </div>
      ) : null}
      {state.status === 'error' ? (
        <RetainedError kind={state.kind} retry={() => setRequest((value) => value + 1)} />
      ) : null}
      {state.status === 'ready' && state.notice !== undefined ? (
        <div className="skill-editor-message" role="status">{state.notice}</div>
      ) : null}

      {retained === undefined || editorIdentity === undefined ? null : (
        <>
          <ModeTabs mode={mode} onChange={setMode} />
          <div
            aria-labelledby={`skill-editor-tab-${mode}`}
            className={`skill-document-panel skill-document-${mode}`}
            id="skill-document-panel"
            role="tabpanel"
          >
            <div
              aria-hidden={mode === 'preview'}
              className="skill-source-pane"
              hidden={mode === 'preview'}
            >
              <h3>Markdown source</h3>
              <CodeMirrorEditor
                identity={editorIdentity}
                layout={mode}
                onChange={updateDraft}
                value={retained.draft}
              />
            </div>
            {mode === 'source' ? null : (
              <div className="skill-preview-pane">
                <h3>Literal preview</h3>
                <p>Markdown rendering is not enabled yet. This preview shows inert text.</p>
                <pre aria-label="Skill document literal preview">{retained.draft}</pre>
              </div>
            )}
          </div>
          {retained.draft === '' ? (
            <p className="skill-editor-message" role="status">This SKILL.md is empty.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
