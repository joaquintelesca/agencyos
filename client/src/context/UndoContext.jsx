import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';

const UndoContext = createContext();
export const useUndo = () => useContext(UndoContext);

const UNDO_WINDOW_MS = 6000;

// Deshacer un borrado, no un historial de acciones genérico: al borrar algo, se saca de la UI
// al toque pero el DELETE real al servidor se pospone unos segundos — si nadie lo deshace en
// ese lapso, recién ahí se confirma. Si se deshace, nunca se llegó a tocar el servidor.
// Se usa una ref (no solo state) como fuente de verdad de "qué hay pendiente" para que
// scheduleDelete/undo tengan referencias estables y no dependan de closures con state viejo.
export function UndoProvider({ children }) {
  const [pending, setPending] = useState(null); // solo para renderizar el toast
  const pendingRef = useRef(null);
  const timerRef = useRef(null);

  const commitPending = useCallback((entry) => {
    pendingRef.current = null;
    setPending(null);
    clearTimeout(timerRef.current);
    entry.onCommit().catch(e => console.error('No se pudo confirmar la eliminación:', e));
  }, []);

  const scheduleDelete = useCallback((label, { onCommit, onUndo }) => {
    // Si ya había un borrado pendiente (deshacer no alcanzó a apretarse), se confirma de una
    // antes de reemplazarlo — nunca se pisan entre sí ni quedan huérfanos sin confirmar.
    if (pendingRef.current) commitPending(pendingRef.current);
    const entry = { label, onCommit, onUndo };
    pendingRef.current = entry;
    setPending(entry);
    timerRef.current = setTimeout(() => commitPending(entry), UNDO_WINDOW_MS);
  }, [commitPending]);

  const undo = useCallback(() => {
    const entry = pendingRef.current;
    if (!entry) return;
    pendingRef.current = null;
    setPending(null);
    clearTimeout(timerRef.current);
    entry.onUndo();
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      const isUndoShortcut = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
      // Si no hay nada pendiente, no tocamos el evento — así no se rompe el undo nativo
      // del navegador dentro de inputs/textareas mientras se está escribiendo.
      if (isUndoShortcut && pendingRef.current) { e.preventDefault(); undo(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo]);

  return (
    <UndoContext.Provider value={{ scheduleDelete }}>
      {children}
      {pending && (
        <div style={{
          position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10,
          padding: '10px 12px 10px 16px', display: 'flex', alignItems: 'center', gap: 16,
          zIndex: 9999, boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
        }}>
          <span style={{ fontSize: 13, color: 'var(--text)' }}>{pending.label}</span>
          <button className="icon-btn" onClick={undo} style={{
            color: 'var(--accent2)', fontWeight: 600,
            fontSize: 13, padding: '4px 8px'
          }}>Deshacer <span style={{ opacity: 0.6, fontWeight: 400 }}>{navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'}</span></button>
        </div>
      )}
    </UndoContext.Provider>
  );
}
