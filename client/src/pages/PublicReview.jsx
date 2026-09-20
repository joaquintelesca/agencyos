import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAlert } from '../context/AlertContext';

// Página pública, sin sesión: fuera de <AuthProvider>/<PrivateRoute>, por eso no usa el api()
// de AuthContext (asume un token de sesión que acá no existe) — fetch directo a rutas propias
// que no pasan por el middleware `auth` del servidor (ver server/index.js, sección VIDEO SHARES).
const GUEST_NAME_KEY = 'agencyos_guest_name';

function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export default function PublicReview() {
  const { token } = useParams();
  const { alert } = useAlert();
  const [status, setStatus] = useState('loading'); // loading | ok | notfound | gone
  const [errorMsg, setErrorMsg] = useState('');
  const [video, setVideo] = useState(null);
  const [comments, setComments] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [composing, setComposing] = useState(false);
  const [content, setContent] = useState('');
  const [guestName, setGuestName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) || '');
  const [sending, setSending] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    fetch(`/api/review/${token}`)
      .then(async r => {
        if (r.status === 404) { setStatus('notfound'); return null; }
        if (r.status === 410) { const d = await r.json().catch(() => ({})); setErrorMsg(d.error || ''); setStatus('gone'); return null; }
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

  const openComposer = () => {
    videoRef.current?.pause();
    setComposing(true);
  };

  const submitComment = async (e) => {
    e.preventDefault();
    if (!content.trim() || !guestName.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/review/${token}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, timestamp_sec: currentTime, guest_name: guestName })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error al enviar');
      const comment = await res.json();
      localStorage.setItem(GUEST_NAME_KEY, guestName.trim());
      setComments(prev => [...prev, comment].sort((a, b) => a.timestamp_sec - b.timestamp_sec));
      setContent('');
      setComposing(false);
    } catch (err) {
      await alert(err.message);
    } finally {
      setSending(false);
    }
  };

  const seekTo = (t) => {
    if (videoRef.current) { videoRef.current.currentTime = t; videoRef.current.play(); }
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
      <div style={{ width: '100%', maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
          <span>🎬</span><span>Revisión de video</span>
        </div>

        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>{video.title}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: video.project_color, flexShrink: 0 }} />
          <span>{video.project_name}{video.client_name ? ` · ${video.client_name}` : ''}</span>
        </div>

        <video
          ref={videoRef}
          src={`/api/review/${token}/file`}
          controls
          onTimeUpdate={e => setCurrentTime(e.target.currentTime)}
          style={{ width: '100%', borderRadius: 'var(--radius-lg)', background: '#000', marginBottom: 12 }}
        />

        <button className="btn btn-primary" onClick={openComposer} style={{ marginBottom: 20 }}>
          💬 Comentar en {formatTime(currentTime)}
        </button>

        {composing && (
          <form onSubmit={submitComment} className="card" style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text3)' }}>Comentario en <strong style={{ color: 'var(--accent2)' }}>{formatTime(currentTime)}</strong></div>
            <input className="input" placeholder="Tu nombre" value={guestName} onChange={e => setGuestName(e.target.value)} required maxLength={60} />
            <textarea className="input" placeholder="¿Qué te parece este momento?" value={content} onChange={e => setContent(e.target.value)} required autoFocus />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setComposing(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={sending}>{sending ? 'Enviando...' : 'Enviar'}</button>
            </div>
          </form>
        )}

        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Comentarios {comments.length > 0 ? `(${comments.length})` : ''}
        </div>
        {comments.length === 0 && (
          <div className="empty"><div className="empty-icon">💬</div><p>Todavía no hay comentarios</p></div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {comments.map(c => (
            <div key={c.id} className="list-row" onClick={() => seekTo(c.timestamp_sec)}>
              <span className="badge" style={{ fontWeight: 700, background: 'var(--accent-glow)', color: 'var(--accent2)', flexShrink: 0 }}>{formatTime(c.timestamp_sec)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{c.guest_name}</div>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>{c.content}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
