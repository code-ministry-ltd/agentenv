import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH,
  type EnvironmentLifecycleRequest,
  type EnvironmentLifecycleSuccess,
  type EnvironmentName,
  type EnvironmentSummary,
} from '../../src/ui/contract.js';
import { publishEnvironment, UiApiError } from './api.js';

const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

type DialogMode = 'create' | 'clone';
type SubmissionIssue =
  | { kind: 'validation'; message: string }
  | { kind: 'collision'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'pending'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'failure'; message: string };

interface EnvironmentDialogProps {
  mode: DialogMode;
  environments: readonly EnvironmentSummary[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onPublished(result: EnvironmentLifecycleSuccess): void;
  onRefresh(): void;
}

function requestIssue(error: unknown, name: string): SubmissionIssue {
  if (!(error instanceof UiApiError)) {
    return {
      kind: 'failure',
      message: 'The environment could not be published. Your inputs are retained; retry when ready.',
    };
  }
  switch (error.code) {
    case 'VALIDATION_FAILED':
    case 'MALFORMED_REQUEST':
      return {
        kind: 'validation',
        message: 'Check the exact environment name and other fields, then try again.',
      };
    case 'COLLISION':
      return {
        kind: 'collision',
        message: `An environment named ${name} already exists. Choose another exact name and retry.`,
      };
    case 'STALE_REVISION':
      return {
        kind: 'stale',
        message: 'Environment data changed during publication. Refresh environments, then retry.',
      };
    case 'PENDING_RECOVERY':
      return {
        kind: 'pending',
        message: error.details?.kind === 'pending-recovery' &&
            error.details.publication === 'environment-published'
          ? 'The environment was published. Required Git bookkeeping is pending; resolve it from the CLI, then refresh environments.'
          : 'Required Git bookkeeping is pending. Resolve it from the CLI, then refresh and retry.',
      };
    case 'NOT_FOUND':
      return {
        kind: 'missing',
        message: 'The source environment is no longer available. Refresh environments and choose again.',
      };
    default:
      return {
        kind: 'failure',
        message: 'The environment could not be published. Your inputs are retained; retry when ready.',
      };
  }
}

function localIssue(
  name: string,
  description: string,
  mode: DialogMode,
  source: string,
): SubmissionIssue | undefined {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    return {
      kind: 'validation',
      message: "Use 1–64 lowercase letters, digits, '-' or '_', starting and ending with a letter or digit.",
    };
  }
  if (description.length > UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH) {
    return {
      kind: 'validation',
      message: `Description must be at most ${UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }
  if (mode === 'clone' && source === '') {
    return { kind: 'validation', message: 'Choose an existing source environment.' };
  }
  return undefined;
}

export function EnvironmentDialog({
  mode,
  environments,
  triggerRef,
  onClose,
  onPublished,
  onRefresh,
}: EnvironmentDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState(environments[0]?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [issue, setIssue] = useState<SubmissionIssue>();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      triggerRef.current?.focus();
    };
  }, [triggerRef]);

  useEffect(() => {
    if (!environments.some((environment) => environment.name === source)) {
      setSource(environments[0]?.name ?? '');
    }
  }, [environments, source]);

  const title = mode === 'create' ? 'Create environment' : 'Clone environment';
  const closeDialog = (): void => {
    if (submitting) return;
    dialogRef.current?.close();
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const validation = localIssue(name, description, mode, source);
    if (validation !== undefined) {
      setIssue(validation);
      nameRef.current?.focus();
      return;
    }
    setIssue(undefined);
    setSubmitting(true);
    const request: EnvironmentLifecycleRequest = mode === 'create'
      ? {
          operation: 'create',
          name: name as EnvironmentName,
          ...(description === '' ? {} : { description }),
        }
      : {
          operation: 'clone',
          name: name as EnvironmentName,
          source: source as EnvironmentName,
        };
    try {
      // Once the server accepts a lifecycle mutation it may publish even if the
      // HTTP client disappears. Keep the dialog open until the authoritative
      // result arrives instead of pretending this request can be cancelled.
      const result = await publishEnvironment(request);
      onPublished(result);
      dialogRef.current?.close();
    } catch (error) {
      setIssue(requestIssue(error, name));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      aria-describedby="environment-dialog-help"
      aria-labelledby="environment-dialog-title"
      className="environment-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) closeDialog();
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
        )];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      ref={dialogRef}
    >
      <form method="dialog" noValidate onSubmit={(event) => void submit(event)}>
        <p className="eyebrow">Environment lifecycle</p>
        <h2 id="environment-dialog-title">{title}</h2>
        <p id="environment-dialog-help">
          {mode === 'create'
            ? 'Publish a new environment scaffold using its exact local name.'
            : 'Copy one complete environment, including its source provenance.'}
        </p>
        <div className="dialog-fields">
          <label htmlFor="new-environment-name">New environment name</label>
          <input
            aria-invalid={issue?.kind === 'validation'}
            autoComplete="off"
            id="new-environment-name"
            maxLength={64}
            onChange={(event) => setName(event.currentTarget.value)}
            ref={nameRef}
            spellCheck={false}
            type="text"
            value={name}
          />
          {mode === 'create' ? (
            <>
              <label htmlFor="environment-description">Description (optional)</label>
              <textarea
                id="environment-description"
                maxLength={UI_ENVIRONMENT_DESCRIPTION_MAX_LENGTH}
                onChange={(event) => setDescription(event.currentTarget.value)}
                rows={3}
                value={description}
              />
            </>
          ) : (
            <>
              <label htmlFor="source-environment">Source environment</label>
              <select
                disabled={environments.length === 0}
                id="source-environment"
                onChange={(event) => setSource(event.currentTarget.value)}
                value={source}
              >
                {environments.map((environment) => (
                  <option key={environment.name} value={environment.name}>
                    {environment.name}
                  </option>
                ))}
              </select>
              {environments.length === 0 ? (
                <p className="field-help">Create an environment before cloning one.</p>
              ) : null}
            </>
          )}
        </div>
        {submitting ? (
          <div aria-busy="true" className="dialog-status" role="status">
            <span aria-hidden="true" className="status-pulse" />
            {mode === 'create'
              ? `Creating ${name}…`
              : `Cloning ${source} as ${name}…`}
          </div>
        ) : null}
        {issue === undefined ? null : (
          <div className={`dialog-issue dialog-issue-${issue.kind}`} role="alert">
            <span>{issue.message}</span>
            {issue.kind === 'stale' || issue.kind === 'pending' || issue.kind === 'missing' ? (
              <button type="button" onClick={onRefresh}>Refresh environments</button>
            ) : null}
          </div>
        )}
        <div className="dialog-actions">
          <button
            className="button-secondary"
            disabled={submitting}
            type="button"
            onClick={closeDialog}
          >
            Cancel
          </button>
          <button disabled={submitting || (mode === 'clone' && environments.length === 0)} type="submit">
            {mode === 'create' ? 'Create now' : 'Clone now'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
