import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { api, user } = useAuth();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState({}); // { projectId: [tasks] }
  const [clients, setClients] = useState([]);

  const projectIds = projects.map(p => p.id).join(',');
  useEffect(() => {
    api('/api/clients').then(setClients).catch(console.error);
    projects.forEach(p => {
      api(`/api/projects/${p.id}/tasks`).then(t => setTasks(prev => ({ ...prev, [p.id]: t }))).catch(console.error);
    });
  }, [projectIds]);

  const initials = (name) => name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const allTasks = Object.values(tasks).flat();
  const pendingTasks = allTasks.filter(t => t.status !== 'done');
  const deadlineSoon = projects.filter(p => p.deadline).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  const deadlineLabel = (d) => {
    if (!d) return null;
    const diff = Math.ceil((new Date(d) - new Date()) / 86400000);
    if (diff < 0) return { label: 'Vencido', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' };
    if (diff === 0) return { label: 'Vence hoy', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' };
    if (diff === 1) return { label: 'Mañana', color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' };
    if (diff <= 7) return { label: `En ${diff} días`, color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' };
    return { label: `En ${diff} días`, color: 'var(--green)', bg: 'rgba(34,201,122,0.12)' };
  };

  const getAssignee = (projectId) => {
    const projectTasks = tasks[projectId] || [];
    const assigned = projectTasks.find(t => t.assigned_to);
    return assigned ? { name: assigned.assignee_name, color: assigned.assignee_color } : null;
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Hola, {user?.name?.split(' ')[0]} 👋</h1>
      </div>

      {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Proyectos activos', val: projects.length, color: 'var(--text)' },
              { label: 'Tareas pendientes', val: pendingTasks.length, color: pendingTasks.length > 0 ? 'var(--yellow)' : 'var(--green)' },
              { label: 'Deadlines esta semana', val: deadlineSoon.filter(p => { const d = deadlineLabel(p.deadline); return d && (d.label === 'Vence hoy' || d.label === 'Mañana' || d.label?.includes('días')); }).length, color: 'var(--red)' },
              { label: 'Clientes activos', val: clients.length, color: 'var(--accent2)' },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>

          {/* Upcoming deadlines */}
          {deadlineSoon.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Próximos deadlines</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {deadlineSoon.slice(0, 5).map(p => {
                  const dl = deadlineLabel(p.deadline);
                  const assignee = getAssignee(p.id);
                  return (
                    <div key={p.id} onClick={() => navigate(`/project/${p.id}`)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
                      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                      {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
                      {assignee && (
                        <div style={{ width: 22, height: 22, borderRadius: '50%', background: assignee.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff' }}>
                          {initials(assignee.name)}
                        </div>
                      )}
                      {dl && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, fontWeight: 500, background: dl.bg, color: dl.color }}>{dl.label}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tareas en revisión */}
          {(() => {
            const reviewTasks = allTasks.filter(t => t.status === 'review');
            if (reviewTasks.length === 0) return null;
            return (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Esperando tu aprobación</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {reviewTasks.map(t => {
                    const proj = projects.find(p => p.id === t.project_id);
                    return (
                      <div key={t.id} onClick={() => navigate(`/project/${t.project_id}`)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
                        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: proj?.color || 'var(--text3)', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{t.title}</span>
                        {proj && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{proj.client_name ? `${proj.client_name} · ` : ''}{proj.name}</span>}
                        {t.assignee_name && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <div style={{ width: 20, height: 20, borderRadius: '50%', background: t.assignee_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff' }}>
                              {initials(t.assignee_name)}
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{t.assignee_name}</span>
                          </div>
                        )}
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, fontWeight: 500, background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)' }}>En revisión</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {projects.length === 0 && (
            <div className="empty"><div className="empty-icon">📁</div><p>No hay proyectos todavía</p><p style={{ fontSize: 12 }}>Creá uno desde la barra lateral</p></div>
          )}

          {projects.length > 0 && deadlineSoon.length === 0 && (
            <div style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
              <p>Sin deadlines próximos</p>
              <p style={{ fontSize: 12 }}>Hacé clic en un proyecto del sidebar para ver sus tareas</p>
            </div>
          )}
    </div>
  );
}
