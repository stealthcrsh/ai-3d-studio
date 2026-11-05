import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, type Health, type Job, type ProjectFull, type Version } from '../api.ts';
import { navigate, onLiveEvent } from '../App.tsx';
import { Viewport, type CameraView, type SceneMeta, type ViewMode } from '../viewport.ts';
import { ImportScreen, SetupScreen } from './Intake.tsx';
import { ExportPanel, GarmentPanel, MotionPanel, ReviewPanel, StudioPanel, Timeline, type PanelCtx } from './Panels.tsx';

const TABS = [
  ['import', 'Import', 'S02'],
  ['setup', 'Setup', 'S03'],
  ['studio', 'Studio', 'S04'],
  ['garment', 'Garment', 'S05'],
  ['motion', 'Motion', 'S06'],
  ['review', 'Review', 'S07'],
  ['export', 'Export', 'S08'],
] as const;

const VIEW_MODES: [ViewMode, string][] = [['material', 'Material'], ['clay', 'Clay'], ['wire', 'Wire'], ['parts', 'Parts'], ['stretch', 'Stretch'], ['collision', 'Contact']];
const CAMERAS: [CameraView, string, string][] = [['front', 'Front', '1'], ['back', 'Back', '2'], ['left', 'Left', '3'], ['right', 'Right', '4'], ['reset', 'Reset', 'R']];

export function ProjectScreen({ id, tab, health }: { id: string; tab: string | null; health: Health | null }) {
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [missing, setMissing] = useState(false);
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const reload = useCallback(() => {
    api.get(id).then(setProject).catch((e) => {
      if (/not found/i.test(e.message)) setMissing(true);
    });
  }, [id]);
  useEffect(() => {
    reload();
    return onLiveEvent((e) => {
      if (e.type === 'job') {
        const j = e.job as Job;
        if (j.projectId !== id) return;
        setLiveJob(j);
        if (j.status !== 'running' || !j.progress) reload();
      }
      if (e.type === 'project' && e.projectId === id) reload();
    });
  }, [id, reload]);

  if (missing) {
    return <main className="page"><div className="notice bad">This project no longer exists. <a href="#/">Back to the library</a></div></main>;
  }
  if (!project) return <main className="page"><p className="muted">Loading project…</p></main>;
  const current = tab ?? (project.versions.length ? 'studio' : 'import');
  const hasVersion = project.versions.length > 0;
  const version = project.versions.find((v) => v.id === project.currentVersionId) ?? null;
  const job = (liveJob && project.jobs.some((j) => j.id === liveJob.id) ? liveJob : null) ?? project.jobs[0] ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate('#/')} aria-label="Back to library"><span className="brand-mark" aria-hidden /><span>Studio</span></button>
        <span className="dim">/</span>
        <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
        <nav className="tabs" aria-label="Project steps">
          {TABS.map(([k, label, sid]) => {
            const needsVersion = !['import', 'setup'].includes(k);
            return <button key={k} className="tab" data-screen-id={sid} aria-current={current === k ? 'page' : undefined} disabled={needsVersion && !hasVersion} onClick={() => navigate(`#/p/${id}/${k}`)}>{label}</button>;
          })}
        </nav>
        <div className="grow" />
        {version && (
          <>
            <span className="mono dim">v{version.n}</span>
            <span className={`badge ${version.tier}`} data-testid="tier">{version.tier.toUpperCase()}</span>
            <span className="badge baseline" title="Parametric template fitted to your image, then simulated. Not AI reconstruction.">{version.label}</span>
          </>
        )}
      </header>
      {current === 'import' && <div style={{ overflow: 'auto' }}><ImportScreen project={project} reload={reload} health={health} /></div>}
      {current === 'setup' && <div style={{ overflow: 'auto' }}><SetupScreen project={project} reload={reload} health={health} /></div>}
      {!['import', 'setup'].includes(current) && <Workspace project={project} version={version} tab={current} job={job} reload={reload} health={health} />}
    </div>
  );
}

