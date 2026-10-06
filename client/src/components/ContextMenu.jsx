import { useEffect, useRef, useState } from 'react';

// Menú flotante de clic derecho — genérico, usado hoy sobre videos ("Videos del proyecto" y
// /videos) y tareas (tablero kanban). `items` ya viene filtrado por permiso por quien llama (cada
// página sabe qué puede hacer el usuario sobre ese ítem en particular). Cada item es
// { label, icon, onClick } o { label, icon, href } (ej. "Descargar", un link real) o
// { label, icon, submenu: [{ label, onClick }] } para un nivel más (ej. "Mover a ▸ En progreso").
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  // null = nivel raíz. Si no es null, es el array de items del submenú actualmente abierto — se
  // reemplaza la lista entera en vez de un flyout lateral, así funciona igual con mouse y con
  // touch (un flyout por hover no existe en celular).
  const [submenu, setSubmenu] = useState(null);

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

  const shown = submenu ?? items;
  // Clamp simple contra el borde de la ventana — el menú es angosto y de alto conocido de
  // antemano (items.length * una fila fija), así que alcanza sin medir el DOM en un segundo render.
  // Se usa items.length (no shown.length) para el cálculo de `top` porque el submenú puede sumar
  // una fila de "← Volver": si el clamp se recalculara con shown.length, el menú "saltaría" de
  // posición vertical al entrar/salir del submenú.
  const MENU_WIDTH = 190;
  const rowCount = items.length + (submenu ? 1 : 0);
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rowCount * 34 - 16));

  const itemStyleFor = (item) => ({ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', fontSize: 12.5, color: item.danger ? 'var(--red)' : 'var(--text)', background: 'transparent', border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', textDecoration: 'none', boxSizing: 'border-box' });
  const hoverProps = {
    onMouseEnter: e => e.currentTarget.style.background = 'var(--bg4)',
    onMouseLeave: e => e.currentTarget.style.background = 'transparent',
  };
  // Columna de ancho fijo para el ícono — sin esto, un ícono SVG (13x13, con su propio padding
  // interno) y un emoji (ancho variable según fuente del sistema) quedan con espaciados distintos
  // frente al texto aunque el `gap` del flex sea el mismo.
  const iconWrap = (icon) => <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, flexShrink: 0 }}>{icon}</span>;

  return (
    <div ref={ref} role="menu"
      style={{ position: 'fixed', left, top, zIndex: 100, minWidth: MENU_WIDTH, background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', padding: 4 }}>
      {submenu && (
        <button role="menuitem" onClick={() => setSubmenu(null)} style={{ ...itemStyleFor({}), color: 'var(--text3)' }} {...hoverProps}>
          {iconWrap('←')} Volver
        </button>
      )}
      {shown.map((item, i) => {
        if (item.submenu) {
          return (
            <button key={i} role="menuitem" onClick={() => setSubmenu(item.submenu)} style={itemStyleFor(item)} {...hoverProps}>
              {iconWrap(item.icon)}{item.label}
              <span style={{ marginLeft: 'auto', color: 'var(--text3)' }}>▸</span>
            </button>
          );
        }
        return item.href ? (
          <a key={i} role="menuitem" href={item.href} onClick={onClose} style={itemStyleFor(item)} {...hoverProps}>
            {iconWrap(item.icon)}{item.label}
          </a>
        ) : (
          <button key={i} role="menuitem" onClick={() => { onClose(); item.onClick(); }} style={itemStyleFor(item)} {...hoverProps}>
            {iconWrap(item.icon)}{item.label}
          </button>
        );
      })}
    </div>
  );
}
