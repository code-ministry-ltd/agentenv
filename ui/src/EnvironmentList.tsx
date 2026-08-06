import { useEffect, useState } from 'react';
import type { ContentCounts, EnvironmentSummary } from '../../src/ui/contract.js';
import { listEnvironmentSummaries } from './api.js';

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly EnvironmentSummary[] }
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

  useEffect(() => {
    let ignore = false;
    setCatalog({ status: 'loading' });

    async function load(): Promise<void> {
      try {
        const items = await listEnvironmentSummaries();
        if (!ignore) setCatalog({ status: 'ready', items });
      } catch {
        if (!ignore) setCatalog({ status: 'error' });
      }
    }

    void load();
    return () => {
      ignore = true;
    };
  }, [request]);

  return (
    <section className="catalog-panel" aria-labelledby="environment-list-title">
      <div className="catalog-heading">
        <div>
          <p className="eyebrow">Local catalogue</p>
          <h2 id="environment-list-title">Environments</h2>
        </div>
        {catalog.status === 'ready' && catalog.items.length > 0 ? (
          <span className="catalog-total">{countLabel(catalog.items.length, 'environment')}</span>
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
          <button type="button" onClick={() => setRequest((current) => current + 1)}>
            Retry environments
          </button>
        </div>
      ) : null}

      {catalog.status === 'ready' && catalog.items.length === 0 ? (
        <div className="catalog-message catalog-empty">
          <div>
            <strong>No environments yet.</strong>
            <span>Create one from the CLI to see it here.</span>
          </div>
        </div>
      ) : null}

      {catalog.status === 'ready' && catalog.items.length > 0 ? (
        <ul className="environment-list" aria-label="Environments">
          {catalog.items.map((environment) => (
            <li key={environment.name} data-revision={environment.revision}>
              <article className="environment-card">
                <div className="environment-card-heading">
                  <h3>{environment.name}</h3>
                  <span className={environment.active ? 'activity active' : 'activity'}>
                    <span aria-hidden="true" className="activity-dot" />
                    {environment.active ? 'Active' : 'Inactive'}
                  </span>
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
          ))}
        </ul>
      ) : null}
    </section>
  );
}
