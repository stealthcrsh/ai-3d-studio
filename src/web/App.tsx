import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Health } from './api.ts';
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
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);

  const refreshHealth = useCallback(() => {
    api.health().then((h) => {
      setHealth(h);
      setOnline(true);
    }).catch(() => setOnline(false));
  }, []);

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    refreshHealth();
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      setOnline(true);
      const event = JSON.parse(m.data) as LiveEvent;
      for (const l of listeners) l(event);
    };
    es.onerror = () => setOnline(false);
    es.onopen = () => {
      setOnline(true);
      refreshHealth();
    };
    return () => es.close();
  }, [refreshHealth]);

  return (
    <>
      <ErrorBoundary>{route.project ? <ProjectScreen key={route.project} id={route.project} tab={route.tab} health={health} /> : <Library health={health} />}</ErrorBoundary>
      {!online && <div className="offline" role="alert">The studio server is not responding. Your saved work is safe on disk. Reconnecting…</div>}
    </>
  );
}
