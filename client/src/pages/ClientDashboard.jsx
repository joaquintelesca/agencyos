import { useState, useEffect } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials, deadlineLabel } from '../utils/format';

const STATUS_LABELS = { todo: 'Por hacer', in_progress: 'En progreso', review: 'En revisión', done: 'Listo' };
const STATUS_COLORS = { todo: 'var(--text3)', in_progress: 'var(--blue)', review: 'var(--yellow)', done: 'var(--green)' };

export default function ClientDashboard() {
  const { id } = useParams();
  const { api, user } = useAuth();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const [client, setClient] = useState(null);
  const [tasks, setTasks] = useState({});
  const clientProjects = projects.filter(p => p.client_id === id);
  const projectIds = clientProjects.map(p => p.id).join(',');

  useEffect(() => {
    // Resetear antes de refetch: si no, al navegar de un cliente a otro se ve por un instante
    // el header/nombre del cliente anterior en vez del spinner de carga.
    setClient(null);
    api(`/api/clients`).then(cs => setClient(cs.find(c => c.id === id) || null)).catch(console.error);
  }, [id]);

  useEffect(() => {
    // Resetear las tareas al cambiar de cliente — si no, las estadísticas del cliente nuevo
    // incluyen tareas acumuladas de clientes visitados antes en esta misma sesión.
    setTasks({});
  }, [id]);

  useEffect(() => {
    clientProjects.forEach(p => {
      api(`/api/projects/${p.id}/tasks`).then(t => setTasks(prev => ({ ...prev, [p.id]: t }))).catch(console.error);
    });
  }, [projectIds]);

  const allTasks = Object.values(tasks).flat();
  const totalTasks = allTasks.length;
  const reviewTasks = allTasks.filter(t => t.status === 'review').length;
  const doneTasks = allTasks.filter(t => t.status === 'done').length;
  const pendingTasks = totalTasks - doneTasks;

  if (!client) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: client.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#fff' }}>
          {client.name[0].toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{client.name}</h1>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
            {client.email && <span>{client.email}</span>}
            {client.phone && <span>{client.phone}</span>}
          </div>
        </div>
      </div>

      {client.notes && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 20, fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
          {client.notes}
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 24 }}>
        {[
          { label: 'Proyectos', val: clientProjects.length, color: 'var(--text)' },
          { label: 'Tareas pendientes', val: pendingTasks, color: pendingTasks > 0 ? 'var(--yellow)' : 'var(--green)' },
          { label: 'En revisión', val: reviewTasks, color: reviewTasks > 0 ? 'var(--red)' : 'var(--text3)' },
          { label: 'Completadas', val: doneTasks, color: 'var(--green)' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Projects list */}
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Proyectos</div>

      {clientProjects.length === 0 && (
        <div className="empty"><div className="empty-icon">📁</div><p>Sin proyectos para este cliente</p></div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {clientProjects.map(p => {
          const pTasks = tasks[p.id] || [];
          const total = pTasks.length;
          const done = pTasks.filter(t => t.status === 'done').length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const dl = deadlineLabel(p.deadline);
          const statusCounts = {};
          pTasks.forEach(t => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });

          return (
            <div key={p.id}
              onDoubleClick={() => navigate(`/project/${p.id}`)}
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
              {/* Top row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                {p.payment_editor_name && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', background: p.payment_editor_color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff' }}>
                      {initials(p.payment_editor_name)}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.payment_editor_name}</span>
                  </div>
                )}
                {dl && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, fontWeight: 500, background: dl.bg, color: dl.color }}>{dl.label}</span>}
                {p.deadline && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{new Date(p.deadline + 'T00:00:00').toLocaleDateString('es', { day: 'numeric', month: 'short' })}</span>}
              </div>

              {/* Progress bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ flex: 1, height: 5, background: 'var(--bg4)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--green)' : 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 40, textAlign: 'right' }}>{done}/{total}</span>
              </div>

              {/* Status badges */}
              {total > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {Object.entries(statusCounts).map(([status, count]) => (
                    <span key={status} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, fontWeight: 600, background: `${STATUS_COLORS[status]}18`, color: STATUS_COLORS[status] }}>
                      {STATUS_LABELS[status]} {count}
                    </span>
                  ))}
                </div>
              )}
              {total === 0 && <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin tareas</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
