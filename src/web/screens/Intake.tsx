import { useCallback, useEffect, useState } from 'react';
import { api, bytes, cm, fileUrl, type Health, type Project, type ProjectFull, type ReconstructionResult } from '../api.ts';
import { navigate } from '../App.tsx';

const FORMATS: [string, string, string][] = [
  ['PNG, JPEG', 'Front and back views are measured and projected onto the garment', 'Used'],
  ['MP4, MOV video', 'Stored with the project', 'Stored only'],
  ['PDF blueprint or CAD drawing', 'Stored with the project', 'Stored only'],
  ['GLB, OBJ 3D model', 'Stored and never opened', 'Stored only'],
  ['TXT notes', 'Stored with the project', 'Stored only'],
  ['WebP, HEIC, GIF', 'Convert to PNG or JPEG first', 'Rejected'],
];

export function ImportScreen({ project, reload, health }: { project: ProjectFull; reload: () => void; health: Health | null }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [desc, setDesc] = useState(project.description);
  const m = project.measurements;
  const [meas, setMeas] = useState<Record<string, string>>({
    bodyLength: m.bodyLength ? String(m.bodyLength * 100) : '',
    bodyWidth: m.bodyWidth ? String(m.bodyWidth * 100) : '',
    sleeveLength: m.sleeveLength ? String(m.sleeveLength * 100) : '',
  });

  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setErrors([]);
    try {
      const r = await api.upload(project.id, files);
      setErrors(r.errors);
    } catch (e) {
      const data = (e as { data?: { errors?: string[] } }).data;
      setErrors(data?.errors ?? [(e as Error).message]);
    }
    setBusy(false);
    reload();
  }, [project.id, reload]);

  const saveDetails = async () => {
    const measurements = Object.fromEntries(Object.entries(meas).filter(([, v]) => v).map(([k, v]) => [k, Number(v) / 100]));
    try {
      await api.patch(project.id, { description: desc, measurements });
      setErrors([]);
      navigate(`#/p/${project.id}/setup`);
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  };

  return (
    <main className="page" data-screen="S02">
      <div className="page-head">
        <div className="stack">
          <h1>Add references</h1>
          <p className="muted">A front photo on a plain background works best. A back photo means less of the garment is guessed.</p>
        </div>
        <button className="btn primary" onClick={saveDetails}>Continue to setup</button>
      </div>
      <div className="two-col">
        <div className="stack-lg">
          <label className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]); }}>
            <input type="file" multiple hidden accept=".png,.jpg,.jpeg,.mp4,.mov,.pdf,.glb,.obj,.txt,.md" onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
            <h2>{busy ? 'Checking and measuring files…' : 'Drop files here, or click to choose'}</h2>
            <p className="muted" style={{ marginTop: 4 }}>Up to {health?.catalog.uploads.maxFiles ?? 12} files, {Math.round((health?.catalog.uploads.maxBytes ?? 3e7) / 1e6 / 1.048)} MB each, 40 megapixels per image.</p>
          </label>
          {errors.map((e) => <div key={e} className="notice bad" role="alert">{e}</div>)}
          {project.references.length > 0 && (
            <div className="thumbs">
              {project.references.map((r) => {
                const a = r.analysis as undefined | { ok: boolean; confidence: number; warnings: string[]; medianColor: string; hoodDetected: boolean; maskUrl: string };
                const image = r.kind === 'png' || r.kind === 'jpeg';
                return (
                  <div className="thumb" key={r.id}>
                    <div className="pic">
                      {image ? <img src={fileUrl(project.id, r.file)} alt={`${r.view} reference`} /> : <div className="viewport-empty mono">{r.kind.toUpperCase()}</div>}
                      {a?.maskUrl && <img className="mask" src={fileUrl(project.id, a.maskUrl)} alt="" />}
                    </div>
                    <div className="body">
                      <div className="row between"><span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.filename}>{r.filename}</span><button className="icon-btn" aria-label={`Remove ${r.filename}`} onClick={async () => { await api.removeRef(project.id, r.id); reload(); }}>✕</button></div>
                      {image ? (
                        <label className="field">Camera view
                          <select value={r.view} onChange={async (e) => { await api.setView(project.id, r.id, e.target.value); reload(); }}>
                            <option value="front">Front</option><option value="back">Back</option><option value="side">Side (stored only)</option><option value="detail">Detail (stored only)</option><option value="other">Other (stored only)</option>
                          </select>
                        </label>
                      ) : <span className="dim">Stored, not used by the pipeline yet.</span>}
                      <div className="row wrap">
                        <span className={`badge ${r.usage === 'used-by-pipeline' ? 'pass' : 'none'}`}>{r.usage === 'used-by-pipeline' ? 'USED' : 'STORED ONLY'}</span>
                        <span className="dim">{bytes(r.bytes)}</span>
                      </div>
                      {a && (a.ok ? (
                        <div className="row"><span title="Median colour" style={{ width: 14, height: 14, borderRadius: 3, background: a.medianColor, border: '1px solid #0006' }} /><span className="dim">Outline found, confidence {(a.confidence * 100).toFixed(0)}%. Hover to see it.</span></div>
                      ) : <span style={{ color: 'var(--bad)' }}>{a.warnings.at(-1)}</span>)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <aside className="stack-lg">
          <div className="panel">
            <h3>Measurements (optional)</h3>
            <p className="dim">A photo has no absolute scale. Anything you enter is treated as measured and overrides the estimate.</p>
            {([['bodyLength', 'Body length, shoulder to hem'], ['bodyWidth', 'Chest width, laid flat'], ['sleeveLength', 'Sleeve length']] as const).map(([k, label]) => (
              <label className="field" key={k}>{label}, cm
                <input type="number" min={10} max={120} step={0.5} value={meas[k]} onChange={(e) => setMeas({ ...meas, [k]: e.target.value })} />
              </label>
            ))}
            <label className="field">Notes
              <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Saved with the project. Not read by the pipeline yet." />
            </label>
          </div>
          <div className="panel">
            <h3>What each format does today</h3>
            <table className="t"><tbody>
              {FORMATS.map(([f, d, s]) => <tr key={f}><td><div>{f}</div><div className="dim">{d}</div></td><td className={s === 'Used' ? 'yes' : s === 'Rejected' ? 'part' : 'no'}>{s}</td></tr>)}
            </tbody></table>
          </div>
          <div className="panel">
            <h3>Privacy</h3>
            <p className="muted">Files stay on this machine in the project folder. Nothing is uploaded to a service or used for training. Deleting a project deletes its files.</p>
          </div>
        </aside>
      </div>
    </main>
  );
}

export function SetupScreen({ project, reload, health }: { project: ProjectFull; reload: () => void; health: Health | null }) {
  const [inferred, setInferred] = useState<ReconstructionResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.infer(project.id).then(setInferred).catch((e) => setError(e.message));
  }, [project.id, project.setup.provider, project.references.length]);
  const update = async (setup: Partial<Project['setup']>) => {
    await api.patch(project.id, { setup });
    reload();
  };
  const go = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.generate(project.id);
      navigate(`#/p/${project.id}/studio`);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };
  const cat = health?.catalog;
  const hasImage = project.references.some((r) => r.usage === 'used-by-pipeline');
  const ESTIMATE: Record<string, string> = { preview: 'About 3 seconds', standard: 'About 15 seconds', high: 'About 1 to 2 minutes' };
  return (
    <main className="page" data-screen="S03">
      <div className="page-head">
        <div className="stack">
          <h1>Set up generation</h1>
          <p className="muted">Check what was read from your images and what is only a guess. Everything stays editable afterwards.</p>
        </div>
        <button className="btn primary" disabled={starting} onClick={go}>{starting ? 'Starting…' : project.versions.length ? 'Generate again' : 'Generate'}</button>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <div className="two-col">
        <div className="stack-lg">
          <div className="notice base">
            <strong>This build makes a DEMO BASELINE, not an AI reconstruction.</strong>{' '}
            It measures your image's outline with classical code, fits a hoodie pattern to it, and simulates the fabric on an avatar. Hidden geometry comes from the template.
          </div>
          {!hasImage && <div className="notice">No usable image yet, so generating gives you the plain template. <a href={`#/p/${project.id}/import`}>Add a reference</a>.</div>}
          {inferred?.warnings.map((w) => <div className="notice" key={w}>{w}</div>)}
          <div className="panel">
            <div className="row between"><h3>Detected</h3><span className="row"><span className="badge inferred">Hoodie</span><span className="dim">Fixed category in this release</span></span></div>
            <table className="t" data-testid="infer-table">
              <thead><tr><th>Measurement</th><th>Value</th><th>Source</th><th>Basis</th></tr></thead>
              <tbody>
                {inferred && Object.entries(cat?.params ?? {}).map(([k, meta]) => {
                  const n = inferred.notes[k];
                  return (
                    <tr key={k}>
                      <td>{meta.label}</td>
                      <td className="mono">{cm((inferred.params as unknown as Record<string, number>)[k])}</td>
                      <td><span className={`badge ${n?.source ?? 'default'}`}>{(n?.source ?? 'default').toUpperCase()}</span></td>
                      <td className="dim">{n?.note}</td>
                    </tr>
                  );
                })}
                {inferred && (
                  <tr>
                    <td>Main colour</td>
                    <td><span className="row"><span style={{ width: 14, height: 14, borderRadius: 3, background: inferred.params.baseColor }} /><span className="mono">{inferred.params.baseColor}</span></span></td>
                    <td><span className={`badge ${inferred.notes.baseColor?.source}`}>{inferred.notes.baseColor?.source.toUpperCase()}</span></td>
                    <td className="dim">{inferred.notes.baseColor?.note}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <aside className="stack-lg">
          <div className="panel">
            <h3>Quality</h3>
            <div className="seg" role="group" aria-label="Quality">
              {Object.entries(cat?.quality ?? {}).map(([k, q]) => <button key={k} aria-pressed={project.setup.quality === k} onClick={() => update({ quality: k as never })}>{q.label}</button>)}
            </div>
            {cat && (
              <dl className="kv">
                <dt>Mesh edge length</dt><dd>{(cat.quality[project.setup.quality].ds * 1000).toFixed(0)} mm</dd>
                <dt>Texture</dt><dd>{cat.quality[project.setup.quality].texture} px</dd>
                <dt>Self-collision</dt><dd>{cat.quality[project.setup.quality].selfCollide ? 'On' : 'Off'}</dd>
                <dt>Time on Apple M6</dt><dd>{ESTIMATE[project.setup.quality]}</dd>
                <dt>Compute cost</dt><dd>$0, runs locally</dd>
              </dl>
            )}
          </div>
          <div className="panel">
            <label className="field">Avatar
              <select value={project.setup.avatar} onChange={(e) => update({ avatar: e.target.value as never })}>
                {Object.entries(cat?.bodies ?? {}).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
              </select>
            </label>
            <label className="field">Motion to bake
              <select value={project.setup.clip ?? ''} onChange={(e) => update({ clip: (e.target.value || null) as never })}>
                <option value="">None, static drape only</option>
                {Object.entries(cat?.clips ?? {}).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
              </select>
            </label>
            <label className="field">Generator
              <select value={project.setup.provider} onChange={(e) => update({ provider: e.target.value as never })}>
                {health?.providers.map((p) => <option key={p.id} value={p.id}>{p.label}{p.status !== 'available' ? ' (not configured)' : ''}</option>)}
              </select>
            </label>
            <p className="dim">{health?.providers.find((p) => p.id === project.setup.provider)?.note}</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
