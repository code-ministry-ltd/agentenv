import { useEffect, useRef, useState, type RefObject } from 'react';
import type {
  EnvironmentDeleteSuccess,
  EnvironmentSummary,
} from '../../src/ui/contract.js';
import { deleteEnvironment, UiApiError } from './api.js';

interface DeleteEnvironmentDialogProps {
  environment: EnvironmentSummary;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onDeleted(result: EnvironmentDeleteSuccess): void;
  onRefresh(): void;
}

interface DeleteIssue {
  kind: 'validation' | 'active' | 'stale' | 'pending' | 'drift' | 'missing' | 'failure';
  message: string;
  refresh: boolean;
}

function requestIssue(error: unknown, name: string): DeleteIssue {
  if (!(error instanceof UiApiError)) {
    return {
      kind: 'failure',
      message: 'The environment could not be deleted. Your confirmation is retained; retry when ready.',
      refresh: false,
    };
  }
  switch (error.code) {
    case 'VALIDATION_FAILED':
    case 'MALFORMED_REQUEST':
      return {
        kind: 'validation',
        message: `Type ${name} exactly to confirm deletion.`,
        refresh: false,
      };
    case 'ACTIVE_ENVIRONMENT':
      return {
        kind: 'active',
        message: `${name} is active and must be deactivated before it can be deleted.`,
        refresh: true,
      };
    case 'STALE_REVISION':
      return {
        kind: 'stale',
        message: `${name} changed after this dialog opened. Refresh environments, review it, then retry.`,
        refresh: true,
      };
    case 'PENDING_RECOVERY':
      return {
        kind: 'pending',
        message: 'Another operation requires recovery. Resolve it from the CLI, then refresh and retry.',
        refresh: true,
      };
    case 'DRIFT_BLOCKED':
      return {
        kind: 'drift',
        message: error.details?.kind === 'blocked-drift' && error.details.secretBearing
          ? 'Secret-bearing store changes must be resolved before deletion. Your environment is retained.'
          : 'Uncommitted store changes must be resolved before deletion. Your environment is retained.',
        refresh: true,
      };
    case 'NOT_FOUND':
      return {
        kind: 'missing',
        message: `${name} is no longer available. Refresh environments to reconcile the catalogue.`,
        refresh: true,
      };
    default:
      return {
        kind: 'failure',
        message: 'The environment could not be deleted. Your confirmation is retained; retry when ready.',
        refresh: false,
      };
  }
}

export function DeleteEnvironmentDialog({
  environment,
  triggerRef,
  onClose,
  onDeleted,
  onRefresh,
}: DeleteEnvironmentDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issue, setIssue] = useState<DeleteIssue>();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    confirmationRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      triggerRef.current?.focus();
    };
  }, [triggerRef]);

  const closeDialog = (): void => {
    if (!submitting) dialogRef.current?.close();
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (confirmation !== environment.name) {
      setIssue({
        kind: 'validation',
        message: `Type ${environment.name} exactly to confirm deletion.`,
        refresh: false,
      });
      confirmationRef.current?.focus();
      return;
    }
    setIssue(undefined);
    setSubmitting(true);
    try {
      const result = await deleteEnvironment({
        operation: 'delete',
        name: environment.name,
        confirmation,
        targetRevision: environment.revision,
        containerRevision: environment.containerRevision,
      });
      onDeleted(result);
      dialogRef.current?.close();
    } catch (error) {
      setIssue(requestIssue(error, environment.name));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      aria-describedby="delete-environment-help"
      aria-labelledby="delete-environment-title"
      className="environment-dialog delete-environment-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) closeDialog();
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
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
        <p className="eyebrow">Permanent deletion</p>
        <h2 id="delete-environment-title">Delete {environment.name}</h2>
        <p id="delete-environment-help">
          This permanently removes <strong>{environment.name}</strong>. Type its exact name below
          to confirm. Active environments are always refused.
        </p>
        <div className="dialog-fields">
          <label htmlFor="delete-environment-confirmation">
            Type {environment.name} to confirm
          </label>
          <input
            aria-invalid={issue?.kind === 'validation'}
            autoComplete="off"
            id="delete-environment-confirmation"
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            ref={confirmationRef}
            spellCheck={false}
            type="text"
            value={confirmation}
          />
        </div>
        {submitting ? (
          <div aria-busy="true" className="dialog-status" role="status">
            <span aria-hidden="true" className="status-pulse" />
            Deleting {environment.name}…
          </div>
        ) : null}
        {issue === undefined ? null : (
          <div className={`dialog-issue dialog-issue-${issue.kind}`} role="alert">
            <span>{issue.message}</span>
            {issue.refresh ? (
              <button type="button" onClick={onRefresh}>Refresh environments</button>
            ) : null}
          </div>
        )}
        <div className="dialog-actions">
          <button className="button-secondary" disabled={submitting} type="button" onClick={closeDialog}>
            Cancel
          </button>
          <button className="button-danger" disabled={submitting} type="submit">Delete now</button>
        </div>
      </form>
    </dialog>
  );
}
