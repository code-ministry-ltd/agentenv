import { useCallback, useEffect, useState } from 'react';
import { initializeSession, UiApiError } from './api.js';
import { EnvironmentList } from './EnvironmentList.js';
import './styles.css';

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

function safeConnectionMessage(error: unknown): string {
  if (error instanceof UiApiError && error.code === 'UNAUTHENTICATED') {
    return 'This launch link is no longer valid.';
  }
  return 'The local UI could not establish a secure session.';
}

export function App(): React.JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>({ status: 'connecting' });

  const connect = useCallback(async () => {
    setConnection({ status: 'connecting' });
    try {
      await initializeSession();
      document.documentElement.dataset.session = 'ready';
      setConnection({ status: 'ready' });
    } catch (error) {
      document.documentElement.dataset.session = 'error';
      setConnection({ status: 'error', message: safeConnectionMessage(error) });
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="agentenv home">
          <span aria-hidden="true" className="wordmark-mark">ae</span>
          <span>agentenv</span>
        </a>
        <span className="local-badge">
          <span aria-hidden="true" className="local-badge-dot" />
          Local only
        </span>
      </header>

      <main className="connection-workspace">
        <section className="connection-panel" aria-labelledby="page-title">
          <p className="eyebrow">Environment workspace</p>
          <h1 id="page-title">Your agent environments</h1>

          {connection.status === 'connecting' ? (
            <div className="session-state" role="status" aria-busy="true">
              <span aria-hidden="true" className="status-pulse" />
              Establishing a secure local session…
            </div>
          ) : null}

          {connection.status === 'ready' ? (
            <>
              <div className="session-state session-state-ready" role="status">
                <span aria-hidden="true" className="status-check">✓</span>
                <span>
                  <strong>Secure local session established.</strong>
                  Your environment data stays on this computer.
                </span>
              </div>
              <EnvironmentList />
            </>
          ) : null}

          {connection.status === 'error' ? (
            <div className="session-state session-state-error" role="alert">
              <span aria-hidden="true" className="status-error">!</span>
              <span>
                <strong>{connection.message}</strong>
                Close this tab and run <code>agentenv ui</code> to create a new link.
              </span>
              <button type="button" onClick={() => void connect()}>Retry session</button>
            </div>
          ) : null}
        </section>
      </main>

      <footer className="footer-note">Bound to 127.0.0.1 · not available over the network</footer>
    </div>
  );
}
