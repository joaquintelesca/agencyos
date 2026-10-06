import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';
import useModalA11y from '../hooks/useModalA11y';

// Modal chico para renombrar desde el menú de clic derecho (tarjeta/fila) — distinto del input
// inline que ya existe en la barra del reproductor (VideoReview.jsx), que solo tiene sentido ahí
// porque ya está parado sobre ese video en particular. Acá, en una grilla de muchas tarjetas, un
// modal es más claro que abrir un input flotando sobre la tarjeta.
export default function RenameVideoModal({ video, onClose, onRenamed }) {
  const { api } = useAuth();
  const { alert } = useAlert();
  const [title, setTitle] = useState(video.title);
  const [busy, setBusy] = useState(false);
  const modalRef = useModalA11y(true, onClose);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === video.title) { onClose(); return; }
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}/rename`, { method: 'PATCH', body: { title: trimmed } });
      onRenamed(trimmed);
      onClose();
    } catch (e) { console.error(e); await alert('No se pudo renombrar el video: ' + e.message); setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="rename-modal-title">
        <button className="modal-close" onClick={onClose} title="Cerrar" aria-label="Cerrar">✕</button>
        <h2 id="rename-modal-title">Renombrar video</h2>
        <div className="form-group">
          <label>Nombre</label>
          <input autoFocus className="input" value={title} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Guardando...' : 'Guardar'}</button>
        </div>
      </div>
    </div>
  );
}
