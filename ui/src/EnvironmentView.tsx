import { useEffect, useRef, useState } from 'react';
import type {
  ContentItem,
  ContentKind,
  ContentName,
  ContentTransferSuccess,
  EnvironmentName,
  EnvironmentInventory,
  EnvironmentSummary,
  Revision,
  TransferOperation,
} from '../../src/ui/contract.js';
import { getEnvironmentInventory, UiApiError } from './api.js';
import { TransferDialog } from './TransferDialog.js';

type InventoryState =
  | { status: 'loading' }
  | { status: 'ready'; inventory: EnvironmentInventory }
  | { status: 'refreshing'; inventory: EnvironmentInventory }
  | { status: 'stale'; inventory?: EnvironmentInventory }
  | { status: 'unavailable' }
  | { status: 'error'; inventory?: EnvironmentInventory };

interface SelectedContentLocator {
  operation: TransferOperation;
  kind: ContentKind;
  name: string;
  sourceEnvironment: string;
}

interface MovedSourceTombstone {
  sourceEnvironment: EnvironmentName;
  kind: ContentKind;
  name: ContentName;
  revision: Revision;
}

function sameTombstone(
  left: MovedSourceTombstone,
  right: MovedSourceTombstone,
): boolean {
  return left.sourceEnvironment === right.sourceEnvironment &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.revision === right.revision;
}

function reconcileMovedSourceTombstones(
  tombstones: readonly MovedSourceTombstone[],
  inventory: EnvironmentInventory,
): readonly MovedSourceTombstone[] {
  return tombstones.filter((tombstone) => {
    if (tombstone.sourceEnvironment !== inventory.name) return true;
    const refreshedItem = inventory.items.find((item) =>
      item.kind === tombstone.kind && item.name === tombstone.name);
    return refreshedItem?.revision === tombstone.revision;
  });
}

function withoutMovedSources(
  inventory: EnvironmentInventory,
  tombstones: readonly MovedSourceTombstone[],
): EnvironmentInventory {
  const items = inventory.items.filter((item) => !tombstones.some((tombstone) =>
    tombstone.sourceEnvironment === inventory.name &&
    tombstone.kind === item.kind &&
    tombstone.name === item.name &&
    tombstone.revision === item.revision));
  return items.length === inventory.items.length ? inventory : { ...inventory, items };
}

const GROUPS: readonly {
  kind: ContentKind;
  label: string;
  singular: string;
}[] = [
  { kind: 'skill', label: 'Skills', singular: 'skill' },
  { kind: 'instruction', label: 'Instructions', singular: 'instruction' },
  { kind: 'mcp', label: 'MCP servers', singular: 'MCP server' },
  { kind: 'agent', label: 'Agents', singular: 'agent' },
  { kind: 'command', label: 'Commands', singular: 'command' },
];

function ItemMetadata({ item }: { item: ContentItem }): React.JSX.Element {
  if (item.kind === 'skill') {
    return (
      <>
        <p className="content-item-description">{itemSummary(item)}</p>
        {item.source === undefined ? null : (
          <dl className="content-metadata">
            <div><dt>Repository</dt><dd>{item.source.repository}</dd></div>
            <div><dt>Repository path</dt><dd>{item.source.path}</dd></div>
            {item.source.ref === undefined ? null : (
              <div><dt>Ref</dt><dd>{item.source.ref}</dd></div>
            )}
            <div><dt>Commit</dt><dd>{item.source.shortCommit}</dd></div>
          </dl>
        )}
      </>
    );
  }
  return <p className="content-item-description">{itemSummary(item)}</p>;
}

function itemSummary(item: ContentItem): string {
  if (item.kind === 'skill') return item.description ?? 'No description.';
  if (item.kind === 'instruction') {
    return item.scope === 'base' ? 'Base instructions' : `${item.harness} harness instructions`;
  }
  if (item.kind === 'mcp') return `${item.transport.toUpperCase()} transport`;
  return item.kind === 'agent' ? 'Subagent definition' : 'Slash command';
}

