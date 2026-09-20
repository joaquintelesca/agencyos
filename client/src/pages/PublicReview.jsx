import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAlert } from '../context/AlertContext';
import VideoPlayerAnnotator, { formatTime } from '../components/VideoPlayerAnnotator';

// Página pública, sin sesión: fuera de <AuthProvider>/<PrivateRoute>, por eso no usa el api()
// de AuthContext (asume un token de sesión que acá no existe) — fetch directo a rutas propias
// que no pasan por el middleware `auth` del servidor (ver server/index.js, sección VIDEO SHARES).
// El reproductor es VideoPlayerAnnotator, el MISMO componente que usa el admin/editor en
// VideoReview.jsx (pedido explícito: "quiero que sea exactamente igual que el otro") — controles,
// timeline con marcadores y herramientas de dibujo idénticas. Lo único que cambia es cómo se
// guarda el comentario (fetch a la ruta pública en vez de api() con FormData) y que no hay
// adjuntos (el endpoint público no los soporta) ni panel de moderación (resolver/eliminar/responder
// son acciones del equipo interno, no del cliente).
const GUEST_NAME_KEY = 'agencyos_guest_name';

export default function PublicReview() {
  const { token } = useParams();
  const { alert } = useAlert();
  const [status, setStatus] = useState('loading'); // loading | ok | notfound | gone
  const [video, setVideo] = useState(null);
  const [comments, setComments] = useState([]);
  const [activeComment, setActiveComment] = useState(null);
  const [guestName, setGuestName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) || '');
  const playerRef = useRef(null);

  useEffect(() => {
    fetch(`/api/review/${token}`)
      .then(async r => {
        if (r.status === 404) { setStatus('notfound'); return null; }
        if (!r.ok) { setStatus('gone'); return null; }
        return r.json();
      })
      .then(v => { if (v) { setVideo(v); setStatus('ok'); } })
      .catch(() => setStatus('gone'));
  }, [token]);

  useEffect(() => {
    if (status !== 'ok') return;
    fetch(`/api/review/${token}/comments`).then(r => r.json()).then(setComments).catch(console.error);
  }, [status, token]);

  const handleSubmit = async ({ content, timestampSec, timestampEnd, annotations }) => {
    if (!guestName.trim()) throw new Error('Escribí tu nombre arriba del video antes de comentar');
    const res = await fetch(`/api/review/${token}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content, timestamp_sec: timestampSec, timestamp_end: timestampEnd,
        guest_name: guestName, annotation: annotations.length > 0 ? JSON.stringify(annotations) : null
      })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error al enviar');
    const comment = await res.json();
    localStorage.setItem(GUEST_NAME_KEY, guestName.trim());
    setComments(prev => [...prev, comment].sort((a, b) => a.timestamp_sec - b.timestamp_sec));
  };

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
          <span>🎬</span><span>Revisión de video</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>{video.title}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: video.project_color, flexShrink: 0 }} />
              <span>{video.project_name}{video.client_name ? ` · ${video.client_name}` : ''}</span>
            </div>
          </div>
          <input className="input" placeholder="Tu nombre (para tus comentarios)" value={guestName}
            onChange={e => setGuestName(e.target.value)} maxLength={60} style={{ width: 240 }} />
        </div>

        <div style={{ height: 560, display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: 20 }}>
          <VideoPlayerAnnotator
            ref={playerRef}
            src={`/api/review/${token}/file`}
            comments={comments}
            activeComment={activeComment}
            onActiveCommentChange={setActiveComment}
            allowAttachments={false}
            onSubmit={handleSubmit}
          />
        </div>

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Comentarios {comments.length > 0 ? `(${comments.length})` : ''}
        </div>
        {comments.length === 0 && (
          <div className="empty"><div className="empty-icon">💬</div><p>Pausá el video para dejar el primer comentario</p></div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {comments.map(c => (
            <div key={c.id} className="list-row" onClick={() => playerRef.current?.jumpToComment(c)}>
              <span className="badge" style={{ fontWeight: 700, background: 'var(--accent-glow)', color: 'var(--accent2)', flexShrink: 0 }}>
                {c.timestamp_end != null ? `${formatTime(c.timestamp_sec)}–${formatTime(c.timestamp_end)}` : formatTime(c.timestamp_sec)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>
                  {c.guest_name}{c.annotation && <span style={{ color: 'var(--yellow)' }}> · ✏️ incluye dibujo</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>{c.content}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
