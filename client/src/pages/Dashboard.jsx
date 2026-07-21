import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials, deadlineLabel } from '../utils/format';

export default function Dashboard() {
  const { api, user } = useAuth();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState({}); // { projectId: [tasks] }
  const [clients, setClients] = useState([]);
  const [pendingVideos, setPendingVideos] = useState([]);

  const projectIds = projects.map(p => p.id).join(',');
  useEffect(() => {
    api('/api/clients').then(setClients).catch(console.error);
    api('/api/dashboard/pending-videos').then(setPendingVideos).catch(console.error);
    projects.forEach(p => {
      api(`/api/projects/${p.id}/tasks`).then(t => setTasks(prev => ({ ...prev, [p.id]: t }))).catch(console.error);
    });
  }, [projectIds]);

  const allTasks = Object.values(tasks).flat();
  const pendingTasks = allTasks.filter(t => t.status !== 'done');
  const deadlineSoon = projects.filter(p => p.deadline).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

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
              { label: 'Deadlines esta semana', val: projects.filter(p => { if (!p.deadline) return false; const diff = Math.ceil((new Date(p.deadline) - new Date()) / 86400000); return diff >= 0 && diff <= 7; }).length, color: 'var(--red)' },
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
                  return (
                    <div key={p.id} onClick={() => navigate(`/project/${p.id}`)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
                      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                      {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
                      {p.payment_editor_name && (
                        <div style={{ width: 22, height: 22, borderRadius: '50%', background: p.payment_editor_color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff' }}>
                          {initials(p.payment_editor_name)}
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

          {/* Videos pendientes de revisión */}
          {pendingVideos.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Videos pendientes de revisión</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {pendingVideos.map(v => (
                  <div key={v.id} onClick={() => navigate(`/project/${v.project_id}?tab=videos`)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: v.project_color || 'var(--text3)', flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{v.title} <span style={{ fontSize: 11, color: 'var(--text3)' }}>v{v.version}</span></span>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>{v.client_name ? `${v.client_name} · ` : ''}{v.project_name}</span>
                    {v.uploader_name && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff' }}>
                          {initials(v.uploader_name)}
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{v.uploader_name}</span>
                      </div>
                    )}
                    {v.type === 'review'
                      ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, fontWeight: 500, background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)' }}>En revisión</span>
                      : <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, fontWeight: 500, background: 'rgba(240,92,92,0.12)', color: 'var(--red)' }}>{v.unresolved_count} comentario{v.unresolved_count !== 1 ? 's' : ''}</span>
                    }
                  </div>
                ))}
              </div>
            </div>
          )}

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
