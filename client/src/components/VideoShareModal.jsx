import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';
import useModalA11y from '../hooks/useModalA11y';

// Extraído de VideoReview.jsx para poder abrirlo también desde el menú de clic derecho de
// VideosDashboard.jsx (donde no hay un "selectedVideo" en contexto, solo el id del video sobre el
// que se hizo clic) — /api/videos/:id/share ya es un endpoint por video, no anidado bajo proyecto,
// así que alcanza con pasarle el videoId para que funcione desde cualquier lugar.
export default function VideoShareModal({ videoId, onClose }) {
  const { api } = useAuth();
  const { alert, confirm } = useAlert();
  const [share, setShare] = useState(undefined); // undefined = sin cargar, null = sin link activo
  const [shareDays, setShareDays] = useState(30);
  const [shareBusy, setShareBusy] = useState(false);
  const modalRef = useModalA11y(true, onClose);

  useEffect(() => {
    let cancelled = false;
    api(`/api/videos/${videoId}/share`).then(s => { if (!cancelled) setShare(s); }).catch(e => { console.error(e); if (!cancelled) setShare(null); });
    return () => { cancelled = true; };
  }, [videoId]);

  const createShare = async () => {
    setShareBusy(true);
    try {
      setShare(await api(`/api/videos/${videoId}/share`, { method: 'POST', body: { expiresInDays: shareDays } }));
    } catch (e) { console.error(e); await alert('No se pudo generar el link: ' + e.message); }
    finally { setShareBusy(false); }
  };

  const revokeShare = async () => {
    if (!share || !await confirm('¿Desactivar este link? El cliente ya no va a poder abrirlo.', { confirmText: 'Desactivar', danger: true })) return;
    setShareBusy(true);
    try {
      await api(`/api/video-shares/${share.id}/revoke`, { method: 'PATCH' });
      setShare(null);
    } catch (e) { console.error(e); await alert('No se pudo desactivar el link: ' + e.message); }
    finally { setShareBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
        <button className="modal-close" onClick={onClose} title="Cerrar" aria-label="Cerrar">✕</button>
        <h2 id="share-modal-title">Compartir con el cliente</h2>
        {share === undefined && <div style={{ padding: '20px 0', textAlign: 'center' }}><div className="spinner" /></div>}
        {share === null && (
          <>
            <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text2)', lineHeight: 'var(--lh-normal)', marginBottom: 16 }}>
              Se genera un link público para este video puntual — sin cuenta ni contraseña, el cliente puede verlo y dejar comentarios con timestamp igual que acá. No ve otros videos, tareas ni información de pago.
            </p>
            <div className="form-group">
              <label>Vence en</label>
              <select className="input" value={shareDays} onChange={e => setShareDays(Number(e.target.value))}>
                <option value={7}>7 días</option>
                <option value={30}>30 días</option>
                <option value={90}>90 días</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
              <button className="btn btn-primary" onClick={createShare} disabled={shareBusy}>{shareBusy ? 'Generando...' : 'Generar link'}</button>
            </div>
          </>
        )}
        {share && (
          <>
            <div className="form-group">
              <label>Link para el cliente</label>
              <input className="input" readOnly value={`${window.location.origin}/review/${share.id}`}
                onClick={e => e.target.select()} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span className="badge" style={{ fontWeight: 500, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>✓ Activo</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>vence el {new Date(share.expires_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-danger" onClick={revokeShare} disabled={shareBusy}>Desactivar</button>
              <button className="btn btn-primary" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/review/${share.id}`); }}>Copiar link</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
