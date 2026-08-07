import { useEffect, useRef, useState, type RefObject } from 'react';
import type {
  ContentItem,
  CopyContentRequest,
  CopyContentSuccess,
  EnvironmentInventory,
  EnvironmentName,
  EnvironmentSummary,
  Revision,
} from '../../src/ui/contract.js';
import { copyContent, getEnvironmentInventory, UiApiError } from './api.js';

interface TransferDialogProps {
  source: EnvironmentInventory;
  item: ContentItem;
  environments: readonly EnvironmentSummary[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onCopied(result: CopyContentSuccess): void;
  onRefresh(): void;
}

type DestinationState =
  | { status: 'loading' }
  | { status: 'ready'; inventory: EnvironmentInventory }
  | { status: 'error' };

interface CollisionConsent {
  itemRevision: Revision;
  environmentRevision: Revision;
  containerRevision: Revision;
  sourceItemRevision: Revision;
  sourceEnvironmentRevision: Revision;
  sourceContainerRevision: Revision;
}

type TransferIssue = {
  kind: 'collision' | 'stale' | 'pending' | 'missing' | 'failure' | 'refresh';
  message: string;
  collision?: CollisionConsent;
};

function safeIssue(
  error: unknown,
  destination: string,
  request: CopyContentRequest,
): TransferIssue {
  if (!(error instanceof UiApiError)) {
    return {
      kind: 'failure',
      message: 'The content could not be copied. Your destination is retained; retry when ready.',
    };
  }
  if (error.code === 'COLLISION' && error.details?.kind === 'transfer-collision') {
    return {
      kind: 'collision',
      message: `${destination} already contains this exact item. Review the collision before replacing it.`,
      collision: {
        itemRevision: error.details.destinationItemRevision,
        environmentRevision: error.details.destinationEnvironmentRevision,
        containerRevision: error.details.destinationEnvironmentContainerRevision,
        sourceItemRevision: request.sourceItemRevision,
        sourceEnvironmentRevision: request.sourceEnvironmentRevision,
        sourceContainerRevision: request.sourceEnvironmentContainerRevision,
      },
    };
  }
  if (error.code === 'STALE_REVISION') {
    return {
      kind: 'stale',
      message: 'Source or destination content changed. Refresh both environments, review, then retry.',
    };
  }
  if (error.code === 'PENDING_RECOVERY') {
    return {
      kind: 'pending',
      message: 'Another operation requires recovery. Resolve it from the CLI, then refresh and retry.',
    };
  }
  if (error.code === 'NOT_FOUND') {
    return {
      kind: 'missing',
      message: 'The source, destination, or item is no longer available. Refresh environments.',
    };
  }
  return {
    kind: 'failure',
    message: 'The content could not be copied. Your destination is retained; retry when ready.',
  };
}

export function TransferDialog({
  source,
  item,
  environments,
  triggerRef,
  fallbackFocusRef,
  onClose,
  onCopied,
  onRefresh,
}: TransferDialogProps): React.JSX.Element {
  const destinations = environments.filter((environment) => environment.name !== source.name);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const destinationRef = useRef<HTMLSelectElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const [destination, setDestination] = useState(destinations[0]?.name ?? '');
  const [destinationState, setDestinationState] = useState<DestinationState>({ status: 'loading' });
  const [destinationRequest, setDestinationRequest] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [issue, setIssue] = useState<TransferIssue>();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    if (destinations.length === 0) cancelRef.current?.focus();
    else destinationRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else fallbackFocusRef.current?.focus();
    };
  }, [fallbackFocusRef, triggerRef]);

  useEffect(() => {
    if (destination === '' || destinations.some((candidate) => candidate.name === destination)) {
      return;
    }
    setDestination(destinations[0]?.name ?? '');
    if (destinations.length === 0) cancelRef.current?.focus();
    else destinationRef.current?.focus();
  }, [destination, destinations]);

  useEffect(() => {
    if (destination === '') {
      setDestinationState({ status: 'error' });
      return;
    }
    let accept = true;
    const controller = new AbortController();
    setDestinationState({ status: 'loading' });
    void getEnvironmentInventory(destination, controller.signal).then(
      (inventory) => {
        if (accept) setDestinationState({ status: 'ready', inventory });
      },
      () => {
        if (accept) setDestinationState({ status: 'error' });
      },
    );
    return () => {
      accept = false;
      controller.abort();
    };
  }, [destination, destinationRequest]);

  const closeDialog = (): void => {
    if (!submittingRef.current) dialogRef.current?.close();
  };
  const refresh = (): void => {
    setIssue(undefined);
    setDestinationRequest((value) => value + 1);
    onRefresh();
  };
  const collisionConsent = issue?.collision;
  const currentDestinationItem = destinationState.status === 'ready'
    ? destinationState.inventory.items.find(
        (candidate) => candidate.kind === item.kind && candidate.name === item.name,
      )
    : undefined;
  const collisionConsentCurrent = collisionConsent !== undefined &&
    collisionConsent.sourceItemRevision === item.revision &&
    collisionConsent.sourceEnvironmentRevision === source.revision &&
    collisionConsent.sourceContainerRevision === source.containerRevision &&
    destinationState.status === 'ready' &&
    collisionConsent.environmentRevision === destinationState.inventory.revision &&
    collisionConsent.containerRevision === destinationState.inventory.containerRevision &&
    collisionConsent.itemRevision === currentDestinationItem?.revision;
  const publish = async (collision: 'fail' | 'overwrite'): Promise<void> => {
    if (submittingRef.current || destinationState.status !== 'ready') return;
    const consent = collision === 'overwrite' && collisionConsentCurrent
      ? collisionConsent
      : undefined;
    if (collision === 'overwrite' && consent === undefined) return;
    const request: CopyContentRequest = {
      operation: 'copy',
      kind: item.kind,
      name: item.name,
      sourceEnvironment: source.name,
      destinationEnvironment: destination as EnvironmentName,
      collision,
      sourceItemRevision: item.revision,
      sourceEnvironmentRevision: source.revision,
      sourceEnvironmentContainerRevision: source.containerRevision,
      destinationEnvironmentRevision: consent?.environmentRevision ?? destinationState.inventory.revision,
      destinationEnvironmentContainerRevision:
        consent?.containerRevision ?? destinationState.inventory.containerRevision,
      destinationItemRevision: consent?.itemRevision ?? currentDestinationItem?.revision ?? null,
    };
    submittingRef.current = true;
    setSubmitting(true);
    if (collision === 'fail') setIssue(undefined);
    try {
      const result = await copyContent(request);
      onCopied(result);
      dialogRef.current?.close();
    } catch (error) {
      setIssue(safeIssue(error, destination, request));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <dialog
      aria-describedby="transfer-dialog-help transfer-summary"
      aria-labelledby="transfer-dialog-title"
      className="environment-dialog transfer-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!submittingRef.current) closeDialog();
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled)',
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
      <form method="dialog" onSubmit={(event) => {
        event.preventDefault();
        void publish('fail');
      }}>
        <p className="eyebrow">Content transfer</p>
        <h2 id="transfer-dialog-title">Copy {item.name}</h2>
        <p id="transfer-dialog-help">
          Review the exact source and destination. Existing content is never replaced automatically.
        </p>
        <dl className="transfer-summary" id="transfer-summary">
          <div><dt>Source</dt><dd>{source.name}</dd></div>
          <div><dt>Kind</dt><dd>{item.kind}</dd></div>
          <div><dt>Name</dt><dd>{item.name}</dd></div>
        </dl>
        <div className="dialog-fields">
          <label htmlFor="transfer-destination">Destination environment</label>
          <select
            disabled={submitting || destinations.length === 0}
            id="transfer-destination"
            onChange={(event) => {
              setDestination(event.currentTarget.value);
              setIssue(undefined);
            }}
            ref={destinationRef}
            value={destination}
          >
            {destinations.map((environment) => (
              <option key={environment.name} value={environment.name}>{environment.name}</option>
            ))}
          </select>
          <p className="field-help">Destination: <strong>{destination || 'None available'}</strong></p>
          {destinations.length === 0 ? (
            <p className="field-help">Create another environment before copying content.</p>
          ) : null}
        </div>
        {destinationState.status === 'loading' ? (
          <div aria-busy="true" className="dialog-status" role="status">
            Loading {destination} content…
          </div>
        ) : null}
        {destinationState.status === 'error' ? (
          <div className="dialog-issue dialog-issue-refresh" role="alert">
            <span>Destination content is unavailable. Your selection is retained.</span>
          </div>
        ) : null}
        {submitting ? (
          <div aria-busy="true" className="dialog-status" role="status">
            Copying {item.name} from {source.name} to {destination}…
          </div>
        ) : null}
        {issue === undefined ? null : (
          <div className={`dialog-issue dialog-issue-${issue.kind}`} role="alert">
            <span>{issue.message}</span>
            {issue.kind === 'collision' && collisionConsentCurrent ? (
              <button
                className="button-danger"
                disabled={submitting}
                type="button"
                onClick={() => void publish('overwrite')}
              >
                Replace current {item.name}
              </button>
            ) : null}
          </div>
        )}
        <div className="dialog-actions">
          <button
            className="button-secondary"
            disabled={submitting}
            type="button"
            onClick={refresh}
          >
            Refresh content
          </button>
          <button
            className="button-secondary"
            disabled={submitting}
            ref={cancelRef}
            type="button"
            onClick={closeDialog}
          >
            Cancel
          </button>
          <button
            disabled={submitting || destinationState.status !== 'ready'}
            type="submit"
          >
            Copy now
          </button>
        </div>
      </form>
    </dialog>
  );
}
