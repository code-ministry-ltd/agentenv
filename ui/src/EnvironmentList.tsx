import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContentCounts,
  ContentTransferSuccess,
  EnvironmentDeleteSuccess,
  EnvironmentInventory,
  EnvironmentLifecycleSuccess,
  EnvironmentSummary,
  GitSkillImportSuccess,
} from '../../src/ui/contract.js';
import { listEnvironmentSummaries } from './api.js';
import { DeleteEnvironmentDialog } from './DeleteEnvironmentDialog.js';
import { EnvironmentDialog } from './EnvironmentDialog.js';
import { EnvironmentView } from './EnvironmentView.js';
import { GitImportDialog } from './GitImportDialog.js';
import {
  UnsavedChangesDialog,
  type PendingDiscardAction,
} from './UnsavedChangesDialog.js';

type CatalogState =
  | { status: 'loading' }
  | {
      status: 'ready';
      items: readonly EnvironmentSummary[];
      refresh: 'idle' | 'refreshing' | 'error';
    }
  | { status: 'error' };

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeCounts(counts: ContentCounts): string {
  return [
    countLabel(counts.skill, 'skill'),
    countLabel(counts.instruction, 'instruction'),
    countLabel(counts.mcp, 'MCP server'),
    countLabel(counts.agent, 'agent'),
    countLabel(counts.command, 'command'),
  ].join(' · ');
}

