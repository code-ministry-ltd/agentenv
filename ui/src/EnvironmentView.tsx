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
        <p className="content-item-description">{item.description ?? 'No description.'}</p>
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
  if (item.kind === 'instruction') {
    return (
      <p className="content-item-description">
        {item.scope === 'base' ? 'Base instructions' : `${item.harness} harness instructions`}
      </p>
    );
  }
  if (item.kind === 'mcp') {
    return <p className="content-item-description">{item.transport.toUpperCase()} transport</p>;
  }
  return (
    <p className="content-item-description">
      {item.kind === 'agent' ? 'Subagent definition' : 'Slash command'}
    </p>
  );
}

function InventoryGroups({ inventory }: { inventory: EnvironmentInventory }): React.JSX.Element {
  const [selectedItem, setSelectedItem] = useState<string>();
  return (
    <div className="content-groups">
      {GROUPS.map((group) => {
        const items = inventory.items.filter((item) => item.kind === group.kind);
        return (
          <details className="content-group" key={group.kind} open>
            <summary>
              <span>{group.label}</span>
              <span className="group-count">{items.length}</span>
            </summary>
            {items.length === 0 ? (
              <p className="content-group-empty">No {group.label.toLowerCase()}.</p>
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
    setInventory((current) =>
      current.status === 'ready' || current.status === 'refreshing'
        ? { status: 'refreshing', inventory: current.inventory }
        : { status: 'loading' },
    );
    void getEnvironmentInventory(environment.name).then(
      (next) => setInventory({ status: 'ready', inventory: next }),
      (error: unknown) => {
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
  }, [environment.name, request]);

  const current = inventory.status === 'ready' ||
      inventory.status === 'refreshing' ||
      inventory.status === 'stale'
    ? inventory.inventory
    : undefined;
  const itemCount = current?.items.length ?? 0;

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
            type="button"
            disabled={inventory.status === 'loading' || inventory.status === 'refreshing'}
            onClick={() => setRequest((value) => value + 1)}
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
        <div className="inventory-message inventory-empty">
          <strong>This environment has no content yet.</strong>
          <span>Add content from the CLI to see it here.</span>
        </div>
      ) : null}
      {current === undefined ? null : <InventoryGroups inventory={current} />}
    </section>
  );
}
