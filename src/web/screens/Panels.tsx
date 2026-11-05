import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { api, bytes, cm, files, useFileUrl, type EditProposal, type ExportFormat, type Health, type HoodieParams, type Job, type ProjectFull, type Version } from '../api.ts';
import type { SceneMeta, ViewMode, Viewport } from '../viewport.ts';
import type { QaReport } from '../../core/qa.ts';

export interface MotionState {
  playing: boolean;
  time: number;
  frame: number;
  duration: number;
  frames: number;
  speed: number;
  loading: boolean;
}

export interface PanelCtx {
  project: ProjectFull;
  version: Version | null;
  scene: SceneMeta | null;
  job: Job | null;
  reload: () => void;
  health: Health;
  viewport: MutableRefObject<Viewport | null>;
  selected: string | null;
  setSelected: (p: string | null) => void;
  clip: string | null;
  selectClip: (c: string | null) => Promise<void>;
  motionState: MotionState;
  setMotionState: Dispatch<SetStateAction<MotionState>>;
  togglePlay: () => void;
  seamFocus: string | null;
  setSeamFocus: (s: string | null) => void;
  setMode: (m: ViewMode) => void;
  running: boolean;
}

const ms = (v?: number) => (v === undefined ? '' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

function Elapsed({ from }: { from: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="mono dim">{Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000))} s</span>;
}

export function JobStatus({ ctx }: { ctx: PanelCtx }) {
  const { job, project, reload } = ctx;
  if (!job) return null;
  const active = job.status === 'running' || job.status === 'queued';
  const KIND: Record<string, string> = { generate: 'Generation', edit: 'Edit rebuild', motion: 'Motion bake', export: 'Export' };
  return (
    <div className="section" data-testid="job-status">
      <div className="row between">
        <h3>{KIND[job.kind]}</h3>
        <span className="row">{active && <Elapsed from={job.createdAt} />}<span className={`badge ${job.status === 'completed' ? 'pass' : job.status === 'failed' ? 'fail' : job.status === 'running' ? 'draft' : 'none'}`}>{job.status.toUpperCase()}</span></span>
      </div>
      <ol className="stages">
        {job.stages.map((s) => (
          <li key={s.name} className={s.status}>
            <span className="dot" aria-hidden />
            <span>{s.label}{s.status === 'running' && job.progress ? <span className="mono dim"> · {job.progress.phase}, frame {job.progress.frame} of {job.progress.total}</span> : null}{s.status === 'cached' ? <span className="dim"> · reused</span> : null}{s.status === 'skipped' ? <span className="dim"> · skipped</span> : null}</span>
            <span className="mono">{ms(s.ms)}</span>
          </li>
        ))}
      </ol>
      {job.error && <div className="notice bad" role="alert">{job.error}</div>}
      {job.status === 'interrupted' && <div className="notice">The server stopped while this ran. Finished stages are saved, so resuming only does what is left.</div>}
      <div className="row">
        {active && <button className="btn sm" onClick={() => void api.cancelJob(project.id, job.id).then(reload)}>Cancel</button>}
        {['failed', 'cancelled', 'interrupted'].includes(job.status) && <button className="btn sm primary" onClick={() => void api.retryJob(project.id, job.id).then(reload)}>{job.status === 'interrupted' ? 'Resume' : 'Retry'}</button>}
      </div>
    </div>
  );
}

function PartProps({ ctx }: { ctx: PanelCtx }) {
  const { scene, selected, version } = ctx;
  const part = scene?.parts.find((p) => p.id === selected);
  if (!part) return <div className="section"><h3>Selection</h3><p className="dim">Click a part in the viewport or the model list.</p></div>;
  const source = scene?.textureSources?.sources[part.id];
  const sourceText: Record<string, string> = { 'reference-front': 'Projected from the front image', 'reference-back': 'Projected from the back image', 'inferred-colour': 'Inferred, colour only' };
  const pat = scene?.pattern.find((p) => p.part === part.id);
  return (
    <div className="section" data-testid="selection">
      <h3>Selection</h3>
      <h2>{part.label}</h2>
      <dl className="kv">
        <dt>Object name</dt><dd>{part.id}</dd>
        <dt>Vertices</dt><dd>{part.vertexCount.toLocaleString()}</dd>
        <dt>Triangles</dt><dd>{part.triangles.toLocaleString()}</dd>
        <dt>Physics</dt><dd>{part.simulated ? 'Simulated cloth' : 'Follows front panel'}</dd>
        {pat && <><dt>Flat size</dt><dd>{cm(pat.width)} × {cm(pat.height)}</dd></>}
        {source && <><dt>Surface colour</dt><dd style={{ whiteSpace: 'normal' }}>{sourceText[source]}</dd></>}
        <dt>Material</dt><dd>{part.material}</dd>
      </dl>
      {version && !source && <p className="dim">Draft colour only. Textures arrive with the refined asset.</p>}
    </div>
  );
}

