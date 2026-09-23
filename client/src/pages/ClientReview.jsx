import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import VideoReviewPane from '../components/VideoReviewPane';

// Página pública, sin sesión — igual que PublicReview.jsx (el link por video), pero acá el token
// es de un CLIENTE (client_shares, ver server/routes/shares.js), no de un video puntual: un solo
// link estable con todos los proyectos activos y videos del cliente, para no tener que generar y
// reenviar un link nuevo cada vez que se sube algo. Al entrar a un video se reusa VideoReviewPane,
// el mismo componente que usa el link por video.
export default function ClientReview() {
  const { token } = useParams();
  const [status, setStatus] = useState('loading'); // loading | ok | notfound | gone
  const [data, setData] = useState(null);
  const [selectedVideoId, setSelectedVideoId] = useState(null);

  useEffect(() => {
    fetch(`/api/client-review/${token}`)
      .then(async r => {
        if (r.status === 404) { setStatus('notfound'); return null; }
        if (!r.ok) { setStatus('gone'); return null; }
        return r.json();
      })
      .then(d => { if (d) { setData(d); setStatus('ok'); } })
      .catch(() => setStatus('gone'));
  }, [token]);

  if (status === 'loading') {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}><div className="spinner" /></div>;
  }

  if (status === 'notfound' || status === 'gone') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)', padding: 24 }}>
        <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-lg)', fontWeight: 800, marginBottom: 8 }}>
            {status === 'notfound' ? 'Este link no existe' : 'Este link ya no está disponible'}
          </h1>
          <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text2)', lineHeight: 'var(--lh-normal)' }}>
            Pedile a la agencia que te comparta un link nuevo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: 900 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
          <span>📁</span><span>Portal de {data.client.name}</span>
        </div>

        {selectedVideoId ? (
          <VideoReviewPane
            apiBase={`/api/client-review/${token}/video/${selectedVideoId}`}
            onBack={() => setSelectedVideoId(null)}
          />
        ) : (
          <>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 20 }}>
              Hola, {data.client.name}
            </h1>
            {data.projects.length === 0 && (
              <div className="empty"><div className="empty-icon">📁</div><p>No hay proyectos activos por ahora</p></div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {data.projects.map(p => (
                <div key={p.id}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{p.name}</span>
                  </div>
                  {p.videos.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text3)', paddingLeft: 17 }}>Todavía no hay videos en este proyecto.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {p.videos.map(v => (
                        <div key={v.id} className="list-row" onClick={() => setSelectedVideoId(v.id)}>
                          <span style={{ fontSize: 20, flexShrink: 0 }}>🎬</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{v.title} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>v{v.version}</span></div>
                            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                              {new Date(v.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </div>
                          </div>
                          {v.approved_at ? (
                            <span className="badge" style={{ fontWeight: 600, background: 'rgba(34,201,122,0.12)', color: 'var(--green)', flexShrink: 0 }}>
                              ✓ Aprobado{v.approved_by_name ? ` por ${v.approved_by_name}` : ''}
                            </span>
                          ) : (
                            <span className="badge" style={{ fontWeight: 600, background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)', flexShrink: 0 }}>
                              Pendiente de revisión
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
