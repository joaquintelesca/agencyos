import { useState, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MAX_VISIBLE_PER_DAY = 3;

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

export default function CalendarPage() {
  const { api, user } = useAuth();
  const { alert } = useAlert();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const [viewDate, setViewDate] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [dayModal, setDayModal] = useState(null); // dateKey | null
  const [draggedProjectId, setDraggedProjectId] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null); // dateKey | 'undated' | null, solo para resaltar el destino

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const days = useMemo(() => getMonthGrid(year, month), [year, month]);

  // Por ahora el calendario muestra solo deadlines de proyecto (no fechas límite de tarea) — se
  // puede sumar más adelante si hace falta. Un proyecto ya terminado no aporta su deadline acá,
  // mismo criterio que el Dashboard: ya no es información accionable.
  const eventsByDay = useMemo(() => {
    const map = {};
    projects.forEach(p => {
      if (p.deadline && p.status !== 'completed') {
        (map[p.deadline] = map[p.deadline] || []).push(p);
      }
    });
    return map;
  }, [projects]);

  // Proyectos activos sin deadline — no tienen dónde plotearse en la grilla, se listan acá en vez
  // de desaparecer del calendario. También es el destino de "arrastrar para sacarle la fecha".
  const undated = useMemo(() => projects.filter(p => !p.deadline && p.status !== 'completed'), [projects]);

  const monthLabel = viewDate.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  const todayKey = toDateKey(new Date());

  const goToMonth = (delta) => setViewDate(d => { const nd = new Date(d); nd.setMonth(nd.getMonth() + delta); return nd; });
  const goToToday = () => { const d = new Date(); d.setDate(1); setViewDate(d); };

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

  const navBtnStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, width: 28, height: 28, color: 'var(--text2)', cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' };

  const renderChip = (p) => (
    <div key={p.id}
      draggable={isAdmin}
      onDragStart={() => setDraggedProjectId(p.id)}
      onDragEnd={() => setDraggedProjectId(null)}
      onClick={() => navigate(`/project/${p.id}`)}
      title={p.name}
      style={{
        fontSize: 10.5, padding: '2px 6px', borderRadius: 5, background: `${p.color}2a`, color: p.color,
        cursor: isAdmin ? 'grab' : 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>
      📌 {p.name}
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'flex', gap: 20 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, flex: 1, textTransform: 'capitalize' }}>{monthLabel}</h1>
          <button onClick={goToToday} className="btn btn-ghost btn-sm">Hoy</button>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => goToMonth(-1)} style={navBtnStyle} title="Mes anterior">‹</button>
            <button onClick={() => goToMonth(1)} style={navBtnStyle} title="Mes siguiente">›</button>
          </div>
        </div>

        {/* Grilla */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', background: 'var(--bg3)' }}>
            {WEEKDAYS.map(w => (
              <div key={w} style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{w}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
            {days.map(d => {
              const key = toDateKey(d);
              const isCurrentMonth = d.getMonth() === month;
              const isToday = key === todayKey;
              const dayEvents = eventsByDay[key] || [];
              const visible = dayEvents.slice(0, MAX_VISIBLE_PER_DAY);
              const extra = dayEvents.length - visible.length;
              return (
                <div key={key}
                  onDragOver={e => { if (isAdmin && draggedProjectId) { e.preventDefault(); setDragOverKey(key); } }}
                  onDragLeave={() => setDragOverKey(k => k === key ? null : k)}
                  onDrop={e => { if (isAdmin) { e.preventDefault(); onDropOnDay(key); } }}
                  style={{
                    minHeight: 96, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
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
                  {visible.map(renderChip)}
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
        onDragOver={e => { if (isAdmin && draggedProjectId) { e.preventDefault(); setDragOverKey('undated'); } }}
        onDragLeave={() => setDragOverKey(k => k === 'undated' ? null : k)}
        onDrop={e => { if (isAdmin) { e.preventDefault(); onDropOnUndated(); } }}
        style={{
          width: 260, flexShrink: 0, borderRadius: 12, padding: 10,
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
              onDragStart={() => setDraggedProjectId(p.id)}
              onDragEnd={() => setDraggedProjectId(null)}
              onClick={() => navigate(`/project/${p.id}`)}
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 10px', cursor: isAdmin ? 'grab' : 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Modal con todos los eventos de un día (cuando hay más de los que entran en la celda) */}
      {dayModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <button className="modal-close" onClick={() => setDayModal(null)} title="Cerrar">✕</button>
            <h2 style={{ textTransform: 'capitalize' }}>{new Date(dayModal + 'T00:00:00').toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14, maxHeight: '50vh', overflowY: 'auto' }}>
              {(eventsByDay[dayModal] || []).map(p => (
                <div key={p.id} onClick={() => { setDayModal(null); navigate(`/project/${p.id}`); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
