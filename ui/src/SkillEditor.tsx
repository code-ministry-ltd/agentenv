import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import type { Revision, SkillDocument, ValidationIssue } from '../../src/ui/contract.js';
import { getSkillDocument, saveSkillDocument, UiApiError } from './api.js';
import { SafeMarkdown } from './SafeMarkdown.js';

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

type SaveState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'validation'; issues: readonly ValidationIssue[] }
  | { status: 'stale' }
  | { status: 'failure'; message: string }
  | { status: 'saved'; publication: 'complete' | 'git-pending'; refreshRequired: boolean };

function CodeMirrorEditor({
  identity,
  layout,
  value,
  onChange,
  canSave,
  onSave,
}: {
  identity: string;
  layout: WorkspaceMode;
  value: string;
  onChange(value: string): void;
  canSave: boolean;
  onSave(): void;
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const configurationRef = useRef<Compartment | undefined>(undefined);
  const saveKeymapRef = useRef<Compartment | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const canSaveRef = useRef(canSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  canSaveRef.current = canSave;

  useEffect(() => {
    const parent = parentRef.current;
    if (parent === null) return;
    const configuration = new Compartment();
    const saveKeymap = new Compartment();
    configurationRef.current = configuration;
    saveKeymapRef.current = saveKeymap;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        saveKeymap.of(Prec.high(keymap.of([{
          key: 'Mod-s',
          run() {
            if (canSaveRef.current) onSaveRef.current();
            return true;
          },
        }]))),
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
      saveKeymapRef.current = undefined;
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
    const saveKeymap = saveKeymapRef.current;
    if (view === undefined || saveKeymap === undefined) return;
    view.dispatch({
      effects: saveKeymap.reconfigure(Prec.high(keymap.of([{
        key: 'Mod-s',
        run() {
          if (canSaveRef.current) onSaveRef.current();
          return true;
        },
      }]))),
    });
  }, [canSave, onSave]);

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

function localValidation(skill: string, text: string): readonly ValidationIssue[] {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (block === null) {
    return [{
      path: 'frontmatter',
      code: 'invalid-frontmatter',
      message: 'SKILL.md must start with valid YAML frontmatter.',
      line: 1,
    }];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(block[1] ?? '');
  } catch {
    return [{
      path: 'frontmatter',
      code: 'invalid-frontmatter',
      message: 'SKILL.md must start with valid YAML frontmatter.',
      line: 1,
    }];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [{
      path: 'frontmatter',
      code: 'invalid-frontmatter',
      message: 'SKILL.md must start with valid YAML frontmatter.',
      line: 1,
    }];
  }
  const name = (parsed as Record<string, unknown>).name;
  if (typeof name !== 'string' || name === '') {
    return [{ path: 'name', code: 'missing-name', message: 'Frontmatter must include a name.' }];
  }
  if (name !== skill) {
    return [{
      path: 'name',
      code: 'name-mismatch',
      message: 'The frontmatter name must match the skill folder name.',
    }];
  }
  return [];
}

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
  onDirtyChange,
  onRequestDiscard,
}: {
  environment: string;
  itemRevision: Revision;
  skill: string;
  onClose(trigger: HTMLElement | null): void;
  onDirtyChange(dirty: boolean): void;
  onRequestDiscard(action: () => void, trigger: HTMLElement | null): void;
}): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const [mode, setMode] = useState<WorkspaceMode>('source');
  const [state, setState] = useState<DocumentState>({ status: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [copyNotice, setCopyNotice] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stateRef = useRef(state);
  const saveSequenceRef = useRef(0);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  stateRef.current = state;

  useEffect(() => () => {
    mountedRef.current = false;
    saveSequenceRef.current += 1;
  }, []);

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
    setCopyNotice(undefined);
    setSaveState((current) =>
      current.status === 'validation' || current.status === 'failure' ||
      (current.status === 'saved' && current.publication === 'complete')
        ? { status: 'idle' }
        : current);
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
  const dirty = retained !== undefined && retained.draft !== retained.document.text;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const canSave = state.status === 'ready' && dirty &&
    saveState.status !== 'submitting' && saveState.status !== 'stale' &&
    !(saveState.status === 'saved' && (
      saveState.publication === 'git-pending' || saveState.refreshRequired
    ));

  const performSave = useCallback((): void => {
    const current = stateRef.current;
    if (
      submittingRef.current ||
      current.status !== 'ready' ||
      current.draft === current.document.text
    ) return;
    const issues = localValidation(skill, current.draft);
    if (issues.length > 0) {
      setSaveState({ status: 'validation', issues });
      return;
    }
    const submittedText = current.draft;
    const submittedRevision = current.document.revision;
    const sequence = ++saveSequenceRef.current;
    submittingRef.current = true;
    setCopyNotice(undefined);
    setSaveState({ status: 'submitting' });
    void saveSkillDocument({
      environment: current.document.environment,
      skill: current.document.skill,
      text: submittedText,
      expectedRevision: submittedRevision,
    }).then(
      (result) => {
        if (!mountedRef.current || sequence !== saveSequenceRef.current) return;
        const saved = result.document;
        setState((latest) => {
          if (
            latest.status !== 'ready' ||
            latest.document.revision !== submittedRevision
          ) return latest;
          const document = saved !== undefined &&
            saved.environment === environment &&
            saved.skill === skill &&
            saved.text === submittedText
            ? saved
            : { ...latest.document, text: submittedText };
          return {
            status: 'ready',
            document,
            draft: latest.draft,
          };
        });
        setSaveState({
          status: 'saved',
          publication: result.publication,
          refreshRequired: result.refreshRequired || saved === undefined,
        });
      },
      (error: unknown) => {
        if (!mountedRef.current || sequence !== saveSequenceRef.current) return;
        if (
          error instanceof UiApiError &&
          error.code === 'VALIDATION_FAILED' &&
          error.details?.kind === 'validation'
        ) {
          setSaveState({ status: 'validation', issues: error.details.issues });
        } else if (error instanceof UiApiError && error.code === 'STALE_REVISION') {
          setSaveState({ status: 'stale' });
        } else if (error instanceof UiApiError && error.code === 'PENDING_RECOVERY') {
          setSaveState({
            status: 'failure',
            message: 'Required local recovery must finish before this draft can be saved.',
          });
        } else {
          setSaveState({
            status: 'failure',
            message: 'The save request failed. Your draft has been retained.',
          });
        }
      },
    ).finally(() => {
      if (sequence === saveSequenceRef.current) submittingRef.current = false;
    });
  }, [environment, skill]);

  const reloadLatest = useCallback((): void => {
    const current = stateRef.current;
    if (current.status !== 'ready') return;
    const sequence = ++saveSequenceRef.current;
    submittingRef.current = true;
    setCopyNotice(undefined);
    setSaveState({ status: 'submitting' });
    void getSkillDocument(environment, skill).then(
      (document) => {
        if (!mountedRef.current || sequence !== saveSequenceRef.current) return;
        setState({ status: 'ready', document, draft: document.text });
        setSaveState({ status: 'idle' });
      },
      () => {
        if (!mountedRef.current || sequence !== saveSequenceRef.current) return;
        setSaveState({
          status: 'failure',
          message: 'The latest document could not be loaded. Your draft has been retained.',
        });
      },
    ).finally(() => {
      if (sequence === saveSequenceRef.current) submittingRef.current = false;
    });
  }, [environment, skill]);

  const copyDraft = useCallback((): void => {
    const current = stateRef.current;
    if (current.status !== 'ready') return;
    void navigator.clipboard.writeText(current.draft).then(
      () => setCopyNotice('Draft copied to the clipboard. The saved document was not changed.'),
      () => setCopyNotice('The draft could not be copied. It remains in the editor.'),
    );
  }, []);

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
          <button
            disabled={!canSave}
            type="button"
            onClick={performSave}
            title={canSave ? 'Save skill document (Ctrl or Command+S)' : 'Save is available for a changed, ready document'}
          >
            {saveState.status === 'submitting'
              ? 'Saving skill document…'
              : canSave
                ? 'Save skill document'
                : 'Save unavailable'}
          </button>
          <button
            className="button-secondary"
            disabled={saveState.status === 'submitting'}
            type="button"
            onClick={(event) => onClose(event.currentTarget)}
          >
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
      {saveState.status === 'validation' ? (
        <div className="skill-editor-message inventory-error" role="alert">
          <strong>This draft is not a valid skill document.</strong>
          <ul>
            {saveState.issues.map((issue, index) => (
              <li key={`${issue.path ?? 'document'}-${issue.code ?? index}`}>
                {issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {saveState.status === 'stale' ? (
        <div className="skill-editor-message inventory-error" role="alert">
          <div>
            <strong>This skill changed outside the editor. Your draft was not saved.</strong>
            <span>Copy the draft, or reload the latest document before editing again.</span>
          </div>
          <button className="button-secondary" type="button" onClick={copyDraft}>Copy draft</button>
          <button
            type="button"
            onClick={(event) => onRequestDiscard(reloadLatest, event.currentTarget)}
          >
            Reload latest
          </button>
        </div>
      ) : null}
      {saveState.status === 'failure' ? (
        <div className="skill-editor-message inventory-error" role="status">
          {saveState.message}
        </div>
      ) : null}
      {copyNotice === undefined ? null : (
        <div className="skill-editor-message" role="status">{copyNotice}</div>
      )}
      {saveState.status === 'saved' ? (
        <div className="skill-editor-message" role="status">
          {saveState.publication === 'git-pending'
            ? 'Saved locally. Required Git bookkeeping is pending; do not save this version again.'
            : saveState.refreshRequired
              ? 'Saved locally. Reload the latest document before editing again.'
              : 'Skill document saved locally.'}
        </div>
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
                canSave={canSave}
                onSave={performSave}
                value={retained.draft}
              />
            </div>
            {mode === 'source' ? null : (
              <div className="skill-preview-pane">
                <h3>Rendered preview</h3>
                <SafeMarkdown source={retained.draft} />
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
