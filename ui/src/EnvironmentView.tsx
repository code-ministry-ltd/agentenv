import { useEffect, useState } from 'react';
import type {
  ContentItem,
  ContentKind,
  EnvironmentInventory,
  EnvironmentSummary,
} from '../../src/ui/contract.js';
import { getEnvironmentInventory, UiApiError } from './api.js';

type InventoryState =
  | { status: 'loading' }
  | { status: 'ready'; inventory: EnvironmentInventory }
  | { status: 'refreshing'; inventory: EnvironmentInventory }
  | { status: 'stale'; inventory?: EnvironmentInventory }
  | { status: 'unavailable' }
  | { status: 'error' };

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

function InventoryGroups({ inventory }: { inventory: EnvironmentInventory }): React.JSX.Element {
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
}: {
  environment: EnvironmentSummary;
}): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const [inventory, setInventory] = useState<InventoryState>({ status: 'loading' });

  useEffect(() => {
    let acceptResponse = true;
    const controller = new AbortController();
    setInventory((current) =>
      current.status === 'ready' || current.status === 'refreshing'
        ? { status: 'refreshing', inventory: current.inventory }
        : { status: 'loading' },
    );
    void getEnvironmentInventory(environment.name, controller.signal).then(
      (next) => {
        if (acceptResponse) setInventory({ status: 'ready', inventory: next });
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
          setInventory({ status: 'error' });
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
      inventory.status === 'stale'
    ? inventory.inventory
    : undefined;
  const itemCount = current?.items.length ?? 0;
  const refreshBlocked = inventory.status === 'loading' || inventory.status === 'refreshing';

  return (
    <section className="inventory-panel" aria-labelledby="environment-view-title">
      <div className="inventory-heading">
        <div>
          <p className="eyebrow">Selected environment</p>
          <h2 id="environment-view-title">{environment.name} content</h2>
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
      {current !== undefined && itemCount === 0 ? (
        <div className="inventory-message inventory-empty" role="status">
          <strong>This environment has no content yet.</strong>
          <span>Add content from the CLI to see it here.</span>
        </div>
      ) : null}
      {current === undefined ? null : <InventoryGroups inventory={current} />}
    </section>
  );
}
