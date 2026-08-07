import { useEffect, useRef } from 'react';

export interface PendingDiscardAction {
  action(): void;
  trigger: HTMLElement | null;
}

export function UnsavedChangesDialog({
  onCancel,
  onDiscard,
  pending,
}: {
  onCancel(): void;
  onDiscard(): void;
  pending: PendingDiscardAction;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    continueRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (pending.trigger?.isConnected) pending.trigger.focus();
    };
  }, [pending]);

  return (
    <dialog
      aria-describedby="unsaved-changes-description"
      aria-labelledby="unsaved-changes-title"
      className="environment-dialog unsaved-changes-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const first = buttons[0];
        const last = buttons.at(-1);
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
      <p className="eyebrow">Unsaved skill draft</p>
      <h2 id="unsaved-changes-title">Discard your changes?</h2>
      <p id="unsaved-changes-description">
        This draft has not been saved. Continue editing to keep it, or discard it and proceed.
      </p>
      <div className="dialog-actions">
        <button className="button-secondary" onClick={onCancel} ref={continueRef} type="button">
          Continue editing
        </button>
        <button className="button-delete" onClick={onDiscard} type="button">
          Discard changes
        </button>
      </div>
    </dialog>
  );
}