function EditChat({ ctx }: { ctx: PanelCtx }) {
  const { project, version, reload, health } = ctx;
  const [text, setText] = useState('');
  const [log, setLog] = useState<{ who: 'me' | 'tool'; text: string; proposal?: EditProposal; state?: 'open' | 'applied' | 'dismissed' }[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [log]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const proposal = await api.previewEdit(project.id, { text: t });
    setLog((l) => [...l, { who: 'me', text: t }, { who: 'tool', text: proposal.ok ? proposal.understood : proposal.refusal ?? 'Nothing was changed.', proposal, state: proposal.ok ? 'open' : undefined }]);
  };
  const apply = async (i: number, p: EditProposal) => {
    try {
      await api.applyEdit(project.id, { patch: p.patch, source: 'chat', summary: p.understood });
      setLog((l) => l.map((x, n) => (n === i ? { ...x, state: 'applied' } : x)));
      reload();
    } catch (e) {
      setLog((l) => [...l, { who: 'tool', text: (e as Error).message }]);
    }
  };
  return (
    <div className="section" data-testid="edit-chat">
      <div className="row between"><h3>Edit by command</h3><span className="badge none" title={health?.editInterpreter.note}>RULES, NO AI MODEL</span></div>
      {log.length === 0 && <p className="dim">Say what to change. You will see which parts it touches before anything is applied. Try "make the sleeves 3 cm shorter" or "change the colour to navy".</p>}
      <div className="chat" aria-live="polite">
        {log.map((m, i) => (
          <div key={i} className={`bubble ${m.who === 'me' ? 'me' : ''}`}>
            <div>{m.text}</div>
            {m.proposal?.ok && (
              <div className="stack" style={{ marginTop: 6 }}>
                <div className="part-chips" aria-label="Parts this changes">{m.proposal.affectedParts.map((p) => <span key={p} className="chip hot">{health?.catalog.partLabels[p] ?? p}</span>)}</div>
                <div className="dim">{m.proposal.unchangedParts.length} other parts keep their pattern shape.</div>
                {m.proposal.warnings.map((w) => <div key={w} className="dim">{w}</div>)}
                {m.state === 'open' && (
                  <div className="row">
                    <button className="btn sm primary" disabled={ctx.running || !version} onClick={() => apply(i, m.proposal!)}>Apply</button>
                    <button className="btn sm ghost" onClick={() => setLog((l) => l.map((x, n) => (n === i ? { ...x, state: 'dismissed' } : x)))}>Dismiss</button>
                  </div>
                )}
                {m.state === 'applied' && <span className="badge pass">APPLIED AS A NEW VERSION</span>}
                {m.state === 'dismissed' && <span className="dim">Dismissed. Nothing changed.</span>}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input type="text" aria-label="Edit command" placeholder="Make the sleeves 3 cm shorter" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn" type="submit">Preview</button>
      </form>
    </div>
  );
}

function StoredFigure({ pid, rel, alt, caption }: { pid: string; rel: string; alt: string; caption: string }) {
  const url = useFileUrl(pid, rel);
  return <figure>{url && <img src={url} alt={alt} />}<figcaption>{caption}</figcaption></figure>;
}

function References({ ctx }: { ctx: PanelCtx }) {
  const refs = ctx.project.references.filter((r) => r.kind === 'png' || r.kind === 'jpeg');
  return (
    <div className="section">
      <div className="row between"><h3>References</h3><a href={`#/p/${ctx.project.id}/import`} className="dim">Manage</a></div>
      {refs.length === 0 && <p className="dim">None. This version comes from the template alone.</p>}
      <div className="compare">
        {refs.map((r) => (
          <StoredFigure key={r.id} pid={ctx.project.id} rel={r.file} alt={`${r.view} reference`} caption={`${r.view}${r.usage === 'stored-not-used' ? ', not used' : ''}`} />
        ))}
      </div>
      {refs.length > 0 && <div className="row"><button className="btn sm" onClick={() => ctx.viewport.current?.setCamera('front')}>Match front</button><button className="btn sm" onClick={() => ctx.viewport.current?.setCamera('back')}>Match back</button></div>}
    </div>
  );
}

function History({ ctx }: { ctx: PanelCtx }) {
  const { project, version, reload } = ctx;
  const list = [...project.versions].reverse();
  return (
    <div className="section" data-testid="history">
      <h3>History</h3>
      {list.map((v) => (
        <div key={v.id} className="row between">
          <div className="grow">
            <div><span className="mono dim">v{v.n}</span> {v.summary}</div>
            <div className="row wrap"><span className={`badge ${v.tier}`}>{v.tier.toUpperCase()}</span>{v.approved && <span className="badge pass">APPROVED</span>}</div>
          </div>
          {v.id === version?.id ? <span className="dim">Current</span> : <button className="btn sm" disabled={ctx.running} onClick={() => void api.restore(project.id, v.id).then(reload)}>Restore</button>}
        </div>
      ))}
    </div>
  );
}

export function StudioPanel({ ctx }: { ctx: PanelCtx }) {
  return (
    <div data-screen="S04">
      <JobStatus ctx={ctx} />
      {ctx.version?.warnings.length ? (
        <div className="section">
          <h3>What to know about this result</h3>
          {ctx.version.warnings.map((w) => <div className="notice" key={w}>{w}</div>)}
        </div>
      ) : null}
      <PartProps ctx={ctx} />
      <EditChat ctx={ctx} />
      <References ctx={ctx} />
      <History ctx={ctx} />
    </div>
  );
}

const DIMS = ['bodyWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength', 'sleeveWidth', 'cuffWidth', 'cuffHeight', 'hemWidth', 'hemHeight', 'hoodHeight', 'hoodDepth', 'pocketWidth', 'pocketHeight'] as const;

function PatternView({ scene, selected }: { scene: SceneMeta; selected: string | null }) {
  const layout = useMemo(() => {
    let x = 0;
    let y = 0;
    let rowH = 0;
    const W = 2.2;
    return scene.pattern.map((p) => {
      if (x + p.width > W) {
        x = 0;
        y += rowH + 0.06;
        rowH = 0;
      }
      const item = { ...p, ox: x + p.width / 2, oy: y };
      x += p.width + 0.06;
      rowH = Math.max(rowH, p.height);
      return item;
    });
  }, [scene]);
  const maxY = Math.max(...layout.map((p) => p.oy + p.height));
  return (
    <svg className="pattern-svg" viewBox={`-0.03 -0.03 2.26 ${maxY + 0.06}`} role="img" aria-label="Flat pattern pieces">
      {layout.map((p) => (
        <g key={p.part} transform={`translate(${p.ox} ${maxY - p.oy}) scale(1 -1)`}>
          <polygon points={p.outline.map(([a, b]) => `${a},${b}`).join(' ')} fill={selected === p.part ? '#e9b44c' : '#3a3b34'} stroke="#8c8a7e" strokeWidth={0.004} />
        </g>
      ))}
    </svg>
  );
}

export function GarmentPanel({ ctx }: { ctx: PanelCtx }) {
  const { project, version, scene, health, reload, seamFocus, setSeamFocus, selected, setMode } = ctx;
  const [draft, setDraft] = useState<Partial<HoodieParams>>({});
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft({});
    setProposal(null);
  }, [version?.id]);
  useEffect(() => {
    if (!Object.keys(draft).length) {
      setProposal(null);
      return;
    }
    const t = setTimeout(() => api.previewEdit(project.id, { patch: draft, summary: 'Manual change' }).then(setProposal).catch(() => setProposal(null)), 120);
    return () => clearTimeout(t);
  }, [draft, project.id]);
  if (!version) return <div className="section"><p className="dim">Generate a version first.</p></div>;
  const params = { ...version.params, ...draft };
  const cat = health?.catalog;
  const set = (k: keyof HoodieParams, v: HoodieParams[keyof HoodieParams]) => {
    const next = { ...draft, [k]: v } as Partial<HoodieParams>;
    if (version.params[k] === v) delete next[k];
    setDraft(next);
  };
  const apply = async () => {
    if (!proposal?.ok) return;
    const summary = proposal.ops.map((o) => (typeof o.to === 'number' ? `${o.label} ${cm(o.to)}` : `${o.label} ${o.to}`)).join(', ');
    try {
      await api.applyEdit(project.id, { patch: proposal.patch, source: 'manual', summary });
      setDraft({});
      setError(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const d = scene?.diagnostics as undefined | Record<string, number>;
  return (
    <div data-screen="S05">
      <JobStatus ctx={ctx} />
      <div className="section" data-testid="dimensions">
        <div className="row between"><h3>Dimensions</h3>{Object.keys(draft).length > 0 && <button className="btn sm ghost" onClick={() => setDraft({})}>Reset</button>}</div>
        {DIMS.map((k) => {
          const meta = cat?.params[k];
          if (!meta) return null;
          const note = version.notes[k];
          const changed = draft[k] !== undefined;
          return (
            <label className="slider-row" key={k}>
              <span className="row"><span className={changed ? 'changed' : ''}>{meta.label}</span><span className={`badge ${changed ? 'edited' : note?.source ?? 'default'}`} title={note?.note}>{(changed ? 'edited' : note?.source ?? 'default').toUpperCase()}</span></span>
              <span className="mono">{cm(params[k])}</span>
              <input type="range" aria-label={meta.label} min={meta.min} max={meta.max} step={0.005} value={params[k]} onChange={(e) => set(k, Number(e.target.value))} />
            </label>
          );
        })}
      </div>
      <div className="section">
        <h3>Fabric and colour</h3>
        <label className="field">Fabric preset
          <select value={params.fabric} onChange={(e) => set('fabric', e.target.value)}>
            {Object.values(cat?.fabrics ?? {}).map((f) => <option key={f.id} value={f.id}>{f.label}, {f.gsm} g/m²</option>)}
          </select>
        </label>
        <p className="dim">{cat?.fabrics[params.fabric]?.note}</p>
        <div className="row wrap">
          {([['baseColor', 'Main'], ['ribColor', 'Rib'], ['cordColor', 'Cord']] as const).map(([k, label]) => (
            <label className="row" key={k}><input type="color" aria-label={`${label} colour`} value={params[k]} onChange={(e) => set(k, e.target.value)} />{label}</label>
          ))}
        </div>
        <label className="row"><input type="checkbox" checked={params.pocket} onChange={(e) => set('pocket', e.target.checked)} /> Kangaroo pocket</label>
        <label className="row"><input type="checkbox" checked={params.drawcords} onChange={(e) => set('drawcords', e.target.checked)} /> Drawcords</label>
      </div>
      {proposal && (
        <div className="section" data-testid="edit-preview">
          {proposal.ok ? (
            <>
              <h3>Will change</h3>
              <div className="part-chips">{proposal.affectedParts.map((p) => <span className="chip hot" key={p}>{cat?.partLabels[p] ?? p}</span>)}</div>
              {proposal.warnings.map((w) => <p className="dim" key={w}>{w}</p>)}
              <button className="btn primary" disabled={ctx.running} onClick={apply}>Apply as new version</button>
            </>
          ) : <div className="notice bad">{proposal.refusal}</div>}
          {error && <div className="notice bad" role="alert">{error}</div>}
        </div>
      )}
      <div className="section">
        <h3>Fit and pinning</h3>
        <label className="field">Avatar
          <select value={version.avatar} disabled={ctx.running} onChange={(e) => void api.regenerate(project.id, version.id, { avatar: e.target.value as never }).then(reload).catch((err) => setError(err.message))}>
            {Object.entries(cat?.bodies ?? {}).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
          </select>
        </label>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Pin to the body during simulation</legend>
          <div className="row wrap">
            {(['collar', 'cuffs', 'hem'] as const).map((g) => (
              <label className="row" key={g}><input type="checkbox" checked={version.pins.includes(g)} disabled={ctx.running} onChange={(e) => {
                const pins = e.target.checked ? [...version.pins, g] : version.pins.filter((x) => x !== g);
                void api.regenerate(project.id, version.id, { pins }).then(reload).catch((err) => setError(err.message));
              }} /> {g}</label>
            ))}
          </div>
        </fieldset>
        {d && (
          <dl className="kv" data-testid="diagnostics">
            <dt>Vertices inside body</dt><dd>{(d.penetratingFraction * 100).toFixed(2)}%</dd>
            <dt>Deepest contact</dt><dd>{d.maxPenetrationMm.toFixed(1)} mm</dd>
            <dt>Stretch, 99th percentile</dt><dd>{((d.p99Stretch - 1) * 100).toFixed(1)}%</dd>
            <dt>Self-collision</dt><dd>{d.selfCollisionEnabled ? 'On, particle-based' : 'Off'}</dd>
          </dl>
        )}
        <div className="row"><button className="btn sm" onClick={() => setMode('collision')}>Show contact</button><button className="btn sm" onClick={() => setMode('stretch')}>Show stretch</button></div>
      </div>
      {scene && (
        <div className="section" data-testid="seams">
          <h3>Pattern</h3>
          <PatternView scene={scene} selected={selected} />
          <p className="dim">Derived from the 3D rest shape. Useful for inspection, not ready to send to a factory.</p>
          <div className="row between"><h3>Seams, {scene.seams.length}</h3><span className="badge inferred">STRUCTURAL</span></div>
          <p className="dim">Encoded in the mesh topology and shown in pink on the model. Not production-grade sewing data.</p>
          <ul className="tree">
            {scene.seams.map((s) => <li key={s.name} className={seamFocus === s.name ? 'sel' : ''}><button className="name" aria-pressed={seamFocus === s.name} onClick={() => setSeamFocus(seamFocus === s.name ? null : s.name)}>{s.name}</button></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Timeline({ ctx }: { ctx: PanelCtx }) {
  const { motionState: m, clip, togglePlay, viewport, setMotionState } = ctx;
  return (
    <div className="timeline" data-testid="timeline">
      <button className="btn sm" disabled={!clip} onClick={togglePlay} aria-label={m.playing ? 'Pause' : 'Play'}>{m.playing ? 'Pause' : 'Play'}</button>
      <input type="range" aria-label="Scrub timeline" min={0} max={Math.max(0.001, m.duration)} step={0.001} value={m.time} disabled={!clip} onChange={(e) => viewport.current?.seek(Number(e.target.value))} />
      <span className="mono" data-testid="frame">{clip ? `${String(m.frame + 1).padStart(3, '0')} / ${m.frames}` : 'No motion'}</span>
      <select aria-label="Playback speed" value={m.speed} style={{ width: 72 }} onChange={(e) => { const s = Number(e.target.value); if (viewport.current) viewport.current.speed = s; setMotionState((x) => ({ ...x, speed: s })); }}>
        <option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option>
      </select>
      {clip && <span className="badge refined">BAKED</span>}
    </div>
  );
}

export function MotionPanel({ ctx }: { ctx: PanelCtx }) {
  const { project, version, health, clip, selectClip, reload, running } = ctx;
  const [meta, setMeta] = useState<Record<string, { diagnostics: Record<string, number>; frames: number; fps: number }>>({});
  const baked = useMemo(() => version?.artifacts.motion ?? {}, [version?.artifacts.motion]);
  useEffect(() => {
    for (const [c, dir] of Object.entries(baked)) {
      if (!meta[c]) void files.json<(typeof meta)[string]>(project.id, `${dir}/meta.json`).then((m) => setMeta((x) => ({ ...x, [c]: m })));
    }
  }, [baked, meta, project.id]);
  useEffect(() => {
    setMeta({});
  }, [version?.id]);
  const current = clip ? meta[clip]?.diagnostics : null;
  if (!version) return <div className="section"><p className="dim">Generate a version first.</p></div>;
  return (
    <div data-screen="S06">
      <JobStatus ctx={ctx} />
      <div className="section" data-testid="clips">
        <h3>Motion</h3>
        <p className="dim">Cloth is simulated ahead of time and baked. The browser plays the stored frames, it does not simulate live. The clips are procedural, not motion capture.</p>
        {Object.entries(health?.catalog.clips ?? {}).map(([k, c]) => {
          const isBaked = Boolean(baked[k]);
          return (
            <div key={k} className="row between">
              <div className="grow">
                <div>{c.label}</div>
                <div className="dim">{c.note}</div>
              </div>
              {isBaked ? (
                <button className="btn sm" aria-pressed={clip === k} disabled={clip === k} onClick={() => void selectClip(k)}>{clip === k ? 'Loaded' : 'Load'}</button>
              ) : (
                <button className="btn sm" disabled={running || version.status !== 'ready'} onClick={() => void api.bakeMotion(project.id, version.id, k).then(reload)}>Bake</button>
              )}
            </div>
          );
        })}
        <button className="btn sm ghost" disabled={!clip} onClick={() => void selectClip(null)}>Back to static drape</button>
      </div>
      {current && (
        <div className="section" data-testid="motion-diagnostics">
          <h3>Collisions during motion</h3>
          <dl className="kv">
            <dt>Vertices inside body, worst frame</dt><dd>{(current.penetratingFraction * 100).toFixed(2)}%</dd>
            <dt>Deepest contact</dt><dd>{current.worstPenetrationMm.toFixed(1)} mm</dd>
            <dt>Stretch, worst frame p99</dt><dd>{((current.worstStretch - 1) * 100).toFixed(1)}%</dd>
            <dt>Peak cloth speed</dt><dd>{current.maxSpeed.toFixed(1)} m/s</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function iou(a: Uint8Array, b: Uint8Array) {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] && b[k]) i++;
    if (a[k] || b[k]) u++;
  }
  return u ? i / u : 0;
}

/** Fit a mask's bounding box to a square, keeping aspect, so only shape is compared. */
function normalizeMask(src: Uint8Array, w: number, h: number, size: number) {
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (src[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const out = new Uint8Array(size * size);
  if (x1 < x0) return out;
  const s = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = Math.round(cx + ((x + 0.5) / size - 0.5) * s);
      const sy = Math.round(cy + ((y + 0.5) / size - 0.5) * s);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * size + x] = src[sy * w + sx];
    }
  return out;
}

export function ReviewPanel({ ctx }: { ctx: PanelCtx }) {
  const { project, version, reload, viewport, scene, running } = ctx;
  const [qa, setQa] = useState<QaReport | null>(null);
  const [compare, setCompare] = useState<{ view: 'front' | 'back'; render: string; ref: string; iou: number | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setQa(null);
    if (version?.artifacts.qa) void files.json<QaReport>(project.id, version.artifacts.qa).then(setQa);
  }, [project.id, version?.artifacts.qa]);
  useEffect(() => {
    setCompare(null);
  }, [version?.id]);
  if (!version) return <div className="section"><p className="dim">Generate a version first.</p></div>;
  const runCompare = async () => {
    const vp = viewport.current;
    if (!vp) return;
    setBusy(true);
    const out: NonNullable<typeof compare> = [];
    for (const r of project.references) {
      if (r.usage !== 'used-by-pipeline' || (r.view !== 'front' && r.view !== 'back')) continue;
      const view = r.view;
      const render = vp.snapshot(view, 420);
      let score: number | null = null;
      const a = r.analysis as { maskUrl?: string } | undefined;
      if (a?.maskUrl) {
        const img = new Image();
        const maskUrl = await files.url(project.id, a.maskUrl);
        img.src = maskUrl;
        await img.decode();
        URL.revokeObjectURL(maskUrl);
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        const refMask = new Uint8Array(img.width * img.height);
        for (let i = 0; i < refMask.length; i++) refMask[i] = d[i * 4] > 128 ? 1 : 0;
        const sil = vp.silhouette(view, 320);
        if (sil) score = iou(normalizeMask(refMask, img.width, img.height, 256), normalizeMask(sil, 320, 320, 256));
      }
      out.push({ view, render, ref: await files.url(project.id, r.file), iou: score });
    }
    setCompare(out);
    setBusy(false);
  };
  const inferredCount = Object.values(version.notes).filter((n) => n.source !== 'measured' && n.source !== 'edited').length;
  const inferredSurfaces = Object.entries(scene?.textureSources?.sources ?? {}).filter(([, s]) => s === 'inferred-colour').map(([p]) => p);
  const regen = (body: Parameters<typeof api.regenerate>[2]) => api.regenerate(project.id, version.id, body).then(reload).catch((e) => setError(e.message));
  const check = version.editCheck as undefined | { perPart: { part: string; changed: boolean; maxMoveMm: number | null; allowed: boolean }[]; unexpected: string[]; passed: boolean; drapedShiftMm?: Record<string, number | null> };
  return (
    <div data-screen="S07">
      <JobStatus ctx={ctx} />
      <div className="section" data-testid="compare">
        <h3>Reference against render</h3>
        <button className="btn sm" disabled={busy || !version.artifacts.model || !project.references.some((r) => r.usage === 'used-by-pipeline')} onClick={runCompare}>{busy ? 'Rendering…' : 'Render matched views'}</button>
        {!project.references.some((r) => r.usage === 'used-by-pipeline') && <p className="dim">No reference image to compare against.</p>}
        {compare?.map((c) => (
          <div key={c.view} className="stack">
            <div className="compare">
              <figure><img src={c.ref} alt={`${c.view} reference`} /><figcaption>Reference, {c.view}</figcaption></figure>
              <figure><img src={c.render} alt={`${c.view} render`} /><figcaption>Render, {c.view}</figcaption></figure>
            </div>
            {c.iou !== null && <div className="row between"><span>Outline overlap (IoU)</span><span className="mono" data-testid={`iou-${c.view}`}>{(c.iou * 100).toFixed(0)}%</span></div>}
          </div>
        ))}
        {compare && <p className="dim">Outline overlap compares 2D shape only. A flat photo and a worn garment differ by pose, so a low score is expected, and a high score does not prove the 3D shape is right.</p>}
      </div>
      <div className="section" data-testid="qa">
        <div className="row between"><h3>Checks</h3>{qa && <span className="mono">{qa.summary.pass} pass · {qa.summary.warn} warn · {qa.summary.fail} fail</span>}</div>
        {!qa && <p className="dim">Checks run at the end of a build.</p>}
        {qa && <p className="dim">Thresholds are {qa.thresholdsStatus} and unapproved.</p>}
        <div>
          {qa?.checks.map((c) => (
            <div className="check" key={c.id}>
              <span className={`badge ${c.status}`}>{c.status.toUpperCase()}</span>
              <span>{c.label}</span>
              <span className="val"><span className="mono">{c.value}</span> · target {c.threshold}{c.detail ? <><br />{c.detail}</> : null}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="section">
        <h3>Inferred, not measured</h3>
        <p className="dim">{inferredCount} values are estimates or template defaults. Change any of them in the Garment tab.</p>
        <table className="t"><tbody>
          {Object.entries(version.notes).filter(([, n]) => n.source !== 'measured').slice(0, 20).map(([k, n]) => (
            <tr key={k}><td>{ctx.health?.catalog.params[k]?.label ?? k}</td><td><span className={`badge ${n.source}`}>{n.source.toUpperCase()}</span></td></tr>
          ))}
        </tbody></table>
        {inferredSurfaces.length > 0 && <p className="dim">No image covers: {inferredSurfaces.map((p) => ctx.health?.catalog.partLabels[p] ?? p).join(', ')}. They use the fabric colour only.</p>}
      </div>
      {check && (
        <div className="section" data-testid="edit-check">
          <div className="row between"><h3>Edit locality</h3><span className={`badge ${check.passed ? 'pass' : 'fail'}`}>{check.passed ? 'PASS' : 'FAIL'}</span></div>
          <table className="t">
            <thead><tr><th>Part</th><th>Pattern</th><th>Draped, mean</th></tr></thead>
            <tbody>{check.perPart.filter((p) => p.changed || (check.drapedShiftMm?.[p.part] ?? 0) > 0).map((p) => (
              <tr key={p.part}><td>{ctx.health?.catalog.partLabels[p.part] ?? p.part}</td><td className={p.changed ? 'changed' : 'dim'}>{p.changed ? `Changed${p.maxMoveMm !== null ? `, ${p.maxMoveMm.toFixed(0)} mm` : ''}` : 'Unchanged'}</td><td className="mono">{check.drapedShiftMm?.[p.part] != null ? `${check.drapedShiftMm[p.part]!.toFixed(1)} mm` : 'n/a'}</td></tr>
            ))}</tbody>
          </table>
          <p className="dim">"Pattern" compares the unsewn shape. "Draped" shows how far each part moved after simulation, which can be above zero even for unedited parts because the fabric is connected.</p>
        </div>
      )}
      <div className="section">
        <h3>Selective regenerate</h3>
        <p className="dim">Reuses every stage whose inputs did not change.</p>
        <div className="row wrap">
          <button className="btn sm" disabled={running} onClick={() => regen({ reseed: true })}>New drape</button>
          {version.quality !== 'high' && <button className="btn sm" disabled={running} onClick={() => regen({ quality: version.quality === 'preview' ? 'standard' : 'high' })}>Raise quality</button>}
        </div>
        {error && <div className="notice bad" role="alert">{error}</div>}
      </div>
      <History ctx={ctx} />
      <div className="section">
        <h3>Your approval</h3>
        <p className="dim">Only you can approve. Automated checks never set this.</p>
        {version.approved ? (
          <div className="row between"><span className="badge pass">APPROVED {new Date(version.approved.at).toLocaleDateString()}</span><button className="btn sm ghost" onClick={() => void api.approve(project.id, version.id, false).then(reload)}>Withdraw</button></div>
        ) : <button className="btn" disabled={version.status !== 'ready'} onClick={() => void api.approve(project.id, version.id, true).then(reload)}>Approve this version</button>}
      </div>
    </div>
  );
}

const MATRIX: [string, string, string][] = [
  ['Geometry and named parts', 'yes', 'yes'],
  ['UVs', 'yes', 'yes'],
  ['PBR materials', 'yes', 'Colour only'],
  ['Textures', 'Embedded', 'Separate file'],
  ['Avatar with rig', 'yes', 'no'],
  ['Skeletal animation', 'yes', 'no'],
  ['Baked cloth motion', 'Morph targets', 'no'],
  ['Live cloth simulation setup', 'no', 'no'],
  ['Sewing pattern data', 'no', 'no'],
];

interface ReportView {
  validators: { name: string; passed: boolean; notRun?: boolean; version?: string }[];
  warnings: string[];
  durationMs: number;
}

export function ExportPanel({ ctx }: { ctx: PanelCtx }) {
  const { project, version, reload, health, running } = ctx;
  const [format, setFormat] = useState<ExportFormat>('glb');
  const baked = Object.keys(version?.artifacts.motion ?? {});
  const [clip, setClip] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, ReportView>>({});
  useEffect(() => {
    for (const e of version?.exports ?? []) {
      if (!reports[e.report]) void files.json<ReportView>(project.id, e.report).then((d) => setReports((x) => ({ ...x, [e.report]: d })));
    }
  }, [version?.exports, project.id, reports]);
  if (!version) return <div className="section"><p className="dim">Generate a version first.</p></div>;
  const go = async () => {
    setError(null);
    try {
      await api.exportAsset(project.id, version.id, format, format === 'obj' ? null : clip || null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div data-screen="S08">
      <JobStatus ctx={ctx} />
      <div className="section" data-testid="export-form">
        <h3>Export</h3>
        <div className="seg" role="group" aria-label="Format">
          {([['glb', 'GLB'], ['blender', 'For Blender'], ['obj', 'OBJ']] as const).map(([k, l]) => <button key={k} aria-pressed={format === k} onClick={() => setFormat(k)}>{l}</button>)}
        </div>
        {format === 'blender' && (
          <div className="notice" data-testid="blender-note">
            <strong>This is not a .blend file.</strong> Only Blender can write a genuine one, and this studio runs entirely in your browser. You get the same GLB, which Blender imports directly, plus a small script that saves it as a .blend from your own Blender. Neither has been tested in Blender yet.
          </div>
        )}
        {format !== 'obj' ? (
          <label className="field">Motion to include
            <select value={clip} onChange={(e) => setClip(e.target.value)}>
              <option value="">None, static drape with avatar rig and clips</option>
              {baked.map((c) => <option key={c} value={c}>{health.catalog.clips[c as keyof typeof health.catalog.clips]?.label}, baked cloth</option>)}
            </select>
          </label>
        ) : <p className="dim">OBJ has no animation, so it stores the static drape only.</p>}
        <dl className="kv">
          <dt>Units</dt><dd>Metres</dd>
          <dt>Orientation</dt><dd>+Y up, +Z front</dd>
          <dt>Frame rate</dt><dd>{format === 'obj' ? 'n/a' : '30 fps'}</dd>
          <dt>Avatar included</dt><dd>{format === 'obj' ? 'No' : 'Yes'}</dd>
        </dl>
        <button className="btn primary" disabled={running || version.status !== 'ready'} onClick={go}>Export and validate</button>
        {error && <div className="notice bad" role="alert">{error}</div>}
      </div>
      <div className="section" data-testid="exports">
        <h3>Files for this version</h3>
        {version.exports.length === 0 && <p className="dim">Nothing exported yet.</p>}
        {version.exports.map((e) => {
          const rep = reports[e.report];
          return (
            <div key={e.id} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div className="row between"><strong>{e.format === 'blender' ? 'For Blender' : e.format.toUpperCase()}{e.clip ? `, ${e.clip}` : ''}</strong><span className={`badge ${e.status === 'unverified' ? 'warn' : e.status}`}>{e.status.toUpperCase()}</span></div>
              {e.message && <p className="dim">{e.message}</p>}
              <button className="btn sm" data-testid={`download-${e.format}`} onClick={() => { setError(null); void files.downloadZip(project.id, e.dir, e.files.map((f) => f.name), `hoodie-${e.format}${e.clip ? `-${e.clip}` : ''}.zip`).catch((err: { code?: string; message?: string }) => { if (err?.code !== 'declined') setError(err?.message ?? 'The download could not start.'); }); }}>Download ZIP</button>
              <div className="dim">{e.files.map((f) => `${f.name}, ${bytes(f.bytes)}`).join(' · ')}</div>
              {rep?.validators.map((v) => <div key={v.name} className="row between"><span className="muted">{v.name}{v.version ? ` ${v.version}` : ''}</span><span className={v.passed ? 'yes' : v.notRun ? 'part' : ''} style={!v.passed && !v.notRun ? { color: 'var(--bad)' } : undefined}>{v.passed ? 'Passed' : v.notRun ? 'Not run' : 'Failed'}</span></div>)}
              <button className="btn sm ghost" onClick={() => void files.download(project.id, e.report, `report-${e.format}.json`).catch(() => undefined)}>Download validation report, JSON</button>
            </div>
          );
        })}
      </div>
      <div className="section">
        <h3>What each format keeps</h3>
        <table className="t" data-testid="format-matrix">
          <thead><tr><th></th><th>GLB</th><th>OBJ</th></tr></thead>
          <tbody>
            {MATRIX.map(([label, ...vals]) => (
              <tr key={label}><td>{label}</td>{vals.map((v, i) => <td key={i} className={v === 'yes' ? 'yes' : v === 'no' ? 'no' : 'part'}>{v === 'yes' ? 'Yes' : v === 'no' ? 'No' : v}</td>)}</tr>
            ))}
          </tbody>
        </table>
        <p className="dim">This table describes what is written to each file, confirmed by the validators. It has not been confirmed in Blender or other 3D tools. FBX and USD are not offered, because they have not been tested.</p>
      </div>
    </div>
  );
}
