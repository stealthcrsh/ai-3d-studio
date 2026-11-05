import { useEffect, useState } from 'react';
import { api, fileUrl, type Health, type ProjectCard } from '../api.ts';
import { navigate, onLiveEvent } from '../App.tsx';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Library({ health }: { health: Health | null }) {
  const [items, setItems] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const load = () => api.list().then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    return onLiveEvent((e) => {
      if (e.type === 'job' || e.type === 'project') load();
    });
  }, []);

  const create = async () => {
    const p = await api.create('Oversized hoodie');
    navigate(`#/p/${p.id}/import`);
  };

  return (
    <main className="page" data-screen="S01">
      <div className="page-head">
        <div className="stack">
          <div className="row">
            <span className="brand-mark" aria-hidden />
            <h1>AI 3D Studio</h1>
          </div>
          <p className="muted">Turn reference images into editable, simulated, exportable 3D garments. Hoodies first.</p>
        </div>
        <button className="btn primary" onClick={create}>New project</button>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {health && !health.blender.path && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Blender is not installed, so .blend export is unavailable. GLB and OBJ export still work.
        </div>
      )}
      {items === null && !error && <p className="muted">Loading projects…</p>}
      {items?.length === 0 && (
        <div className="empty">
          <h2>No projects yet</h2>
          <p style={{ margin: '6px 0 14px' }}>Start with a photo of a hoodie, or with no image at all to try the template.</p>
          <button className="btn primary" onClick={create}>Create your first project</button>
        </div>
      )}
      <div className="cards">
        {items?.map((p) => (
          <article className="card" key={p.id}>
            <button className="cover" aria-label={`Open ${p.name}`} style={p.cover ? { backgroundImage: `url(${fileUrl(p.id, p.cover)})` } : {}} onClick={() => navigate(`#/p/${p.id}/${p.versions ? 'studio' : 'import'}`)} />
            <div className="body">
              {renaming === p.id ? (
                <input type="text" defaultValue={p.name} autoFocus aria-label="Project name" onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} onBlur={async (e) => { await api.patch(p.id, { name: e.target.value }); setRenaming(null); load(); }} />
              ) : (
                <h2>{p.name}</h2>
              )}
              <div className="row wrap">
                {p.tier !== 'none' && <span className={`badge ${p.tier}`}>{p.tier.toUpperCase()}</span>}
                {p.label && <span className="badge baseline">{p.label}</span>}
                {p.lastJob && ['interrupted', 'failed'].includes(p.lastJob.status) && <span className="badge fail">JOB {p.lastJob.status.toUpperCase()}</span>}
                {p.lastJob?.status === 'running' && <span className="badge draft">RUNNING</span>}
              </div>
              <p className="dim">{p.references} references · {p.versions} versions · {when(p.updatedAt)}</p>
              <div className="row wrap">
                <button className="btn sm" onClick={() => navigate(`#/p/${p.id}/${p.versions ? 'studio' : 'import'}`)}>{p.lastJob?.status === 'interrupted' ? 'Resume' : 'Open'}</button>
                <button className="btn sm ghost" onClick={() => setRenaming(p.id)}>Rename</button>
                <button className="btn sm ghost" onClick={async () => { await api.duplicate(p.id); load(); }}>Duplicate</button>
                {confirming === p.id ? (
                  <>
                    <button className="btn sm danger" onClick={async () => { await api.remove(p.id); setConfirming(null); load(); }}>Delete for good</button>
                    <button className="btn sm ghost" onClick={() => setConfirming(null)}>Keep</button>
                  </>
                ) : (
                  <button className="btn sm ghost" onClick={() => setConfirming(p.id)}>Delete</button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
