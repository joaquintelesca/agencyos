import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

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
  const { api } = useAuth();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const [viewDate, setViewDate] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [tasks, setTasks] = useState({}); // { projectId: [tasks] }
  const [dayModal, setDayModal] = useState(null); // dateKey | null

  // Mismo patrón que el Dashboard: una tarea por proyecto, en paralelo — para admin son todos sus
  // proyectos, para un editor ya vienen filtrados a los suyos desde /api/projects.
  const projectIds = projects.map(p => p.id).join(',');
  useEffect(() => {
    projects.forEach(p => {
      api(`/api/projects/${p.id}/tasks`).then(t => setTasks(prev => ({ ...prev, [p.id]: t }))).catch(console.error);
    });
  }, [projectIds]); // eslint-disable-line

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const days = useMemo(() => getMonthGrid(year, month), [year, month]);

  // Un solo mapa fecha -> eventos, mezclando deadlines de proyecto (si el proyecto no está
  // terminado — uno ya terminado no necesita más recordatorio, mismo criterio que el Dashboard) y
  // fechas límite de tarea. Cada evento se pinta con el color de su proyecto, para poder distinguir
  // de un vistazo qué es de qué cliente, igual que en el board.
  const eventsByDay = useMemo(() => {
    const map = {};
    const addEvent = (dateKey, ev) => { (map[dateKey] = map[dateKey] || []).push(ev); };
    projects.forEach(p => {
      if (p.deadline && p.status !== 'completed') {
        addEvent(p.deadline, { id: `deadline-${p.id}`, title: `📌 ${p.name}`, color: p.color, projectId: p.id, done: false });
      }
      (tasks[p.id] || []).forEach(t => {
        if (t.due_date) {
          addEvent(t.due_date, { id: `task-${t.id}`, title: t.title, color: p.color, projectId: p.id, done: t.status === 'done' });
        }
      });
    });
    return map;
  }, [projects, tasks]);

  // Tareas pendientes sin fecha límite: no tienen dónde plotearse en la grilla, pero listarlas
  // acá evita que desaparezcan del todo del calendario.
  const undated = useMemo(() => {
    const list = [];
    projects.forEach(p => {
      (tasks[p.id] || []).forEach(t => {
        if (!t.due_date && t.status !== 'done') list.push({ ...t, projectName: p.name, projectColor: p.color, projectId: p.id });
      });
    });
    return list;
  }, [projects, tasks]);

  const monthLabel = viewDate.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  const todayKey = toDateKey(new Date());

  const goToMonth = (delta) => setViewDate(d => { const nd = new Date(d); nd.setMonth(nd.getMonth() + delta); return nd; });
  const goToToday = () => { const d = new Date(); d.setDate(1); setViewDate(d); };

  const navBtnStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, width: 28, height: 28, color: 'var(--text2)', cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'flex', gap: 20 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, flex: 1, textTransform: 'capitalize' }}>{monthLabel}</h1>
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
                <div key={key} style={{
                  minHeight: 96, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
                  padding: 6, background: isCurrentMonth ? 'var(--bg2)' : 'var(--bg)', opacity: isCurrentMonth ? 1 : 0.5,
                  display: 'flex', flexDirection: 'column', gap: 3
                }}>
                  <span style={{
                    fontSize: 11, color: isToday ? '#fff' : 'var(--text3)', background: isToday ? 'var(--accent)' : 'transparent',
                    width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: isToday ? 700 : 400
                  }}>
                    {d.getDate()}
                  </span>
                  {visible.map(ev => (
                    <div key={ev.id} onClick={() => navigate(`/project/${ev.projectId}`)}
                      title={ev.title}
                      style={{
                        fontSize: 10.5, padding: '2px 6px', borderRadius: 5, background: `${ev.color}2a`, color: ev.color, cursor: 'pointer',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        textDecoration: ev.done ? 'line-through' : 'none', opacity: ev.done ? 0.6 : 1
                      }}>
                      {ev.title}
                    </div>
                  ))}
                  {extra > 0 && (
                    <div onClick={() => setDayModal(key)} style={{ fontSize: 10, color: 'var(--accent2)', cursor: 'pointer', fontWeight: 600 }}>+{extra} más</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sin fecha */}
      <div style={{ width: 260, flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Sin fecha ({undated.length})
        </div>
        {undated.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Nada pendiente sin fecha</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {undated.map(t => (
            <div key={t.id} onClick={() => navigate(`/project/${t.projectId}`)}
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 10px', cursor: 'pointer' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 4 }}>{t.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.projectColor, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>{t.projectName}</span>
              </div>
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
              {(eventsByDay[dayModal] || []).map(ev => (
                <div key={ev.id} onClick={() => { setDayModal(null); navigate(`/project/${ev.projectId}`); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: ev.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, textDecoration: ev.done ? 'line-through' : 'none' }}>{ev.title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
