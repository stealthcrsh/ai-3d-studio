import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { bootStudio, onStudioEvent, type Health } from './api.ts';
import { Library } from './screens/Library.tsx';
import { ProjectScreen } from './screens/ProjectScreen.tsx';

export interface LiveEvent {
  type: string;
  [k: string]: unknown;
}

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
export const onLiveEvent = (l: Listener) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function parseRoute() {
  const m = window.location.hash.match(/^#\/p\/([\w]+)(?:\/(\w+))?/);
  return m ? { project: m[1], tab: m[2] ?? null } : { project: null, tab: null };
}

export const navigate = (hash: string) => {
  window.location.hash = hash;
};

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page">
        <div className="notice bad" role="alert">
          <h2>The studio hit an unexpected error</h2>
          <p>Your projects are saved on disk and were not affected. {this.state.error.message}</p>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => window.location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}

export function App() {
  const [route, setRoute] = useState(parseRoute);
  const [health, setHealth] = useState<Health | null>(null);
  const [lockedOut, setLockedOut] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    const start = async () => {
      try {
        const h = await bootStudio();
        unsub = onStudioEvent((event) => {
          for (const l of listeners) l(event as LiveEvent);
        });
        setHealth(h);
      } catch (e) {
        setBootError((e as Error).message);
      }
    };
    // Only one tab runs jobs at a time. A second tab waits, so the two cannot overwrite each other's work.
    if (navigator.locks) {
      void navigator.locks.request('ai-3d-studio-engine', { ifAvailable: true }, (lock) => {
        if (!lock) {
          setLockedOut(true);
          return undefined;
        }
        void start();
        return new Promise<void>(() => undefined);
      }).catch(() => void start());
    } else void start();
    return () => unsub?.();
  }, []);

  if (lockedOut) {
    return <main className="page"><div className="notice" role="alert"><h2>The studio is open in another tab</h2><p>Only one tab can work on your projects at a time, so nothing gets overwritten. Close the other tab, then reload this one.</p></div></main>;
  }
  if (bootError) {
    return <main className="page"><div className="notice bad" role="alert"><h2>The studio could not start</h2><p>{bootError}</p></div></main>;
  }
  if (!health) return <main className="page"><p className="muted">Starting the studio…</p></main>;
  return (
    <>
      {!health.webgl && <div className="notice bad" role="alert" style={{ margin: 12 }}>This browser cannot show 3D because WebGL 2 is unavailable. Projects can still be managed, but the viewport will not work.</div>}
      {!health.storage.durable && <div className="notice" role="alert" style={{ margin: 12 }}>This browser is blocking storage, perhaps because of a private window. You can work, but everything is lost when this tab closes.</div>}
      <ErrorBoundary>{route.project ? <ProjectScreen key={route.project} id={route.project} tab={route.tab} health={health} /> : <Library health={health} />}</ErrorBoundary>
    </>
  );
}
