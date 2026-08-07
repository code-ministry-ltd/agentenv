import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type {
  CandidateSetId,
  GitCandidate,
  GitDiscoveryPhase,
} from '../../src/ui/contract.js';
import {
  discardGitCandidateSet,
  getGitCandidateSet,
  startGitCandidateDiscovery,
  UiApiError,
} from './api.js';

type BrowseState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'pending'; phase: GitDiscoveryPhase }
  | { status: 'ready'; candidates: readonly GitCandidate[] }
  | { status: 'failed'; message: string };

function safeIssue(error: unknown): string {
  if (error instanceof UiApiError && error.code === 'NOT_FOUND') {
    return 'This candidate set expired. Browse the repository again.';
  }
  if (error instanceof UiApiError && error.code === 'VALIDATION_FAILED') {
    return error.message;
  }
  return 'The Git repository could not be browsed. Check the source and try again.';
}

function phaseLabel(phase: GitDiscoveryPhase): string {
  if (phase === 'resolving') return 'Resolving the repository…';
  if (phase === 'fetching') return 'Fetching the exact Git revision…';
  return 'Scanning for valid skills…';
}

export function GitImportDialog({
  onClose,
  triggerRef,
}: {
  onClose(): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const activeSetRef = useRef<CandidateSetId | undefined>(undefined);
  const sequenceRef = useRef(0);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState('');
  const [candidateSetId, setCandidateSetId] = useState<CandidateSetId>();
  const [browse, setBrowse] = useState<BrowseState>({ status: 'idle' });

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    sourceRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      const active = activeSetRef.current;
      activeSetRef.current = undefined;
      if (active !== undefined) void discardGitCandidateSet(active).catch(() => undefined);
      triggerRef.current?.focus();
    };
  }, [triggerRef]);

  useEffect(() => {
    if (candidateSetId === undefined) return;
    let ignore = false;
    const poll = async (): Promise<void> => {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (ignore) return;
        try {
          const state = await getGitCandidateSet(candidateSetId);
          if (ignore) return;
          if (state.status === 'PENDING') {
            setBrowse({ status: 'pending', phase: state.phase });
            continue;
          }
          if (state.status === 'FAILED') {
            setBrowse({ status: 'failed', message: state.error.message });
            return;
          }
          const candidates = [...state.candidates];
          for (let page = 2; page <= state.page.totalPages; page += 1) {
            const next = await getGitCandidateSet(candidateSetId, page, state.page.pageSize);
            if (next.status !== 'READY') {
              throw new Error('Git candidate set changed while paging');
            }
            candidates.push(...next.candidates);
          }
          if (!ignore) setBrowse({ status: 'ready', candidates });
          return;
        } catch (error) {
          if (!ignore) setBrowse({ status: 'failed', message: safeIssue(error) });
          return;
        }
      }
    };
    void poll();
    return () => {
      ignore = true;
    };
  }, [candidateSetId]);

  const visible = useMemo(() => {
    if (browse.status !== 'ready') return [];
    const query = filter.trim().toLocaleLowerCase();
    if (query === '') return browse.candidates;
    return browse.candidates.filter((candidate) =>
      [candidate.name, candidate.description, candidate.repositoryPath]
        .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [browse, filter]);

  const releaseActive = (): void => {
    const active = activeSetRef.current;
    activeSetRef.current = undefined;
    setCandidateSetId(undefined);
    if (active !== undefined) void discardGitCandidateSet(active).catch(() => undefined);
  };
  const closeDialog = (): void => {
    sequenceRef.current += 1;
    releaseActive();
    dialogRef.current?.close();
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = source.trim();
    if (trimmed === '') {
      setBrowse({ status: 'failed', message: 'Enter a Git repository source.' });
      sourceRef.current?.focus();
      return;
    }
    const sequence = ++sequenceRef.current;
    const previous = activeSetRef.current;
    activeSetRef.current = undefined;
    setCandidateSetId(undefined);
    setBrowse({ status: 'starting' });
    if (previous !== undefined) {
      await discardGitCandidateSet(previous).catch(() => undefined);
    }
    try {
      const pending = await startGitCandidateDiscovery(trimmed);
      if (sequence !== sequenceRef.current) {
        void discardGitCandidateSet(pending.candidateSetId).catch(() => undefined);
        return;
      }
      activeSetRef.current = pending.candidateSetId;
      setCandidateSetId(pending.candidateSetId);
      setBrowse({ status: 'pending', phase: pending.phase });
    } catch (error) {
      if (sequence === sequenceRef.current) {
        setBrowse({ status: 'failed', message: safeIssue(error) });
      }
    }
  };

  return (
    <dialog
      aria-describedby="git-import-help"
      aria-labelledby="git-import-title"
      className="environment-dialog git-import-dialog"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
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
      <form noValidate onSubmit={(event) => void submit(event)}>
        <p className="eyebrow">Git skill import</p>
        <h2 id="git-import-title">Browse skills from Git</h2>
        <p id="git-import-help">
          Enter a repository, optional path and ref. The exact revision is fetched privately.
        </p>
        <div className="dialog-fields">
          <label htmlFor="git-skill-source">Repository source</label>
          <input
            autoComplete="off"
            id="git-skill-source"
            maxLength={4096}
            onChange={(event) => setSource(event.currentTarget.value)}
            placeholder="owner/repo[/path][@ref] or local repository path"
            ref={sourceRef}
            spellCheck={false}
            type="text"
            value={source}
          />
        </div>
        <div className="dialog-actions git-browse-actions">
          <button className="button-secondary" type="button" onClick={closeDialog}>Cancel</button>
          <button disabled={browse.status === 'starting'} type="submit">
            {browse.status === 'starting' ? 'Starting discovery…' : 'Browse repository'}
          </button>
        </div>

        {browse.status === 'pending' ? (
          <div aria-busy="true" className="dialog-status" role="status">
            <span aria-hidden="true" className="status-pulse" />
            {phaseLabel(browse.phase)}
          </div>
        ) : null}
        {browse.status === 'failed' ? (
          <div className="dialog-issue dialog-issue-failure" role="alert">
            {browse.message}
          </div>
        ) : null}
        {browse.status === 'ready' ? (
          <section className="git-candidate-browser" aria-labelledby="git-candidate-title">
            <div className="git-candidate-heading">
              <div>
                <h3 id="git-candidate-title">Discovered skills</h3>
                <p>{browse.candidates.length} valid skill{browse.candidates.length === 1 ? '' : 's'}</p>
              </div>
              <label htmlFor="git-candidate-filter">Filter skills</label>
              <input
                id="git-candidate-filter"
                onChange={(event) => setFilter(event.currentTarget.value)}
                type="search"
                value={filter}
              />
            </div>
            <p aria-live="polite" className="field-help">
              Showing {visible.length} of {browse.candidates.length} skills.
            </p>
            {visible.length === 0 ? (
              <p className="inventory-message inventory-empty">No skills match this filter.</p>
            ) : (
              <ul aria-label="Discovered Git skills" className="git-candidate-list">
                {visible.map((candidate) => (
                  <li key={candidate.candidateId}>
                    <article className="git-candidate-card">
                      <h4>{candidate.name}</h4>
                      <p>{candidate.description || 'No description.'}</p>
                      <dl>
                        <dt>Repository</dt><dd>{candidate.repository}</dd>
                        <dt>Path</dt><dd>{candidate.repositoryPath || '.'}</dd>
                        <dt>Ref</dt><dd>{candidate.ref ?? 'HEAD'}</dd>
                        <dt>Commit</dt><dd title={candidate.commit}>{candidate.shortCommit}</dd>
                      </dl>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </form>
    </dialog>
  );
}