function Workspace({ project, version, tab, job, reload, health }: { project: ProjectFull; version: Version | null; tab: string; job: Job | null; reload: () => void; health: Health | null }) {
  const host = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport | null>(null);
  const [mode, setMode] = useState<ViewMode>('material');
  const [scene, setScene] = useState<SceneMeta | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [avatarOn, setAvatarOn] = useState(true);
  const [fps, setFps] = useState(0);
  const [clip, setClip] = useState<string | null>(null);
  const [motionState, setMotionState] = useState({ playing: false, time: 0, frame: 0, duration: 0, frames: 0, speed: 1, loading: false });
  const [seamFocus, setSeamFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const vp = new Viewport(host.current);
    vp.onSelect = setSelected;
    vp.onFrameRate = setFps;
    vp.onTime = (time, frame) => setMotionState((m) => (m.frame === frame && Math.abs(m.time - time) < 0.03 ? m : { ...m, time, frame }));
    vpRef.current = vp;
    (window as unknown as { __viewport: Viewport }).__viewport = vp;
    return () => vp.dispose();
  }, []);

  const artifact = version?.artifacts.model ?? version?.artifacts.draft ?? null;
  const sceneFile = version?.artifacts.model ? version.artifacts.scene : version?.artifacts.draftScene;
  const key = version && artifact ? `${version.id}:${artifact}` : null;
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp || !key || key === loadedKey || !artifact || !sceneFile) return;
    let stop = false;
    setLoading(version?.artifacts.model ? 'Loading refined asset' : 'Loading draft mesh');
    setLoadError(null);
    (async () => {
      try {
        const meta = await (await fetch(fileUrl(project.id, sceneFile))).json();
        if (stop) return;
        const heat = version?.artifacts.heat ? fileUrl(project.id, version.artifacts.heat) : undefined;
        const applied = await vp.loadModel(fileUrl(project.id, artifact), meta, heat);
        if (stop || !applied) return;
        setScene(meta);
        setLoadedKey(key);
        setClip(null);
        setMotionState((m) => ({ ...m, playing: false, time: 0, frame: 0, duration: 0, frames: 0 }));
        vp.setMode(mode);
        vp.setHidden(hidden);
        vp.setIsolated(isolated);
        vp.setAvatarVisible(avatarOn);
      } catch (e) {
        setLoadError(`The 3D file could not be loaded. ${(e as Error).message}`);
      } finally {
        if (!stop) setLoading(null);
      }
    })();
    return () => {
      stop = true;
    };
    // Only a new artifact should reload the model. View state is applied after loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, project.id]);

  useEffect(() => {
    vpRef.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    vpRef.current?.setHidden(hidden);
  }, [hidden]);
  useEffect(() => {
    vpRef.current?.setIsolated(isolated);
  }, [isolated]);
  useEffect(() => {
    vpRef.current?.setAvatarVisible(avatarOn);
  }, [avatarOn]);
  useEffect(() => {
    vpRef.current?.select(selected);
  }, [selected]);
  useEffect(() => {
    vpRef.current?.showSeams(tab === 'garment' && scene ? scene.seams : null, seamFocus);
  }, [tab, scene, seamFocus]);

  // Motion playback is available wherever the motion tab asks for it, and stops when leaving.
  const selectClip = useCallback(async (next: string | null) => {
    const vp = vpRef.current;
    if (!vp || !version) return;
    if (!next) {
      vp.clearMotion();
      setClip(null);
      setMotionState((m) => ({ ...m, playing: false, duration: 0, frames: 0, time: 0, frame: 0 }));
      return;
    }
    const dir = version.artifacts.motion?.[next];
    if (!dir) return;
    setMotionState((m) => ({ ...m, loading: true }));
    const meta = await vp.loadMotion(next, fileUrl(project.id, `${dir}/meta.json`), fileUrl(project.id, `${dir}/frames.bin`));
    setClip(next);
    setMotionState((m) => ({ ...m, loading: false, duration: meta.frames / meta.fps, frames: meta.frames, time: 0, frame: 0 }));
  }, [project.id, version]);

  const togglePlay = useCallback(() => {
    const vp = vpRef.current;
    if (!vp?.motion) return;
    vp.playing = !vp.playing;
    setMotionState((m) => ({ ...m, playing: vp.playing }));
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName) && !(t as HTMLInputElement).type?.includes('range')) return;
      if (e.key === ' ' && tab === 'motion') {
        e.preventDefault();
        togglePlay();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && version?.parentId) {
        e.preventDefault();
        void api.restore(project.id, version.parentId).then(reload);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [project.id, reload, tab, togglePlay, version?.parentId]);

  const running = job && (job.status === 'running' || job.status === 'queued');
  const ctx: PanelCtx = useMemo(() => ({
    project, version, scene, job, reload, health, viewport: vpRef, selected, setSelected,
    clip, selectClip, motionState, setMotionState, togglePlay, seamFocus, setSeamFocus, setMode, running: Boolean(running),
  }), [project, version, scene, job, reload, health, selected, clip, selectClip, motionState, togglePlay, seamFocus, running]);

  const parts = scene?.parts ?? [];

  return (
    <div className="work">
      <aside className="side left" aria-label="Model tree">
        <div className="section">
          <div className="row between"><h3>Model</h3>{isolated && <button className="btn sm ghost" onClick={() => setIsolated(null)}>Show all</button>}</div>
          {!parts.length && <p className="dim">No parts yet.</p>}
          <ul className="tree">
            {parts.map((p) => (
              <li key={p.id} className={`${selected === p.id ? 'sel' : ''} ${hidden.has(p.id) ? 'off' : ''}`}>
                <button className="name" aria-pressed={selected === p.id} onClick={() => setSelected(selected === p.id ? null : p.id)} title={p.simulated ? 'Simulated cloth' : 'Follows the front panel'}>{p.label}</button>
                <button className="icon-btn" aria-label={`Isolate ${p.label}`} aria-pressed={isolated === p.id} title="Isolate" onClick={() => setIsolated(isolated === p.id ? null : p.id)}>◎</button>
                <button className="icon-btn" aria-label={`${hidden.has(p.id) ? 'Show' : 'Hide'} ${p.label}`} aria-pressed={!hidden.has(p.id)} title="Show or hide" onClick={() => { const n = new Set(hidden); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); setHidden(n); }}>{hidden.has(p.id) ? '○' : '●'}</button>
              </li>
            ))}
            {parts.length > 0 && (
              <li className={avatarOn ? '' : 'off'}>
                <span className="name" style={{ cursor: 'default' }}>Avatar</span>
                <button className="icon-btn" aria-label={`${avatarOn ? 'Hide' : 'Show'} avatar`} aria-pressed={avatarOn} onClick={() => setAvatarOn(!avatarOn)}>{avatarOn ? '●' : '○'}</button>
              </li>
            )}
          </ul>
        </div>
        {scene && (
          <div className="section">
            <h3>Mesh</h3>
            <dl className="kv">
              <dt>Showing</dt><dd>{scene.tier}</dd>
              <dt>Cloth vertices</dt><dd>{scene.simVertices.toLocaleString()}</dd>
              <dt>Triangles</dt><dd>{scene.simTriangles.toLocaleString()}</dd>
              <dt>Mass estimate</dt><dd>{scene.massKg.toFixed(2)} kg</dd>
              <dt>Viewport</dt><dd data-testid="fps">{fps ? `${fps.toFixed(0)} fps` : '…'}</dd>
            </dl>
          </div>
        )}
        <div className="section">
          <h3>Keys</h3>
          <p className="dim">Click the viewport first. Arrows orbit, + and − zoom, 1 to 4 pick a view, R resets, Esc clears selection. Space plays in Motion. ⌘Z goes back a version.</p>
        </div>
      </aside>
      <section className="stage-area" aria-label="3D viewport">
        <div className="gl-host" ref={host}>
          <div className="overlay-tl">
            <div className="seg" role="group" aria-label="Display mode">
              {VIEW_MODES.map(([m, label]) => <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{label}</button>)}
            </div>
            <div className="seg" role="group" aria-label="Camera">
              {CAMERAS.map(([c, label, k]) => <button key={c} title={`Key ${k}`} onClick={() => vpRef.current?.setCamera(c)}>{label}</button>)}
            </div>
            {(mode === 'stretch' || mode === 'collision') && (
              <div className="glass mono" style={{ fontSize: 11 }}>{mode === 'stretch' ? 'Blue 0% stretch, red 30% or more' : 'Blue clear of the body, red 6 mm or more inside'}. Measured on the static drape.</div>
            )}
          </div>
          {loading && <div className="overlay-tr"><div className="glass">{loading}…</div></div>}
          {!artifact && !running && !loading && (
            <div className="viewport-empty"><div><h2>No mesh for this version</h2><p>{job?.status === 'failed' ? 'The run failed before a mesh was ready. See the status panel.' : 'Run generation to create one.'}</p></div></div>
          )}
          {!artifact && running && <div className="viewport-empty"><div><h2>Building the first mesh</h2><p>It appears here as soon as it exists.</p></div></div>}
          {loadError && <div className="overlay-bl"><div className="notice bad" role="alert">{loadError}</div></div>}
        </div>
        {tab === 'motion' && <Timeline ctx={ctx} />}
      </section>
      <aside className="side right" aria-label="Inspector">
        {tab === 'studio' && <StudioPanel ctx={ctx} />}
        {tab === 'garment' && <GarmentPanel ctx={ctx} />}
        {tab === 'motion' && <MotionPanel ctx={ctx} />}
        {tab === 'review' && <ReviewPanel ctx={ctx} />}
        {tab === 'export' && <ExportPanel ctx={ctx} />}
      </aside>
    </div>
  );
}
