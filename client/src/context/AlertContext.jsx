import { createContext, useContext, useCallback, useState, useRef } from 'react';

const AlertContext = createContext();
export const useAlert = () => useContext(AlertContext);

// Reemplaza a window.alert()/window.confirm() en toda la app — esos diálogos nativos del
// navegador no se pueden estilar y rompen la identidad visual de la app (ver también
// .modal-overlay/.modal en index.css, mismo criterio ya aplicado a todas las confirmaciones).
// alert()/confirm() acá devuelven una Promise, así que los call sites que antes hacían
// `if (confirm(...))` pasan a `if (await confirm(...))`.
export function AlertProvider({ children }) {
  const [modal, setModal] = useState(null);
  const resolveRef = useRef(null);

  const close = useCallback((result) => {
    if (resolveRef.current) resolveRef.current(result);
    resolveRef.current = null;
    setModal(null);
  }, []);

  const alertFn = useCallback((message) => {
    return new Promise(resolve => {
      resolveRef.current = resolve;
      setModal({ message, isConfirm: false });
    });
  }, []);

  const confirmFn = useCallback((message, opts = {}) => {
    return new Promise(resolve => {
      resolveRef.current = resolve;
      setModal({ message, isConfirm: true, confirmText: opts.confirmText || 'Confirmar', cancelText: opts.cancelText || 'Cancelar', danger: !!opts.danger });
    });
  }, []);

  return (
    <AlertContext.Provider value={{ alert: alertFn, confirm: confirmFn }}>
      {children}
      {modal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <button className="modal-close" onClick={() => close(false)}>✕</button>
            <p style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{modal.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              {modal.isConfirm && <button className="btn btn-ghost" onClick={() => close(false)}>{modal.cancelText}</button>}
              <button className={`btn ${modal.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
                {modal.isConfirm ? modal.confirmText : 'Entendido'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AlertContext.Provider>
  );
}