function itemSearchText(
  item: ContentItem,
  group: (typeof GROUPS)[number],
): string {
  const values = [item.name, item.kind, group.label, group.singular, itemSummary(item)];
  if (item.kind === 'skill') {
    values.push(
      item.source?.repository ?? '',
      item.source?.path ?? '',
      item.source?.ref ?? '',
      item.source?.shortCommit ?? '',
    );
  }
  return values.join(' ').toLowerCase();
}

function InventoryGroups({
  inventory,
  onTransfer,
}: {
  inventory: EnvironmentInventory;
  onTransfer(
    operation: TransferOperation,
    item: ContentItem,
    trigger: HTMLButtonElement,
  ): void;
}): React.JSX.Element {
  const [selectedItem, setSelectedItem] = useState<string>();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = normalizedQuery === ''
    ? inventory.items
    : inventory.items.filter((item) => {
        const group = GROUPS.find((candidate) => candidate.kind === item.kind)!;
        return itemSearchText(item, group).includes(normalizedQuery);
      });
  const filterStatus = normalizedQuery === ''
    ? `Showing all ${inventory.items.length} elements.`
    : filteredItems.length === 0
      ? `No content matches “${query.trim()}”.`
      : `Showing ${filteredItems.length} of ${inventory.items.length} elements.`;

  return (
    <>
      <div className="inventory-filter">
        <label htmlFor="environment-content-filter">Filter {inventory.name} content</label>
        <input
          aria-describedby="environment-content-filter-status"
          autoComplete="off"
          id="environment-content-filter"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Name, kind, description, source…"
          type="search"
          value={query}
        />
        <span
          aria-label="Filter results"
          aria-live="polite"
          id="environment-content-filter-status"
          role="status"
        >
          {filterStatus}
        </span>
      </div>
      <div className="content-groups">
        {GROUPS.map((group) => {
          const items = filteredItems.filter((item) => item.kind === group.kind);
          return (
            <details className="content-group" key={group.kind} open>
              <summary>
                <span>{group.label}</span>
                <span className="group-count">{items.length}</span>
              </summary>
              {items.length === 0 ? (
                <p className="content-group-empty">
                  {normalizedQuery === ''
                    ? `No ${group.label.toLowerCase()}.`
                    : `No matching ${group.label.toLowerCase()}.`}
                </p>
              ) : (
                <ul aria-label={`${group.label} in ${inventory.name}`}>
                  {items.map((item) => {
                    const key = `${item.kind}:${item.name}`;
                    const selected = selectedItem === key;
                    return (
                      <li key={key} data-revision={item.revision}>
                        <article className={selected ? 'content-item selected' : 'content-item'}>
                          <div className="content-item-heading">
                            <button
                              aria-label={`Inspect ${group.singular} ${item.name}`}
                              aria-pressed={selected}
                              className="content-item-select"
                              onClick={() => setSelectedItem(key)}
                              type="button"
                            >
                              {item.name}
                            </button>
                            <span>{group.singular}</span>
                          </div>
                          <ItemMetadata item={item} />
                          <div className="content-item-actions">
                            <button
                              aria-label={`Copy ${group.singular} ${item.name}`}
                              className="button-secondary"
                              type="button"
                              onClick={(event) => onTransfer('copy', item, event.currentTarget)}
                            >
                              Copy
                            </button>
                            <button
                              aria-label={`Move ${group.singular} ${item.name}`}
                              className="button-secondary"
                              type="button"
                              onClick={(event) => onTransfer('move', item, event.currentTarget)}
                            >
                              Move
                            </button>
                          </div>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              )}
            </details>
          );
        })}
      </div>
    </>
  );
}

export function EnvironmentView({
  environment,
  environments,
  initialInventory,
  onRefreshEnvironments,
  onTransferred,
}: {
  environment: EnvironmentSummary;
  environments: readonly EnvironmentSummary[];
  initialInventory?: EnvironmentInventory;
  onRefreshEnvironments(): void;
  onTransferred(result: ContentTransferSuccess): void;
}): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const [inventory, setInventory] = useState<InventoryState>(
    initialInventory === undefined
      ? { status: 'loading' }
      : { status: 'ready', inventory: initialInventory },
  );
  const [transferLocator, setTransferLocator] = useState<SelectedContentLocator>();
  const [transferNotice, setTransferNotice] = useState<string>();
  const [movedSourceTombstones, setMovedSourceTombstones] = useState<
    readonly MovedSourceTombstone[]
  >([]);
  const transferTriggerRef = useRef<HTMLButtonElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let acceptResponse = true;
    const controller = new AbortController();
    setInventory((current) => {
      const retained = current.status === 'ready' ||
          current.status === 'refreshing' || current.status === 'stale' ||
          current.status === 'error'
        ? current.inventory
        : undefined;
      return retained === undefined
        ? { status: 'loading' }
        : { status: 'refreshing', inventory: retained };
    });
    void getEnvironmentInventory(environment.name, controller.signal).then(
      (next) => {
        if (acceptResponse) {
          setMovedSourceTombstones((current) =>
            reconcileMovedSourceTombstones(current, next));
          setInventory({ status: 'ready', inventory: next });
        }
      },
      (error: unknown) => {
        if (!acceptResponse) return;
        if (error instanceof UiApiError && error.code === 'NOT_FOUND') {
          setInventory({ status: 'unavailable' });
        } else if (error instanceof UiApiError && error.code === 'STALE_REVISION') {
          setInventory((current) => {
            const retained = current.status === 'ready' || current.status === 'refreshing'
              ? current.inventory
              : undefined;
            return retained === undefined
              ? { status: 'stale' }
              : { status: 'stale', inventory: retained };
          });
        } else {
          setInventory((current) => {
            const retained = current.status === 'ready' ||
                current.status === 'refreshing' || current.status === 'stale'
              ? current.inventory
              : undefined;
            return retained === undefined
              ? { status: 'error' }
              : { status: 'error', inventory: retained };
          });
        }
      },
    );
    return () => {
      acceptResponse = false;
      controller.abort();
    };
  }, [environment.name, request]);

  const current = inventory.status === 'ready' ||
      inventory.status === 'refreshing' ||
      inventory.status === 'stale' ||
      inventory.status === 'error'
    ? inventory.inventory
    : undefined;
  const visibleInventory = current === undefined
    ? undefined
    : withoutMovedSources(current, movedSourceTombstones);
  const itemCount = visibleInventory?.items.length ?? 0;
  const transferItem = transferLocator !== undefined && visibleInventory !== undefined &&
      transferLocator.sourceEnvironment === visibleInventory.name
    ? visibleInventory.items.find((item) =>
        item.kind === transferLocator.kind && item.name === transferLocator.name)
    : undefined;
  useEffect(() => {
    if (transferLocator !== undefined && current !== undefined && transferItem === undefined) {
      setTransferLocator(undefined);
    }
  }, [transferItem, transferLocator, current]);
  const refreshBlocked = inventory.status === 'loading' || inventory.status === 'refreshing';
  const refreshAffected = (): void => {
    setRequest((value) => value + 1);
    onRefreshEnvironments();
  };
  const transferred = (
    result: ContentTransferSuccess,
    sourceItemRevision: Revision,
  ): void => {
    const sourceProjection = result.sourceEnvironment;
    if (sourceProjection !== undefined) {
      setMovedSourceTombstones((current) =>
        reconcileMovedSourceTombstones(current, sourceProjection));
      setInventory({ status: 'ready', inventory: sourceProjection });
    } else if (result.operation === 'move' && result.refreshRequired) {
      const tombstone: MovedSourceTombstone = {
        sourceEnvironment: result.source.environment,
        kind: result.source.kind,
        name: result.source.name,
        revision: sourceItemRevision,
      };
      setMovedSourceTombstones((current) =>
        current.some((candidate) => sameTombstone(candidate, tombstone))
          ? current
          : [...current, tombstone]);
    }
    setTransferNotice(result.operation === 'copy'
      ? result.publication === 'git-pending'
        ? `Copied ${result.source.name} to ${result.destination.environment}. Required Git bookkeeping is pending.`
        : result.refreshRequired
          ? `Copied ${result.source.name} to ${result.destination.environment}. Refresh affected content to reconcile the view.`
          : `Copied ${result.source.name} to ${result.destination.environment}.`
      : result.publication === 'git-pending'
        ? result.refreshRequired
          ? `Moved ${result.source.name} to ${result.destination.environment}. The move is complete locally and required Git bookkeeping is pending. Affected content could not be refreshed; refresh to reconcile the view. Do not repeat the move.`
          : `Moved ${result.source.name} to ${result.destination.environment}. The move is complete locally; required Git bookkeeping is pending. Do not repeat the move.`
        : result.refreshRequired
          ? `Moved ${result.source.name} to ${result.destination.environment}. The move is complete, but affected content could not be refreshed. Refresh to reconcile the view; do not repeat the move.`
          : `Moved ${result.source.name} to ${result.destination.environment} and removed it from ${result.source.environment}.`);
    onTransferred(result);
    if (result.refreshRequired) refreshAffected();
  };

  return (
    <section className="inventory-panel" aria-labelledby="environment-view-title">
      <div className="inventory-heading">
        <div>
          <p className="eyebrow">Selected environment</p>
          <h2 id="environment-view-title" ref={viewHeadingRef} tabIndex={-1}>
            {environment.name} content
          </h2>
        </div>
        {inventory.status === 'unavailable' ||
        inventory.status === 'error' ||
        inventory.status === 'stale' ? (
          <button type="button" onClick={() => setRequest((value) => value + 1)}>
            Retry {environment.name} content
          </button>
        ) : (
          <button
            aria-disabled={refreshBlocked}
            type="button"
            onClick={() => {
              if (!refreshBlocked) {
                setRequest((value) => value + 1);
              }
            }}
          >
            Refresh {environment.name} content
          </button>
        )}
      </div>

      {inventory.status === 'loading' ? (
        <div className="inventory-message" role="status" aria-busy="true">
          <span aria-hidden="true" className="status-pulse" />
          Loading {environment.name} content…
        </div>
      ) : null}
      {inventory.status === 'refreshing' ? (
        <div className="inventory-message inventory-stale" role="status" aria-busy="true">
          Showing previously loaded content while refresh completes…
        </div>
      ) : null}
      {inventory.status === 'unavailable' ? (
        <div className="inventory-message inventory-error" role="alert">
          <strong>{environment.name} is no longer available.</strong>
          <span>Return to the catalogue or retry after restoring the environment.</span>
        </div>
      ) : null}
      {inventory.status === 'stale' ? (
        <div className="inventory-message inventory-stale" role="alert">
          <strong>{environment.name} content changed before it could be loaded.</strong>
          <span>Retry to inspect the current environment revision.</span>
        </div>
      ) : null}
      {inventory.status === 'error' ? (
        <div className="inventory-message inventory-error" role="alert">
          <strong>{environment.name} content is unavailable.</strong>
          <span>The local request failed. Your environment files were not changed.</span>
        </div>
      ) : null}
      {visibleInventory !== undefined && itemCount === 0 ? (
        <div className="inventory-message inventory-empty" role="status">
          <strong>This environment has no content yet.</strong>
          <span>Add content from the CLI to see it here.</span>
        </div>
      ) : null}
      {transferNotice === undefined ? null : (
        <div className="inventory-message transfer-result" role="status">
          <span aria-hidden="true" className="status-check">✓</span>
          <strong>{transferNotice}</strong>
        </div>
      )}
      {visibleInventory === undefined ? null : (
        <InventoryGroups
          inventory={visibleInventory}
          onTransfer={(operation, item, trigger) => {
            transferTriggerRef.current = trigger;
            setTransferLocator({
              operation,
              kind: item.kind,
              name: item.name,
              sourceEnvironment: visibleInventory.name,
            });
          }}
        />
      )}
      {transferItem === undefined || transferLocator === undefined || current === undefined ? null : (
        <TransferDialog
          environments={environments}
          fallbackFocusRef={viewHeadingRef}
          item={transferItem}
          onClose={() => setTransferLocator(undefined)}
          onTransferred={transferred}
          operation={transferLocator.operation}
          onRefresh={refreshAffected}
          source={current}
          triggerRef={transferTriggerRef}
        />
      )}
    </section>
  );
}
