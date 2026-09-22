import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';
import { deadlineLabel } from '../utils/format';
import useNarrowViewport from '../hooks/useNarrowViewport';
import useModalA11y from '../hooks/useModalA11y';
import Icon from '../components/Icon';

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MAX_VISIBLE_PER_DAY_MONTH = 3;
const MAX_VISIBLE_PER_DAY_WEEK = 8;
const EVENT_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
const LONG_PRESS_MS = 350;
const MOVE_CANCEL_PX = 10;

// Fecha local en formato YYYY-MM-DD — evitar toISOString() acá a propósito: convierte a UTC
// primero, así que cerca de medianoche puede devolver el día equivocado según el timezone local.
function toDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Grilla de exactamente las semanas que hacen falta para cubrir el mes (5 o 6 filas según el mes),
// arrancando el domingo anterior al día 1 y terminando el sábado siguiente al último día.
function getMonthGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startDay = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDay + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - startDay);
  const days = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }
  return days;
}

function getWeekGrid(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay()); // domingo de esa semana
  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  return days;
}

export default function CalendarPage() {
  const { api, user } = useAuth();
  const { alert, confirm } = useAlert();
  const isNarrowViewport = useNarrowViewport();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const [viewMode, setViewMode] = useState('month'); // month | week
  const [viewDate, setViewDate] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [dayModal, setDayModal] = useState(null); // dateKey | null
  const [chipModal, setChipModal] = useState(null); // { type: 'project'|'event', data } | null
  const [draggedProjectId, setDraggedProjectId] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null); // dateKey | 'undated' | null, solo para resaltar el destino
  const [clientFilter, setClientFilter] = useState('all');
  const [editorFilter, setEditorFilter] = useState('all');
  const [events, setEvents] = useState([]);
  const [showNewEvent, setShowNewEvent] = useState(null); // dateKey prellenado, o null si el modal está cerrado
  const [newEventForm, setNewEventForm] = useState({ title: '', date: '', color: EVENT_COLORS[0] });
  const [showFeedModal, setShowFeedModal] = useState(false);
  const [feedUrl, setFeedUrl] = useState(null);
  const [feedLoading, setFeedLoading] = useState(false);

  // El drag-and-drop nativo (draggable/onDragStart) no dispara en touch — mismo patrón de
  // long-press que ya se usó para apilar videos: mantener 350ms sin moverse activa el arrastre,
  // después se sigue el dedo con elementFromPoint. justDraggedRef evita que el "click" fantasma
  // que dispara el navegador al soltar el touch abra el modal en vez de soltar el drag.
  const touchStartRef = useRef({ x: 0, y: 0, projectId: null });
  const dragActiveRef = useRef(false);
  const longPressTimerRef = useRef(null);
  const justDraggedRef = useRef(false);

  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  useEffect(() => {
    api('/api/calendar-events').then(setEvents).catch(console.error);
  }, [api]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const days = useMemo(
    () => viewMode === 'week' ? getWeekGrid(viewDate) : getMonthGrid(year, month),
    [viewMode, viewDate, year, month]
  );

  const clientOptions = useMemo(() => {
    const map = new Map();
    // client_name puede venir vacío si el cliente fue borrado pero el proyecto lo sigue
    // referenciando (mismo caso que el editor borrado en otras partes de la app).
    projects.forEach(p => { if (p.client_id && !map.has(p.client_id)) map.set(p.client_id, { id: p.client_id, name: p.client_name || 'Cliente eliminado', color: p.client_color }); });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects]);
  const editorOptions = useMemo(() => {
    const map = new Map();
    projects.forEach(p => { if (p.payment_editor_id && !map.has(p.payment_editor_id)) map.set(p.payment_editor_id, { id: p.payment_editor_id, name: p.payment_editor_name }); });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects]);

  const filteredProjects = useMemo(() => projects.filter(p =>
    (clientFilter === 'all' || p.client_id === clientFilter) &&
    (editorFilter === 'all' || p.payment_editor_id === editorFilter)
  ), [projects, clientFilter, editorFilter]);

  // Por ahora el calendario muestra deadlines de proyecto + eventos propios (no fechas límite de
  // tarea, a pedido explícito). Un proyecto ya terminado no aporta su deadline acá, mismo criterio
  // que el Dashboard: ya no es información accionable.
  const eventsByDay = useMemo(() => {
    const map = {};
    filteredProjects.forEach(p => {
      if (p.deadline && p.status !== 'completed') {
        (map[p.deadline] = map[p.deadline] || { projects: [], events: [] }).projects.push(p);
      }
    });
    events.forEach(ev => {
      (map[ev.date] = map[ev.date] || { projects: [], events: [] }).events.push(ev);
    });
    return map;
  }, [filteredProjects, events]);

  // Proyectos activos sin deadline — no tienen dónde plotearse en la grilla, se listan acá en vez
  // de desaparecer del calendario. También es el destino de "arrastrar para sacarle la fecha".
  const undated = useMemo(() => filteredProjects.filter(p => !p.deadline && p.status !== 'completed'), [filteredProjects]);

  const todayKey = toDateKey(new Date());
  const periodLabel = viewMode === 'week'
    ? (() => {
        const start = days[0], end = days[6];
        const sameMonth = start.getMonth() === end.getMonth();
        const startLbl = start.toLocaleDateString('es', { day: 'numeric', month: sameMonth ? undefined : 'short' });
        const endLbl = end.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
        return `${startLbl} – ${endLbl}`;
      })()
    : viewDate.toLocaleDateString('es', { month: 'long', year: 'numeric' });

  const goToPeriod = (delta) => setViewDate(d => {
    const nd = new Date(d);
    if (viewMode === 'week') nd.setDate(nd.getDate() + delta * 7);
    else nd.setMonth(nd.getMonth() + delta);
    return nd;
  });
  const goToToday = () => { const d = new Date(); if (viewMode === 'month') d.setDate(1); setViewDate(d); };

  // ─── Drag and drop (solo admin — mismo permiso que editar el deadline desde "Editar proyecto") ──
  // Mismo criterio que el Kanban de Project.jsx: se trackea en estado de React qué se está
  // arrastrando, no con dataTransfer — más simple para este caso de uso.
  const applyDrop = async (projectId, newDate) => {
    const project = projects.find(p => p.id === projectId);
    if (!project || project.deadline === newDate) return; // soltó en el mismo lugar
    try {
      // El PUT de proyecto espera el objeto completo (no un patch parcial) — mandar solo
      // {deadline} pisaría a null el resto de los campos que ese endpoint sí sobreescribe siempre
      // (nombre, status, tipo de pago, etc.).
      await api(`/api/projects/${projectId}`, { method: 'PUT', body: { ...project, deadline: newDate } });
      // No hace falta actualizar el estado acá a mano: el socket 'project:updated' ya refresca
      // `projects` (compartido vía Outlet) en Layout.jsx, igual que en el resto de la app.
    } catch (e) {
      console.error(e);
      await alert('No se pudo mover el deadline: ' + e.message);
    }
  };

  const onDropOnDay = (dateKey) => {
    setDragOverKey(null);
    const projectId = draggedProjectId;
    setDraggedProjectId(null);
    if (projectId) applyDrop(projectId, dateKey);
  };

  const onDropOnUndated = () => {
    setDragOverKey(null);
    const projectId = draggedProjectId;
    setDraggedProjectId(null);
    if (projectId) applyDrop(projectId, null);
  };

  const touchDragProps = (projectId) => ({
    'data-project-id': projectId,
    onTouchStart: (e) => {
      if (!isAdmin || e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStartRef.current = { x: t.clientX, y: t.clientY, projectId };
      dragActiveRef.current = false;
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        dragActiveRef.current = true;
        setDraggedProjectId(projectId);
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e) => {
      if (!isAdmin) return;
      const t = e.touches[0];
      if (!t) return;
      if (!dragActiveRef.current) {
        const dx = t.clientX - touchStartRef.current.x;
        const dy = t.clientY - touchStartRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clearTimeout(longPressTimerRef.current);
        return;
      }
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const dropEl = el?.closest('[data-drop-key]');
      setDragOverKey(dropEl?.getAttribute('data-drop-key') || null);
    },
    onTouchEnd: (e) => {
      if (!isAdmin) return;
      clearTimeout(longPressTimerRef.current);
      if (dragActiveRef.current) {
        justDraggedRef.current = true;
        setTimeout(() => { justDraggedRef.current = false; }, 300);
        const t = e.changedTouches[0];
        const el = t && document.elementFromPoint(t.clientX, t.clientY);
        const dropEl = el?.closest('[data-drop-key]');
        const key = dropEl?.getAttribute('data-drop-key');
        setDragOverKey(null);
        setDraggedProjectId(null);
        if (key === 'undated') applyDrop(projectId, null);
        else if (key) applyDrop(projectId, key);
      }
      dragActiveRef.current = false;
    },
  });

  const openProjectChip = (p) => {
    if (justDraggedRef.current) return;
    if (isAdmin) setChipModal({ type: 'project', data: p });
    else navigate(`/project/${p.id}`);
  };

  const createEvent = async () => {
    if (!newEventForm.title.trim() || !newEventForm.date) return;
    try {
      const ev = await api('/api/calendar-events', { method: 'POST', body: newEventForm });
      setEvents(prev => [...prev, ev]);
      setShowNewEvent(null);
      setNewEventForm({ title: '', date: '', color: EVENT_COLORS[0] });
    } catch (e) { console.error(e); await alert('No se pudo crear el evento: ' + e.message); }
  };

  const deleteEvent = async (ev) => {
    if (!await confirm(`¿Borrar el evento "${ev.title}"?`, { confirmText: 'Borrar', danger: true })) return;
    try {
      await api(`/api/calendar-events/${ev.id}`, { method: 'DELETE' });
      setEvents(prev => prev.filter(e => e.id !== ev.id));
      setChipModal(null);
    } catch (e) { console.error(e); await alert('No se pudo borrar el evento: ' + e.message); }
  };

  const openFeedModal = async () => {
    setShowFeedModal(true);
    if (feedUrl) return;
    setFeedLoading(true);
    try {
      const { token } = await api('/api/calendar/feed-token');
      // Tiene que ser una URL absoluta — a diferencia del resto de la app, esto lo pega Google/Apple
      // Calendar del lado de SU servidor, no el navegador de quien lo copia, así que una ruta
      // relativa no tiene contra qué origen resolverse. Mismo criterio que API_BASE en AuthContext:
      // si el cliente y la API viven en dominios distintos (VITE_API_URL seteado), usar ese; si no,
      // el origen actual (deploy de un solo servicio, como este en Render).
      const base = import.meta.env.VITE_API_URL || window.location.origin;
      setFeedUrl(`${base}/api/calendar/feed.ics?token=${token}`);
    } catch (e) { console.error(e); await alert('No se pudo generar el link: ' + e.message); }
    finally { setFeedLoading(false); }
  };

  const navBtnStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, width: 28, height: 28, color: 'var(--text2)', cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' };

  const renderChip = (p) => {
    const dl = deadlineLabel(p.deadline);
    return (
      <div key={p.id}
        draggable={isAdmin}
        {...touchDragProps(p.id)}
        onDragStart={() => setDraggedProjectId(p.id)}
        onDragEnd={() => setDraggedProjectId(null)}
        onClick={() => openProjectChip(p)}
        title={p.name}
        style={{
          fontSize: 10.5, padding: '2px 6px', borderRadius: 5, background: `${p.color}2a`, color: p.color,
          borderLeft: dl ? `3px solid ${dl.color}` : '3px solid transparent',
          cursor: isAdmin ? 'grab' : 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          touchAction: draggedProjectId ? 'none' : 'auto',
        }}>
        📌 {p.name}
      </div>
    );
  };

  const renderEventChip = (ev) => (
    <div key={ev.id}
      onClick={() => { if (!justDraggedRef.current) setChipModal({ type: 'event', data: ev }); }}
      title={ev.title}
      style={{
        fontSize: 10.5, padding: '2px 6px', borderRadius: 5, background: `${ev.color}2a`, color: ev.color,
        cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
      📅 {ev.title}
    </div>
  );

  const maxVisible = viewMode === 'week' ? MAX_VISIBLE_PER_DAY_WEEK : MAX_VISIBLE_PER_DAY_MONTH;

  const dayModalRef = useModalA11y(!!dayModal, () => setDayModal(null));
  const chipModalRef = useModalA11y(!!chipModal, () => setChipModal(null));
  const newEventModalRef = useModalA11y(!!showNewEvent, () => setShowNewEvent(null));
  const feedModalRef = useModalA11y(showFeedModal, () => setShowFeedModal(false));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: isNarrowViewport ? 12 : 24, display: 'flex', flexDirection: isNarrowViewport ? 'column' : 'row', gap: isNarrowViewport ? 16 : 20 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, flex: 1, textTransform: 'capitalize' }}>{periodLabel}</h1>
          <div className="tab-switch">
            {[['month', 'Mes'], ['week', 'Semana']].map(([key, lbl]) => (
              <button key={key} className={viewMode === key ? 'active' : ''} onClick={() => {
                // viewDate queda en "día 1 del mes que se estaba viendo" (para la grilla de Mes) —
                // sin este reset, pasar a Semana mostraba la semana que contiene ese día 1, no la
                // semana actual, salvo que justo estuvieras parado en el mes de hoy con día 1.
                if (key === 'week' && viewMode !== 'week') setViewDate(new Date());
                setViewMode(key);
              }}>{lbl}</button>
            ))}
          </div>
          <button onClick={goToToday} className="btn btn-ghost btn-sm">Hoy</button>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => goToPeriod(-1)} style={navBtnStyle} title={viewMode === 'week' ? 'Semana anterior' : 'Mes anterior'} aria-label={viewMode === 'week' ? 'Semana anterior' : 'Mes anterior'}>‹</button>
            <button onClick={() => goToPeriod(1)} style={navBtnStyle} title={viewMode === 'week' ? 'Semana siguiente' : 'Mes siguiente'} aria-label={viewMode === 'week' ? 'Semana siguiente' : 'Mes siguiente'}>›</button>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowNewEvent(toDateKey(new Date()))}><Icon.plus /> Evento</button>
          <button className="btn btn-ghost btn-sm" onClick={openFeedModal}>🔗 Suscribirse</button>
        </div>

        {/* Filtros */}
        {(clientOptions.length > 0 || editorOptions.length > 0) && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {clientOptions.length > 0 && (
              <select className="input" value={clientFilter} onChange={e => setClientFilter(e.target.value)} style={{ fontSize: 12, padding: '5px 10px', width: 'auto' }}>
                <option value="all">Todos los clientes</option>
                {clientOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            {editorOptions.length > 0 && (
              <select className="input" value={editorFilter} onChange={e => setEditorFilter(e.target.value)} style={{ fontSize: 12, padding: '5px 10px', width: 'auto' }}>
                <option value="all">Todos los editores</option>
                {editorOptions.map(ed => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
              </select>
            )}
          </div>
        )}

        {/* Grilla */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', background: 'var(--bg3)' }}>
            {WEEKDAYS.map(w => (
              <div key={w} style={{ padding: isNarrowViewport ? '8px 2px' : '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: isNarrowViewport ? 'center' : 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isNarrowViewport ? w.slice(0, 3) : w}
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))' }}>
            {days.map(d => {
              const key = toDateKey(d);
              const isCurrentMonth = viewMode === 'week' || d.getMonth() === month;
              const isToday = key === todayKey;
              const dayData = eventsByDay[key] || { projects: [], events: [] };
              const allChips = [...dayData.events, ...dayData.projects];
              const visibleEvents = viewMode === 'week' || dayData.events.length <= maxVisible ? dayData.events : dayData.events.slice(0, maxVisible);
              const remainingSlots = Math.max(0, maxVisible - visibleEvents.length);
              const visibleProjects = dayData.projects.slice(0, remainingSlots);
              const extra = allChips.length - visibleEvents.length - visibleProjects.length;
              return (
                <div key={key}
                  data-drop-key={key}
                  onDragOver={e => { if (isAdmin && draggedProjectId) { e.preventDefault(); setDragOverKey(key); } }}
                  onDragLeave={() => setDragOverKey(k => k === key ? null : k)}
                  onDrop={e => { if (isAdmin) { e.preventDefault(); onDropOnDay(key); } }}
                  onDoubleClick={() => setShowNewEvent(key)}
                  style={{
                    minHeight: viewMode === 'week' ? 220 : 96, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
                    padding: 6, background: dragOverKey === key ? 'var(--accent-glow)' : isCurrentMonth ? 'var(--bg2)' : 'var(--bg)',
                    opacity: isCurrentMonth ? 1 : 0.5, boxShadow: dragOverKey === key ? 'inset 0 0 0 2px var(--accent)' : 'none',
                    display: 'flex', flexDirection: 'column', gap: 3, transition: 'background 0.1s'
                  }}>
                  <span style={{
                    fontSize: 11, color: isToday ? '#fff' : 'var(--text3)', background: isToday ? 'var(--accent)' : 'transparent',
                    width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: isToday ? 700 : 400
                  }}>
                    {d.getDate()}
                  </span>
                  {visibleEvents.map(renderEventChip)}
                  {visibleProjects.map(renderChip)}
                  {extra > 0 && (
                    <div onClick={() => setDayModal(key)} style={{ fontSize: 10, color: 'var(--accent2)', cursor: 'pointer', fontWeight: 600 }}>+{extra} más</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sin fecha — siempre visible, incluso vacía, porque es el destino de "sacarle la fecha" a algo */}
      <div
        data-drop-key="undated"
        onDragOver={e => { if (isAdmin && draggedProjectId) { e.preventDefault(); setDragOverKey('undated'); } }}
        onDragLeave={() => setDragOverKey(k => k === 'undated' ? null : k)}
        onDrop={e => { if (isAdmin) { e.preventDefault(); onDropOnUndated(); } }}
        style={{
          width: isNarrowViewport ? '100%' : 260, flexShrink: 0, borderRadius: 12, padding: 10,
          background: dragOverKey === 'undated' ? 'var(--accent-glow)' : 'transparent',
          boxShadow: dragOverKey === 'undated' ? 'inset 0 0 0 2px var(--accent)' : 'none', transition: 'background 0.1s'
        }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Sin fecha ({undated.length})
        </div>
        {undated.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Ningún proyecto activo sin deadline{isAdmin ? ' — arrastrá uno acá para sacarle la fecha' : ''}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {undated.map(p => (
            <div key={p.id}
              draggable={isAdmin}
              {...touchDragProps(p.id)}
              onDragStart={() => setDraggedProjectId(p.id)}
              onDragEnd={() => setDraggedProjectId(null)}
              onClick={() => openProjectChip(p)}
              className="panel" style={{ borderRadius: 9, padding: '8px 10px', cursor: isAdmin ? 'grab' : 'pointer', display: 'flex', alignItems: 'center', gap: 8, touchAction: draggedProjectId ? 'none' : 'auto' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Modal con todos los eventos de un día (cuando hay más de los que entran en la celda) */}
      {dayModal && (
        <div className="modal-overlay" onClick={() => setDayModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }} ref={dayModalRef} role="dialog" aria-modal="true" aria-labelledby="day-modal-title">
            <button className="modal-close" onClick={() => setDayModal(null)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="day-modal-title" style={{ textTransform: 'capitalize' }}>{new Date(dayModal + 'T00:00:00').toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14, maxHeight: '50vh', overflowY: 'auto' }}>
              {(eventsByDay[dayModal]?.events || []).map(ev => (
                <div key={ev.id} className="panel" onClick={() => { setDayModal(null); setChipModal({ type: 'event', data: ev }); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }}>
                  <span>📅</span>
                  <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{ev.title}</span>
                </div>
              ))}
              {(eventsByDay[dayModal]?.projects || []).map(p => {
                const dl = deadlineLabel(p.deadline);
                return (
                  <div key={p.id} className="panel" onClick={() => { setDayModal(null); openProjectChip(p); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                    {dl && <span style={{ fontSize: 10, fontWeight: 700, color: dl.color, background: dl.bg, padding: '2px 6px', borderRadius: 5 }}>{dl.label}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Modal de un chip individual: proyecto (reprogramar/quitar fecha/abrir) o evento (borrar) */}
      {chipModal && (
        <div className="modal-overlay" onClick={() => setChipModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }} ref={chipModalRef} role="dialog" aria-modal="true" aria-labelledby="chip-modal-title">
            <button className="modal-close" onClick={() => setChipModal(null)} title="Cerrar" aria-label="Cerrar">✕</button>
            {chipModal.type === 'project' ? (() => {
              const p = chipModal.data;
              const dl = deadlineLabel(p.deadline);
              return (
                <>
                  <h2 id="chip-modal-title">{p.name}</h2>
                  {p.client_name && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>{p.client_name}</div>}
                  {dl && <div style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, color: dl.color, background: dl.bg, padding: '3px 8px', borderRadius: 6, marginBottom: 14 }}>{dl.label}</div>}
                  {isAdmin && (
                    <div className="form-group">
                      <label>Deadline</label>
                      <input className="input" type="date" value={p.deadline || ''}
                        onChange={e => { applyDrop(p.id, e.target.value || null); setChipModal(null); }} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16 }}>
                    {isAdmin && p.deadline && (
                      <button className="btn btn-ghost" onClick={() => { applyDrop(p.id, null); setChipModal(null); }}>Quitar fecha</button>
                    )}
                    <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => navigate(`/project/${p.id}`)}>Abrir proyecto →</button>
                  </div>
                </>
              );
            })() : (() => {
              const ev = chipModal.data;
              const canDelete = isAdmin || ev.created_by === user.id;
              return (
                <>
                  <h2 id="chip-modal-title">📅 {ev.title}</h2>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
                    {new Date(ev.date + 'T00:00:00').toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                  {canDelete && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button className="btn btn-danger" onClick={() => deleteEvent(ev)}>Borrar evento</button>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Nuevo evento */}
      {showNewEvent && (
        <div className="modal-overlay" onClick={() => setShowNewEvent(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }} ref={newEventModalRef} role="dialog" aria-modal="true" aria-labelledby="new-event-modal-title">
            <button className="modal-close" onClick={() => setShowNewEvent(null)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="new-event-modal-title">Nuevo evento</h2>
            <div className="form-group">
              <label>Título</label>
              <input className="input" autoFocus value={newEventForm.title}
                onChange={e => setNewEventForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Rodaje, reunión con cliente, recordatorio..." />
            </div>
            <div className="form-group">
              <label>Fecha</label>
              <input className="input" type="date" value={newEventForm.date || showNewEvent}
                onChange={e => setNewEventForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Color</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {EVENT_COLORS.map((c, i) => (
                  <button key={c} onClick={() => setNewEventForm(f => ({ ...f, color: c }))}
                    aria-label={`Color ${i + 1}`} aria-pressed={newEventForm.color === c}
                    style={{ width: 22, height: 22, borderRadius: '50%', background: c, cursor: 'pointer', border: newEventForm.color === c ? '2px solid #fff' : '2px solid transparent', boxShadow: newEventForm.color === c ? '0 0 0 2px rgba(0,0,0,0.4)' : 'none' }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setShowNewEvent(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={createEvent} disabled={!newEventForm.title.trim()}>Crear</button>
            </div>
          </div>
        </div>
      )}

      {/* Suscripción iCal */}
      {showFeedModal && (
        <div className="modal-overlay" onClick={() => setShowFeedModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }} ref={feedModalRef} role="dialog" aria-modal="true" aria-labelledby="feed-modal-title">
            <button className="modal-close" onClick={() => setShowFeedModal(false)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="feed-modal-title">Suscribirse al calendario</h2>
            <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 14 }}>
              Pegá este link en Google Calendar ("Desde URL") o Apple Calendar ("Nueva suscripción de calendario") para ver tus deadlines y los eventos del equipo sin entrar a AgencyOS. Es personal — no lo compartas, cualquiera con el link ve tu calendario.
            </p>
            {feedLoading && <div style={{ fontSize: 13, color: 'var(--text3)' }}>Generando...</div>}
            {feedUrl && (
              <div className="form-group">
                <input className="input" readOnly value={feedUrl} onClick={e => e.target.select()} />
                <button className="btn btn-primary" style={{ marginTop: 10 }}
                  onClick={() => navigator.clipboard.writeText(feedUrl)}>Copiar link</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
