import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials, deadlineLabel, daysUntil } from '../utils/format';
import useModalA11y from '../hooks/useModalA11y';

const VIDEOS_PREVIEW_LIMIT = 5;
const PAYMENTS_PREVIEW_LIMIT = 5;
const TASK_STATUS_LABELS = { todo: 'Por hacer', in_progress: 'En progreso', review: 'En revisión', feedback: 'Aplicar feedback', done: 'Listo' };
const TASK_STATUS_COLORS = { todo: 'var(--text3)', in_progress: 'var(--blue)', review: 'var(--yellow)', feedback: 'var(--red)', done: 'var(--green)' };
const STAT_MODAL_TITLES = { projects: 'Proyectos activos', tasks: 'Tareas pendientes', deadlines: 'Deadlines esta semana', clients: 'Clientes activos' };

export default function Dashboard() {
  const { api, user } = useAuth();
  const { projects } = useOutletContext();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const [tasks, setTasks] = useState({}); // { projectId: [tasks] }
  const [clients, setClients] = useState([]);
  const [pendingVideos, setPendingVideos] = useState([]);
  const [payments, setPayments] = useState([]);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [statModal, setStatModal] = useState(null); // 'projects' | 'tasks' | 'deadlines' | 'clients' | null

  const projectIds = projects.map(p => p.id).join(',');
  useEffect(() => {
    setError('');
    api('/api/clients').then(setClients).catch(e => { console.error(e); setError('No se pudo cargar toda la información del dashboard. Puede ser un problema de conexión.'); });
    api('/api/dashboard/pending-videos').then(setPendingVideos).catch(e => { console.error(e); setError('No se pudo cargar toda la información del dashboard. Puede ser un problema de conexión.'); });
    if (isAdmin) {
      api('/api/payments').then(setPayments).catch(e => { console.error(e); setError('No se pudo cargar toda la información del dashboard. Puede ser un problema de conexión.'); });
    }
    // Se descartan las claves de proyectos que ya no existen: antes el mapa solo crecía, así que
    // borrar un proyecto dejaba sus tareas contando en "Tareas pendientes" y sus tareas en
    // revisión listadas sin proyecto, linkeando a un "Proyecto no encontrado".
    const vigentes = new Set(projects.map(p => p.id));
    setTasks(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => vigentes.has(id))));
    projects.forEach(p => {
      api(`/api/projects/${p.id}/tasks`).then(t => setTasks(prev => ({ ...prev, [p.id]: t }))).catch(console.error);
    });
  }, [projectIds, retryCount, isAdmin]);

  const allTasks = Object.values(tasks).flat();
  const pendingTasks = allTasks.filter(t => t.status !== 'done');
  const activeProjectsList = projects.filter(p => p.status !== 'completed');
  // status !== 'completed' igual que deadlineSoon y el Calendario: sin ese filtro el contador
  // rojo seguía contando deadlines de trabajo ya entregado.
  const deadlinesThisWeek = projects.filter(p => {
    if (!p.deadline || p.status === 'completed') return false;
    const diff = daysUntil(p.deadline);
    return diff >= 0 && diff <= 7;
  });
  // Un proyecto ya marcado "Terminado" no necesita más recordatorios de deadline ni de
  // aprobación — si algo quedó suelto ahí (una tarea en revisión, un deadline próximo) ya no es
  // información accionable para el Dashboard.
  const completedProjectIds = new Set(projects.filter(p => p.status === 'completed').map(p => p.id));
  const deadlineSoon = projects.filter(p => p.deadline && p.status !== 'completed').sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const reviewedVideoTaskIds = new Set(pendingVideos.filter(v => v.type === 'review' && v.task_id).map(v => v.task_id));
  const reviewTasks = allTasks.filter(t => t.status === 'review' && !reviewedVideoTaskIds.has(t.id) && !completedProjectIds.has(t.project_id));

  // Pagos pendientes: proyectos ya terminados a los que todavía les falta pagarle al editor
  // y/o cobrarle al cliente. computed_editor_total/computed_client_net ya vienen calculados del
  // servidor (mismo cálculo exacto que usa la página de Pagos) — antes esta cuenta (incluida la
  // lógica de neto de Upwork) estaba reimplementada acá a mano, en Payments.jsx y en el servidor
  // por separado; si cambiaba una regla de negocio había que acordarse de tocar los 3 lugares.
  // Cuando el editor asignado sos vos mismo no hay pago real que marcar — se trata como
  // "resuelto" en ese lado en vez de quedar eternamente pendiente por un toggle que nunca aplica.
  // editor_is_owner viene calculado del servidor (ver withComputedTotals/OWNER_EMAIL en
  // server/index.js) — es específicamente el dueño de la agencia, no "cualquier admin" ni "quien
  // esté logueado ahora".
  const editorSettled = p => p.editor_is_owner || p.editor_paid === 'paid';
  const unpaidPayments = payments.filter(p => !editorSettled(p) || p.client_paid !== 'cobrado');
  const totalEditorPending = unpaidPayments.filter(p => !editorSettled(p)).reduce((s, p) => s + p.computed_editor_total, 0);
  const totalClientPending = unpaidPayments.filter(p => p.client_paid !== 'cobrado').reduce((s, p) => s + p.computed_client_net, 0);

  const sectionTitleStyle = { fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' };
  const sectionLinkStyle = { fontSize: 12, color: 'var(--accent2)', fontWeight: 600, cursor: 'pointer' };

  const statsSection = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
      {[
        { type: 'projects', label: 'Proyectos activos', val: activeProjectsList.length, color: 'var(--text)' },
        { type: 'tasks', label: 'Tareas pendientes', val: pendingTasks.length, color: pendingTasks.length > 0 ? 'var(--yellow)' : 'var(--green)' },
        { type: 'deadlines', label: 'Deadlines esta semana', val: deadlinesThisWeek.length, color: 'var(--red)' },
        { type: 'clients', label: 'Clientes activos', val: clients.length, color: 'var(--accent2)' },
      ].map(s => (
        <div key={s.label} onDoubleClick={() => setStatModal(s.type)} title="Doble click para ver el detalle"
          style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', cursor: 'pointer', transition: 'border-color 0.15s' }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{s.label}</div>
          <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: s.color }}>{s.val}</div>
        </div>
      ))}
    </div>
  );

  const goToProject = (id) => { setStatModal(null); navigate(`/project/${id}`); };

  const statModalRef = useModalA11y(!!statModal, () => setStatModal(null));

  const statModalSection = statModal && (
    <div className="modal-overlay">
      <div className="modal" onClick={e => e.stopPropagation()} ref={statModalRef} role="dialog" aria-modal="true" aria-labelledby="stat-modal-title">
        <button className="modal-close" onClick={() => setStatModal(null)} title="Cerrar" aria-label="Cerrar">✕</button>
        <h2 id="stat-modal-title">{STAT_MODAL_TITLES[statModal]}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: '55vh', overflowY: 'auto', marginTop: 16 }}>
          {statModal === 'projects' && (activeProjectsList.length === 0
            ? <div className="empty"><div className="empty-icon">📁</div><p>Sin proyectos activos</p></div>
            : activeProjectsList.map(p => (
              <div key={p.id} onClick={() => goToProject(p.id)} className="list-row">
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
                {p.payment_editor_name && (
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: p.payment_editor_color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff' }}>
                    {initials(p.payment_editor_name)}
                  </div>
                )}
              </div>
            )))}

          {statModal === 'tasks' && (pendingTasks.length === 0
            ? <div className="empty"><div className="empty-icon">✅</div><p>Sin tareas pendientes</p></div>
            : pendingTasks.map(t => {
              const proj = projects.find(p => p.id === t.project_id);
              return (
                <div key={t.id} onClick={() => goToProject(t.project_id)} className="list-row">
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
                  <span className="badge" style={{ fontWeight: 500, background: `${TASK_STATUS_COLORS[t.status] || 'var(--text3)'}18`, color: TASK_STATUS_COLORS[t.status] || 'var(--text3)' }}>
                    {TASK_STATUS_LABELS[t.status] || t.status}
                  </span>
                </div>
              );
            }))}

          {statModal === 'deadlines' && (deadlinesThisWeek.length === 0
            ? <div className="empty"><div className="empty-icon">📅</div><p>Sin deadlines esta semana</p></div>
            : deadlinesThisWeek.map(p => {
              const dl = deadlineLabel(p.deadline);
              return (
                <div key={p.id} onClick={() => goToProject(p.id)} className="list-row">
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                  {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
                  {dl && <span className="badge" style={{ fontWeight: 500, background: dl.bg, color: dl.color }}>{dl.label}</span>}
                </div>
              );
            }))}

          {statModal === 'clients' && (clients.length === 0
            ? <div className="empty"><div className="empty-icon">👥</div><p>Sin clientes todavía</p></div>
            : clients.map(c => (
              <div key={c.id} onClick={() => { setStatModal(null); navigate(`/client/${c.id}`); }} className="list-row">
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{c.name}</span>
                {c.email && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{c.email}</span>}
              </div>
            )))}
        </div>
      </div>
    </div>
  );

  const deadlinesSection = deadlineSoon.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...sectionTitleStyle, marginBottom: 8 }}>Próximos deadlines</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {deadlineSoon.slice(0, 5).map(p => {
          const dl = deadlineLabel(p.deadline);
          return (
            <div key={p.id} onClick={() => navigate(`/project/${p.id}`)} className="list-row">
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
              {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
              {p.payment_editor_name && (
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: p.payment_editor_color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff' }}>
                  {initials(p.payment_editor_name)}
                </div>
              )}
              {dl && <span className="badge" style={{ fontWeight: 500, background: dl.bg, color: dl.color }}>{dl.label}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );

  const reviewSection = reviewTasks.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...sectionTitleStyle, marginBottom: 8 }}>{isAdmin ? 'Esperando tu aprobación' : 'Esperando aprobación del admin'}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {reviewTasks.map(t => {
          const proj = projects.find(p => p.id === t.project_id);
          return (
            <div key={t.id} onClick={() => navigate(`/project/${t.project_id}`)} className="list-row">
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
              <span className="badge" style={{ fontWeight: 500, background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)' }}>En revisión</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const videosSection = pendingVideos.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={sectionTitleStyle}>Videos pendientes de revisión</div>
        {isAdmin && pendingVideos.length > VIDEOS_PREVIEW_LIMIT && (
          <span onClick={() => navigate('/videos')} style={sectionLinkStyle}>Ver todos en Videos →</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {(isAdmin ? pendingVideos.slice(0, VIDEOS_PREVIEW_LIMIT) : pendingVideos).map(v => (
          <div key={v.id} onClick={() => navigate(`/project/${v.project_id}?tab=videos`)} className="list-row">
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
              ? <span className="badge" style={{ fontWeight: 500, background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)' }}>En revisión</span>
              : <span className="badge" style={{ fontWeight: 500, background: 'rgba(240,92,92,0.12)', color: 'var(--red)' }}>{v.unresolved_count} comentario{v.unresolved_count !== 1 ? 's' : ''}</span>
            }
          </div>
        ))}
      </div>
    </div>
  );

  const paymentsSection = isAdmin && unpaidPayments.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={sectionTitleStyle}>💰 Pagos pendientes</div>
      </div>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px 6px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          <div style={{ background: 'var(--bg3)', borderRadius: 9, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Total a pagar a editores</div>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--red)' }}>${totalEditorPending.toFixed(0)}</div>
          </div>
          <div style={{ background: 'var(--bg3)', borderRadius: 9, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Total a cobrar de clientes</div>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--blue)' }}>${totalClientPending.toFixed(0)}</div>
          </div>
        </div>
        {unpaidPayments.slice(0, PAYMENTS_PREVIEW_LIMIT).map((p, i) => {
          const missingEditor = !editorSettled(p);
          const missingClient = p.client_paid !== 'cobrado';
          // "Falta cobrar cliente" en violeta (mismo color que ya usa Pagos para todo lo
          // relacionado al cobro al cliente) en vez de azul — antes era el único de los 3 estados
          // que no seguía ninguna lógica compartida con el resto de la app.
          const chipColor = missingEditor && missingClient ? 'var(--yellow)' : missingEditor ? 'var(--red)' : 'var(--lavender)';
          return (
            <div key={p.id} onClick={() => navigate('/payments')}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', borderTop: i === 0 ? 'none' : '1px solid var(--border)', cursor: 'pointer' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.client_name ? `${p.client_name} · ` : ''}{p.name}
              </span>
              {p.editor_name && (
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: p.editor_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                  {initials(p.editor_name)}
                </div>
              )}
              <span className="badge" style={{ borderRadius: 7, whiteSpace: 'nowrap', background: `${chipColor}22`, color: chipColor }}>
                {missingEditor && missingClient ? 'Falta pagar y cobrar' : missingEditor ? 'Falta pagar editor' : 'Falta cobrar cliente'}
              </span>
            </div>
          );
        })}
        {unpaidPayments.length > PAYMENTS_PREVIEW_LIMIT && (
          <div style={{ textAlign: 'right', padding: '8px 4px 4px' }}>
            <span onClick={() => navigate('/payments')} style={sectionLinkStyle}>+{unpaidPayments.length - PAYMENTS_PREVIEW_LIMIT} más en Pagos →</span>
          </div>
        )}
      </div>
    </div>
  );

  const nothingToShow = !paymentsSection && !videosSection && !reviewSection && !deadlinesSection;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800 }}>Hola, {user?.name?.split(' ')[0]} 👋</h1>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--red)' }}>
          <span>⚠️ {error}</span>
          <button className="btn-retry" onClick={() => setRetryCount(c => c + 1)}>Reintentar</button>
        </div>
      )}

      {isAdmin ? (
        <>
          {paymentsSection}
          {videosSection}
          {reviewSection}
          {statsSection}
          {deadlinesSection}
        </>
      ) : (
        <>
          {statsSection}
          {deadlinesSection}
          {reviewSection}
          {videosSection}
        </>
      )}

      {projects.length === 0 && (
        <div className="empty"><div className="empty-icon">📁</div><p>No hay proyectos todavía</p><p style={{ fontSize: 12 }}>Creá uno desde la barra lateral</p></div>
      )}

      {projects.length > 0 && nothingToShow && (
        <div style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
          <p>Todo al día</p>
          <p style={{ fontSize: 12 }}>{isAdmin ? 'Sin deadlines, videos ni pagos pendientes' : 'Sin deadlines ni videos pendientes'}</p>
        </div>
      )}

      {statModalSection}
    </div>
  );
}
