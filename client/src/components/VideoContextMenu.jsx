import { useEffect, useRef } from 'react';

// Menú flotante de clic derecho sobre un video (tarjeta o fila, tanto en "Videos del proyecto"
// como en /videos) — mismas acciones que ya existían dentro del reproductor (renombrar, descargar,
// compartir, eliminar) pero sin tener que abrirlo primero. `items` ya viene filtrado por permiso
// por quien llama (cada página sabe si el usuario es admin o quien subió ese video en particular).
export default function VideoContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDocMouseDown = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onClose, true);
    document.addEventListener('contextmenu', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onClose, true);
      document.removeEventListener('contextmenu', onClose, true);
    };
  }, [onClose]);

  // Clamp simple contra el borde de la ventana — el menú es angosto y de alto conocido de
  // antemano (items.length * una fila fija), así que alcanza sin medir el DOM en un segundo render.
  const MENU_WIDTH = 190;
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - items.length * 34 - 16));

  return (
    <div ref={ref} role="menu"
      style={{ position: 'fixed', left, top, zIndex: 100, minWidth: MENU_WIDTH, background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', padding: 4 }}>
      {items.map((item, i) => {
        const itemStyle = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', fontSize: 12.5, color: item.danger ? 'var(--red)' : 'var(--text)', background: 'transparent', border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', textDecoration: 'none', boxSizing: 'border-box' };
        const hoverProps = {
          onMouseEnter: e => e.currentTarget.style.background = 'var(--bg4)',
          onMouseLeave: e => e.currentTarget.style.background = 'transparent',
        };
        return item.href ? (
          <a key={i} role="menuitem" href={item.href} onClick={onClose} style={itemStyle} {...hoverProps}>
            {item.icon}{item.label}
          </a>
        ) : (
          <button key={i} role="menuitem" onClick={() => { onClose(); item.onClick(); }} style={itemStyle} {...hoverProps}>
            {item.icon}{item.label}
          </button>
        );
      })}
    </div>
  );
}
