import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';
import useModalA11y from '../hooks/useModalA11y';
import Icon from '../components/Icon';

// Nada acá borra solo. El servidor sugiere candidatos (proyecto cerrado y cobrado, video que no es
// el aprobado ni la última entrega) pero los checkbox arrancan siempre vacíos: la selección la hace
// el usuario y pasa por el modal de confirmación de abajo, que lista exactamente qué se va a borrar.
// Pedido explícito del usuario cuando arrancó esta pantalla: "no quiero que borres nada sin antes
// preguntarme".
function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

export default function Storage() {
  const { api } = useAuth();
  const { alert } = useAlert();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [selected, setSelected] = useState({}); // { [videoId]: true }
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = () => api('/api/storage/breakdown')
    .then(setData)
    .catch(e => { console.error(e); alert('No se pudo cargar el almacenamiento: ' + e.message); })
    .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const confirmModalRef = useModalA11y(confirming, () => !deleting && setConfirming(false));

  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>;
  if (!data) return null;

  const allVideos = data.projects.flatMap(p => p.videos.map(v => ({ ...v, project_name: p.project_name })));
  const selectedVideos = allVideos.filter(v => selected[v.id]);
  const selectedBytes = selectedVideos.reduce((s, v) => s + v.bytes, 0);
  const pct = data.limitBytes ? Math.min(100, (data.totalBytes / data.limitBytes) * 100) : 0;
  const barColor = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--yellow)' : 'var(--green)';
  const candidateCount = allVideos.filter(v => v.candidate).length;
  const candidateBytes = allVideos.filter(v => v.candidate).reduce((s, v) => s + v.bytes, 0);

  const toggle = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));

  const runDelete = async () => {
    setDeleting(true);
    const failed = [];
    for (const v of selectedVideos) {
      try { await api(`/api/videos/${v.id}`, { method: 'DELETE' }); }
      catch (e) { failed.push(`${v.title}: ${e.message}`); }
    }
    setDeleting(false);
    setConfirming(false);
    setSelected({});
    setLoading(true);
    await load();
    if (failed.length) await alert(`No se pudieron borrar ${failed.length} video(s):\n${failed.join('\n')}`);
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>Almacenamiento</h1>
        <p style={{ color: 'var(--text2)', fontSize: 14 }}>
          Qué está ocupando lugar y qué podés liberar. Nada se borra automáticamente.
        </p>
      </div>

      <div className="panel" style={{ borderRadius: 14, padding: '18px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <span style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: barColor }}>{formatBytes(data.totalBytes)}</span>
            <span style={{ fontSize: 14, color: 'var(--text2)' }}> de {formatBytes(data.limitBytes)} usados</span>
          </div>
          <span style={{ fontSize: 13, color: 'var(--text3)' }}>{pct.toFixed(0)}% · quedan {formatBytes(Math.max(0, data.limitBytes - data.totalBytes))}</span>
        </div>
        <div style={{ height: 10, borderRadius: 6, background: 'var(--bg4)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10, lineHeight: 1.5 }}>
          Videos: <strong style={{ color: 'var(--text2)' }}>{formatBytes(data.videosBytes)}</strong>
          {data.otherBytes > 0 && <> · Miniaturas y adjuntos de chat/comentarios: <strong style={{ color: 'var(--text2)' }}>{formatBytes(data.otherBytes)}</strong> (no se administran desde acá)</>}
          <br />Al llegar al límite las subidas de video empiezan a fallar.
        </div>
        {/* La barra mide el storage REAL (es lo que cuenta contra el límite y lo que corta las
            subidas), mientras el desglose de abajo sale de los tamaños guardados en la base. Si la
            base suma más que el storage real, hay filas apuntando a archivos que ya no están —
            mostrarlo evita la pantalla confusa de "0 MB usados" con una lista de videos debajo. */}
        {data.videosBytes > data.totalBytes && (
          <div style={{ fontSize: 12, color: 'var(--yellow)', background: 'rgba(240,168,58,0.08)', padding: '8px 12px', borderRadius: 8, marginTop: 10, lineHeight: 1.45 }}>
            La base suma {formatBytes(data.videosBytes)} en videos pero en el storage real hay {formatBytes(data.totalBytes)}. Puede haber videos cuyo archivo ya no existe, o el cálculo del total estar cacheado unos minutos.
          </div>
        )}
      </div>

      {candidateCount > 0 && (
        <div className="panel" style={{ borderRadius: 12, padding: '12px 16px', marginBottom: 18, background: 'rgba(240,168,58,0.06)', border: '1px solid rgba(240,168,58,0.25)' }}>
          <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
            💡 Hay <strong style={{ color: 'var(--yellow)' }}>{candidateCount} video(s)</strong> marcados como candidatos ({formatBytes(candidateBytes)}): son versiones intermedias de proyectos ya <strong>cerrados y cobrados</strong>, que no son la entrega aprobada ni la última. <strong>No están seleccionados</strong> — revisalos y tildá vos los que quieras borrar.
          </div>
        </div>
      )}

      {data.projects.length === 0 && (
        <div className="empty"><div className="empty-icon">📦</div><p>Todavía no hay videos subidos</p></div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: selectedVideos.length ? 80 : 0 }}>
        {data.projects.map(p => {
          const isOpen = expanded[p.project_id];
          return (
            <div key={p.project_id} className="panel" style={{ borderRadius: 12, overflow: 'hidden' }}>
              <div onClick={() => setExpanded(prev => ({ ...prev, [p.project_id]: !prev[p.project_id] }))}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', background: 'var(--bg3)' }}>
                <span style={{ fontSize: 11, color: 'var(--text3)', width: 10 }}>{isOpen ? '▼' : '▶'}</span>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.client_color || 'var(--text3)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.project_name}
                    {p.client_name && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> · {p.client_name}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{p.videos.length} video(s)</div>
                </div>
                {p.settled && <span className="badge" style={{ fontSize: 10, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>cerrado y cobrado</span>}
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatBytes(p.bytes)}</span>
              </div>

              {isOpen && (
                <div style={{ padding: '6px 14px 12px' }}>
                  {p.videos.map(v => (
                    <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                      <input type="checkbox" checked={!!selected[v.id]} onChange={() => toggle(v.id)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.title}</span>
                          <span style={{ color: 'var(--text3)' }}>v{v.version}</span>
                          {v.approved && <span className="badge" style={{ fontSize: 9, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>✓ aprobado</span>}
                          {v.latest && <span className="badge" style={{ fontSize: 9, background: 'var(--accent-glow)', color: 'var(--accent2)' }}>última entrega</span>}
                          {v.candidate && <span className="badge" style={{ fontSize: 9, background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)' }}>candidato</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>
                          {new Date(v.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </div>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatBytes(v.bytes)}</span>
                    </label>
                  ))}
                  <button className="btn-outline" onClick={() => navigate(`/project/${p.project_id}?tab=videos`)}
                    style={{ marginTop: 10, borderRadius: 7, padding: '5px 10px', fontSize: 11.5, color: 'var(--text2)' }}>
                    Ver el proyecto →
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {selectedVideos.length > 0 && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 900, display: 'flex', alignItems: 'center', gap: 14, background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 12, padding: '12px 18px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          <span style={{ fontSize: 13, color: 'var(--text)' }}>
            <strong>{selectedVideos.length}</strong> video(s) · liberás <strong style={{ color: 'var(--green)' }}>{formatBytes(selectedBytes)}</strong>
          </span>
          <button className="btn btn-ghost" onClick={() => setSelected({})} style={{ fontSize: 12 }}>Cancelar</button>
          <button className="btn btn-danger" onClick={() => setConfirming(true)} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon.trash /> Eliminar seleccionados
          </button>
        </div>
      )}

      {confirming && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} ref={confirmModalRef} role="dialog" aria-modal="true" aria-labelledby="storage-delete-title">
            {!deleting && <button className="modal-close" onClick={() => setConfirming(false)} title="Cerrar" aria-label="Cerrar">✕</button>}
            <h2 id="storage-delete-title">¿Eliminar {selectedVideos.length} video(s)?</h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>
              Se borran los archivos y sus comentarios. <strong style={{ color: 'var(--red)' }}>No se puede deshacer.</strong> Liberás {formatBytes(selectedBytes)}.
            </p>
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 14 }}>
              {selectedVideos.map(v => (
                <div key={v.id} style={{ fontSize: 12, color: 'var(--text2)', padding: '4px 0', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(v.approved || v.latest) && <span style={{ color: 'var(--yellow)' }}>⚠ </span>}
                    {v.project_name} · {v.title} v{v.version}
                    {v.approved && <span style={{ color: 'var(--yellow)' }}> (aprobado)</span>}
                    {v.latest && <span style={{ color: 'var(--yellow)' }}> (última entrega)</span>}
                  </span>
                  <span style={{ whiteSpace: 'nowrap', color: 'var(--text3)' }}>{formatBytes(v.bytes)}</span>
                </div>
              ))}
            </div>
            {selectedVideos.some(v => v.approved || v.latest) && (
              <p style={{ fontSize: 12.5, color: 'var(--yellow)', background: 'rgba(240,168,58,0.08)', padding: '8px 12px', borderRadius: 8, marginBottom: 14, lineHeight: 1.45 }}>
                Ojo: seleccionaste videos aprobados o que son la última entrega de su proyecto. Si el cliente todavía puede querer ese archivo, no lo borres.
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={deleting}>Cancelar</button>
              <button className="btn btn-danger" onClick={runDelete} disabled={deleting}>
                {deleting ? 'Eliminando...' : `Sí, eliminar ${selectedVideos.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
