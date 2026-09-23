import { useState, useEffect, useRef } from 'react';
import VideoPlayerAnnotator, { formatTime } from './VideoPlayerAnnotator';

// Extraído de PublicReview.jsx para que el portal por cliente (ClientReview.jsx) pueda mostrar
// el mismo reproductor+comentarios+aprobar sobre CUALQUIER video, sin duplicar esta lógica —
// ambos le pasan un `apiBase` distinto (uno resuelve por token de video, el otro por token de
// cliente + id de video) pero la forma de las 4 rutas (metadata, /file, /comments, /approve) es
// idéntica en los dos casos (ver server/routes/shares.js). `onBack`, si viene, agrega un botón
// para volver a la lista — PublicReview.jsx (un solo video por link) no lo necesita.
const GUEST_NAME_KEY = 'agencyos_guest_name';

export default function VideoReviewPane({ apiBase, onBack }) {
  const [status, setStatus] = useState('loading'); // loading | ok | notfound | gone
  const [video, setVideo] = useState(null);
  const [comments, setComments] = useState([]);
  const [activeComment, setActiveComment] = useState(null);
  const [guestName, setGuestName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) || '');
  const playerRef = useRef(null);

  useEffect(() => {
    setStatus('loading');
    setVideo(null);
    setComments([]);
    fetch(apiBase)
      .then(async r => {
        if (r.status === 404) { setStatus('notfound'); return null; }
        if (!r.ok) { setStatus('gone'); return null; }
        return r.json();
      })
      .then(v => { if (v) { setVideo(v); setStatus('ok'); } })
      .catch(() => setStatus('gone'));
  }, [apiBase]);

  useEffect(() => {
    if (status !== 'ok') return;
    fetch(`${apiBase}/comments`).then(r => r.json()).then(setComments).catch(console.error);
  }, [status, apiBase]);

  const handleSubmit = async ({ content, timestampSec, timestampEnd, annotations }) => {
    if (!guestName.trim()) throw new Error('Escribí tu nombre arriba del video antes de comentar');
    const res = await fetch(`${apiBase}/comments`, {
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
    // Mismo criterio que el servidor: un comentario nuevo invalida una aprobación previa —
    // se refleja al toque acá para no mostrar "Aprobado" mientras el comentario recién se envió.
    setVideo(prev => ({ ...prev, approved_at: null, approved_by_name: null }));
  };

  const handleApprove = async () => {
    if (!guestName.trim()) throw new Error('Escribí tu nombre arriba del video antes de aprobar');
    const res = await fetch(`${apiBase}/approve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_name: guestName })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error al aprobar');
    localStorage.setItem(GUEST_NAME_KEY, guestName.trim());
    setVideo(prev => ({ ...prev, approved_at: new Date().toISOString(), approved_by_name: guestName.trim() }));
  };

  const handleUnapprove = async () => {
    const res = await fetch(`${apiBase}/approve`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error al quitar la aprobación');
    setVideo(prev => ({ ...prev, approved_at: null, approved_by_name: null }));
  };

  if (status === 'loading') {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}><div className="spinner" /></div>;
  }

  if (status === 'notfound' || status === 'gone') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 24px' }}>
        <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-lg)', fontWeight: 800, marginBottom: 8 }}>
            {status === 'notfound' ? 'Este video no existe' : 'Este video ya no está disponible'}
          </h1>
          <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text2)', lineHeight: 'var(--lh-normal)' }}>
            Pedile a la agencia que te comparta un link nuevo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          {onBack && (
            <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--accent2)', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              ← Volver a mis proyectos
            </button>
          )}
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>{video.title}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: video.project_color, flexShrink: 0 }} />
            <span>{video.project_name}{video.client_name ? ` · ${video.client_name}` : ''}</span>
          </div>
        </div>
        <input className="input" placeholder="Tu nombre (para tus comentarios)" value={guestName}
          onChange={e => setGuestName(e.target.value)} maxLength={60} style={{ width: 240 }} />
      </div>

      <div style={{ position: 'relative', height: 560, display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: 8 }}>
        <VideoPlayerAnnotator
          ref={playerRef}
          src={`${apiBase}/file`}
          comments={comments}
          activeComment={activeComment}
          onActiveCommentChange={setActiveComment}
          allowAttachments={false}
          approvedAt={video.approved_at}
          approvedByName={video.approved_by_name}
          onApprove={handleApprove}
          onUnapprove={handleUnapprove}
          onSubmit={handleSubmit}
        />
      </div>

      {/* Descarga del archivo final, siempre disponible — decisión explícita del usuario: sin
          marca de agua ni condición de pago, porque solo comparte este link con clientes de
          confianza. `?download=1` hace que el servidor fuerce Content-Disposition: attachment
          (ver serveFile en server/index.js) en vez de sólo redirigir al mismo stream que usa el
          <video> de arriba. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <a href={`${apiBase}/file?download=1`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--accent2)', background: 'var(--accent-glow)', padding: '6px 12px', borderRadius: 8, textDecoration: 'none', fontWeight: 600 }}>
          ⬇ Descargar video
        </a>
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
  );
}