export function EnvironmentList(): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' });
  const [selectedName, setSelectedName] = useState<string>();
  const [dialog, setDialog] = useState<'create' | 'clone'>();
  const [deleteName, setDeleteName] = useState<string>();
  const [deletionNotice, setDeletionNotice] = useState<string>();
  const [publishedInventory, setPublishedInventory] = useState<EnvironmentInventory>();
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardAction>();
  const [gitDialog, setGitDialog] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const cloneTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const gitTriggerRef = useRef<HTMLButtonElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const inspectTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusNameRef = useRef<string | null | undefined>(undefined);
  const mutationEpochRef = useRef(0);
  const catalogRef = useRef(catalog);
  const deleteNameRef = useRef(deleteName);
  const selectedNameRef = useRef(selectedName);
  catalogRef.current = catalog;
  deleteNameRef.current = deleteName;
  selectedNameRef.current = selectedName;

  useEffect(() => {
    if (!editorDirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editorDirty]);

  const requestDiscard = useCallback((
    action: () => void,
    trigger: HTMLElement | null,
  ): void => {
    if (!editorDirty) {
      action();
      return;
    }
    setPendingDiscard({ action, trigger });
  }, [editorDirty]);

  useEffect(() => {
    let ignore = false;
    const mutationEpoch = mutationEpochRef.current;
    setCatalog((current) => current.status === 'ready'
      ? { ...current, refresh: 'refreshing' }
      : { status: 'loading' });

    async function load(): Promise<void> {
      try {
        const items = await listEnvironmentSummaries();
        if (!ignore && mutationEpoch === mutationEpochRef.current) {
          const missingDeleteName = deleteNameRef.current;
          if (
            missingDeleteName !== undefined &&
            !items.some((environment) => environment.name === missingDeleteName)
          ) {
            const previous = catalogRef.current;
            const previousIndex = previous.status === 'ready'
              ? previous.items.findIndex((item) => item.name === missingDeleteName)
              : 0;
            const replacement = items[
              Math.min(Math.max(previousIndex, 0), items.length - 1)
            ];
            pendingFocusNameRef.current = replacement?.name ?? null;
            setSelectedName((current) => current === missingDeleteName
              ? replacement?.name
              : current);
            setDeleteName(undefined);
          }
          const missingSelectedName = selectedNameRef.current;
          if (
            missingSelectedName !== undefined &&
            !items.some((environment) => environment.name === missingSelectedName)
          ) {
            const previous = catalogRef.current;
            const previousIndex = previous.status === 'ready'
              ? previous.items.findIndex((item) => item.name === missingSelectedName)
              : 0;
            const replacement = items[Math.min(Math.max(previousIndex, 0), items.length - 1)];
            pendingFocusNameRef.current = replacement?.name ?? null;
            setSelectedName(replacement?.name);
            setPublishedInventory(undefined);
          }
          setCatalog({ status: 'ready', items, refresh: 'idle' });
        }
      } catch {
        if (!ignore && mutationEpoch === mutationEpochRef.current) {
          setCatalog((current) => current.status === 'ready'
            ? { ...current, refresh: 'error' }
            : { status: 'error' });
        }
      }
    }

    void load();
    return () => {
      ignore = true;
    };
  }, [request]);

  useEffect(() => {
    if (catalog.status !== 'ready' || pendingFocusNameRef.current === undefined) return;
    const name = pendingFocusNameRef.current;
    pendingFocusNameRef.current = undefined;
    if (name === null) listHeadingRef.current?.focus();
    else inspectTriggerRefs.current.get(name)?.focus();
  }, [catalog]);

  const selectedEnvironment = catalog.status === 'ready'
    ? catalog.items.find((environment) => environment.name === selectedName)
    : undefined;
  const refresh = (): void => setRequest((current) => current + 1);
  const published = (result: EnvironmentLifecycleSuccess): void => {
    mutationEpochRef.current += 1;
    setPublishedInventory(result.environment);
    setSelectedName(result.name);
    setCatalog((current) => {
      if (current.status !== 'ready' || result.environment === undefined) return current;
      return {
        status: 'ready',
        items: [
          ...current.items.filter((environment) => environment.name !== result.name),
          result.environment,
        ].sort((left, right) => left.name.localeCompare(right.name)),
        refresh: 'idle',
      };
    });
    refresh();
  };
  const deleted = (result: EnvironmentDeleteSuccess): void => {
    if (catalog.status !== 'ready') return;
    mutationEpochRef.current += 1;
    const deletedIndex = catalog.items.findIndex((item) => item.name === result.name);
    const remaining = catalog.items.filter((item) => item.name !== result.name);
    const replacement = remaining[Math.min(Math.max(deletedIndex, 0), remaining.length - 1)];
    setCatalog({ status: 'ready', items: remaining, refresh: 'idle' });
    setPublishedInventory(undefined);
    if (selectedName === result.name) setSelectedName(replacement?.name);
    pendingFocusNameRef.current = replacement?.name ?? null;
    setDeletionNotice(result.publication === 'git-pending'
      ? `Deleted ${result.name}. Required Git bookkeeping is pending; resolve it from the CLI.`
      : `Deleted ${result.name}.`);
    refresh();
  };
  const transferred = (result: ContentTransferSuccess): void => {
    mutationEpochRef.current += 1;
    setCatalog((current) => {
      if (current.status !== 'ready') return current;
      const replacements = [result.sourceEnvironment, result.destinationEnvironment]
        .filter((candidate): candidate is EnvironmentInventory => candidate !== undefined);
      if (replacements.length === 0) return current;
      return {
        status: 'ready',
        items: current.items.map((environment) =>
          replacements.find((candidate) => candidate.name === environment.name) ?? environment),
        refresh: 'idle',
      };
    });
    if (result.sourceEnvironment?.name === selectedName) {
      setPublishedInventory(result.sourceEnvironment);
    }
    refresh();
  };
  const imported = (result: GitSkillImportSuccess): void => {
    mutationEpochRef.current += 1;
    if (result.environmentInventory !== undefined) {
      setCatalog((current) => current.status !== 'ready' ? current : {
        status: 'ready',
        items: current.items.map((environment) =>
          environment.name === result.environment
            ? result.environmentInventory!
            : environment),
        refresh: 'idle',
      });
      if (selectedName === result.environment) {
        setPublishedInventory(result.environmentInventory);
      }
    }
    refresh();
  };
  const deleteEnvironment = catalog.status === 'ready'
    ? catalog.items.find((environment) => environment.name === deleteName)
    : undefined;

  return (
    <section className="catalog-panel" aria-labelledby="environment-list-title">
      <div className="catalog-heading">
        <div>
          <p className="eyebrow">Local catalogue</p>
          <h2 id="environment-list-title" ref={listHeadingRef} tabIndex={-1}>Environments</h2>
        </div>
        {catalog.status === 'ready' ? (
          <div className="catalog-tools">
            {catalog.items.length > 0 ? (
              <span className="catalog-total">{countLabel(catalog.items.length, 'environment')}</span>
            ) : null}
            <div className="catalog-actions">
              <button
                ref={createTriggerRef}
                type="button"
                onClick={() => setDialog('create')}
              >
                Create environment
              </button>
              <button
                className="button-secondary"
                ref={cloneTriggerRef}
                type="button"
                onClick={() => setDialog('clone')}
              >
                Clone environment
              </button>
              <button
                className="button-secondary"
                ref={gitTriggerRef}
                type="button"
                onClick={() => setGitDialog(true)}
              >
                Import from Git
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {catalog.status === 'loading' ? (
        <div className="catalog-message" role="status" aria-busy="true">
          <span aria-hidden="true" className="status-pulse" />
          Loading environments…
        </div>
      ) : null}

      {catalog.status === 'error' ? (
        <div className="catalog-message catalog-error" role="alert">
          <div>
            <strong>Environment summaries are unavailable.</strong>
            <span>The local request failed. Your environment files were not changed.</span>
          </div>
          <button type="button" onClick={refresh}>
            Retry environments
          </button>
        </div>
      ) : null}

      {catalog.status === 'ready' && catalog.refresh === 'error' ? (
        <div className="catalog-message catalog-error" role="alert">
          <div>
            <strong>Environment refresh failed.</strong>
            <span>Showing the last known catalogue. Your environment files were not changed.</span>
          </div>
          <button type="button" onClick={refresh}>
            Retry environments
          </button>
        </div>
      ) : null}

      {deletionNotice === undefined ? null : (
        <div className="catalog-message deletion-result" role="status">
          <span aria-hidden="true" className="status-check">✓</span>
          <strong>{deletionNotice}</strong>
        </div>
      )}

      {catalog.status === 'ready' && catalog.items.length === 0 ? (
        <div className="catalog-message catalog-empty">
          <div>
            <strong>No environments yet.</strong>
            <span>Create a new scaffold or clone an existing environment.</span>
          </div>
        </div>
      ) : null}

      {catalog.status === 'ready' && catalog.items.length > 0 ? (
        <>
          <ul className="environment-list" aria-label="Environments">
            {catalog.items.map((environment) => {
              const selected = selectedName === environment.name;
              return (
                <li key={environment.name} data-revision={environment.revision}>
                  <article className={selected ? 'environment-card selected' : 'environment-card'}>
                    <div className="environment-card-heading">
                      <h3>
                        <button
                          aria-controls="selected-environment"
                          aria-expanded={selected}
                          aria-label={`Inspect ${environment.name}`}
                          className="environment-select"
                          ref={(element) => {
                            if (element === null) inspectTriggerRefs.current.delete(environment.name);
                            else inspectTriggerRefs.current.set(environment.name, element);
                          }}
                          onClick={(event) => {
                            if (selectedName === environment.name) return;
                            requestDiscard(() => {
                              setSelectedName(environment.name);
                              if (publishedInventory?.name !== environment.name) {
                                setPublishedInventory(undefined);
                              }
                            }, event.currentTarget);
                          }}
                          type="button"
                        >
                          {environment.name}
                        </button>
                      </h3>
                      <div className="environment-card-actions">
                        <span className={environment.active ? 'activity active' : 'activity'}>
                          <span aria-hidden="true" className="activity-dot" />
                          {environment.active ? 'Active' : 'Inactive'}
                        </span>
                        <button
                          aria-label={`Delete ${environment.name}`}
                          className="button-delete-link"
                          type="button"
                          onClick={(event) => {
                            deleteTriggerRef.current = event.currentTarget;
                            const openDelete = (): void => setDeleteName(environment.name);
                            if (selectedName === environment.name) {
                              requestDiscard(openDelete, event.currentTarget);
                            } else {
                              openDelete();
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <p className="environment-description">
                      {environment.description || 'No description.'}
                    </p>
                    <p className="environment-counts">{summarizeCounts(environment.counts)}</p>
                    <p className="environment-revision" title={environment.revision}>
                      Revision {environment.revision.slice(0, 10)}
                    </p>
                  </article>
                </li>
              );
            })}
          </ul>
          <div id="selected-environment">
            {selectedEnvironment === undefined ? null : (
              <EnvironmentView
                environments={catalog.items}
                key={selectedEnvironment.name}
                environment={selectedEnvironment}
                initialInventory={publishedInventory?.name === selectedEnvironment.name
                  ? publishedInventory
                  : undefined}
                onEditorDirtyChange={setEditorDirty}
                onRefreshEnvironments={refresh}
                onRequestDiscard={requestDiscard}
                onTransferred={transferred}
              />
            )}
          </div>
        </>
      ) : null}
      {dialog === undefined || catalog.status !== 'ready' ? null : (
        <EnvironmentDialog
          environments={catalog.items}
          mode={dialog}
          onClose={() => setDialog(undefined)}
          onPublished={published}
          onRefresh={refresh}
          triggerRef={dialog === 'create' ? createTriggerRef : cloneTriggerRef}
        />
      )}
      {deleteEnvironment === undefined ? null : (
        <DeleteEnvironmentDialog
          environment={deleteEnvironment}
          onClose={() => setDeleteName(undefined)}
          onDeleted={deleted}
          onRefresh={refresh}
          triggerRef={deleteTriggerRef}
        />
      )}
      {gitDialog ? (
        <GitImportDialog
          environments={catalog.status === 'ready' ? catalog.items : []}
          initialEnvironment={selectedName}
          onClose={() => setGitDialog(false)}
          onImported={imported}
          triggerRef={gitTriggerRef}
        />
      ) : null}
      {pendingDiscard === undefined ? null : (
        <UnsavedChangesDialog
          pending={pendingDiscard}
          onCancel={() => setPendingDiscard(undefined)}
          onDiscard={() => {
            const { action } = pendingDiscard;
            setPendingDiscard(undefined);
            action();
          }}
        />
      )}
    </section>
  );
}
