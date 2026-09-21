import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Ningún modal de la app tenía manejo de teclado: no se podía cerrar con Escape, Tab se escapaba
// hacia elementos tapados detrás del overlay, y al cerrar el foco quedaba perdido en vez de volver
// a lo que lo abrió. Este hook centraliza las tres cosas — se engancha al contenedor del modal
// (el div con className="modal", no el overlay) vía el ref que devuelve.
export default function useModalA11y(isOpen, onClose) {
  const containerRef = useRef(null);
  const previouslyFocused = useRef(null);
  // El caller casi siempre pasa un arrow function inline (`() => setX(false)`), que es una
  // identidad nueva en cada render del padre — si `onClose` estuviera en el array de deps de abajo,
  // cualquier re-render del padre mientras el modal está abierto (tipear en un input, por ejemplo)
  // desmontaría y remontaría este efecto, recapturando "foco anterior" con el valor YA CAMBIADO
  // (el propio input del modal) en vez del elemento que lo abrió. Este ref lo evita.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // Capturado durante el RENDER (no en un efecto) del toggle false→true: React ejecuta el cuerpo
  // de la función bastante antes de confirmar el DOM nuevo, así que acá todavía no existe el modal
  // ni corrió ningún autoFocus suyo — es el único momento en que document.activeElement es
  // confiablemente "lo que tenía foco antes de abrir esto". Capturarlo en un useEffect, en cambio,
  // corre DESPUÉS del commit, cuando un input con autoFocus ya se robó el foco — terminaría
  // guardando el propio input del modal como "elemento anterior" en vez del botón que lo abrió.
  const wasOpenRef = useRef(false);
  if (isOpen && !wasOpenRef.current) previouslyFocused.current = document.activeElement;
  wasOpenRef.current = isOpen;

  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    // Varios modales ya traían un input con autoFocus (corre en el commit, antes que este efecto)
    // — si ya hay foco puesto adentro, respetarlo en vez de pisarlo con "el primer focusable", que
    // muchas veces termina siendo el botón ✕ de cerrar en vez del campo que tiene sentido llenar.
    if (!container?.contains(document.activeElement)) {
      const focusables = container ? Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)) : [];
      (focusables[0] || container)?.focus();
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !container) return;
      const items = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(el => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen]);

  return containerRef;
}
