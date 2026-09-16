import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials, deadlineLabel } from '../utils/format';

const VIDEOS_PREVIEW_LIMIT = 5;
const PAYMENTS_PREVIEW_LIMIT = 5;

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

  const projectIds = projects.map(p => p.id).join(',');
  useEffect(() => {
    setError('');
    api('/api/clients').then(setClients).catch(e => { console.error(e); setError('No se pudo cargar toda la información del dashboard. Puede ser un problema de conexión.'); });
    api('/api/dashboard/pending-videos').then(setPendingVideos).catch(e => { console.error(e); setError('No se pudo cargar toda la información del dashboard. Puede ser un problema de conexión.'); });
    if (isAdmin) {
      api('/api/payments').then(setPayments).catch(e => { console.error(e); setError('No se pudo cargar toda la información del dashboard. Puede ser un problema de conexión.'); });
    }
    projects.forEach(p => {
      api(`/api/projects/${p.id}/tasks`).then(t => setTasks(prev => ({ ...prev, [p.id]: t }))).catch(console.error);
    });
  }, [projectIds, retryCount, isAdmin]);

  const allTasks = Object.values(tasks).flat();
  const pendingTasks = allTasks.filter(t => t.status !== 'done');
  // Un proyecto ya marcado "Terminado" no necesita más recordatorios de deadline ni de
  // aprobación — si algo quedó suelto ahí (una tarea en revisión, un deadline próximo) ya no es
  // información accionable para el Dashboard.
  const completedProjectIds = new Set(projects.filter(p => p.status === 'completed').map(p => p.id));
  const deadlineSoon = projects.filter(p => p.deadline && p.status !== 'completed').sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const reviewedVideoTaskIds = new Set(pendingVideos.filter(v => v.type === 'review' && v.task_id).map(v => v.task_id));
  const reviewTasks = allTasks.filter(t => t.status === 'review' && !reviewedVideoTaskIds.has(t.id) && !completedProjectIds.has(t.project_id));

  // Pagos pendientes: proyectos ya terminados a los que todavía les falta pagarle al editor
  // y/o cobrarle al cliente — mismo cálculo que usa la página de Pagos.
  const getEditorTotal = p => p.payment_type === 'hourly' ? (parseFloat(p.payment_amount) || 0) * (parseFloat(p.payment_hours) || 0) : (parseFloat(p.payment_amount) || 0);
  const getClientTotal = p => p.payment_type === 'hourly' ? (parseFloat(p.client_amount) || 0) * (parseFloat(p.payment_hours) || 0) : (parseFloat(p.client_amount) || 0);
  // Proyectos facturados vía Upwork: lo que se carga en "Cobro cliente" es el bruto — Upwork se
  // queda con upwork_fee_pct% antes de que llegue a la cuenta.
  const isUpworkBilled = p => p.upwork_status === 'Pendiente de carga' || p.upwork_status === 'Cargado';
  const getClientNet = p => {
    const gross = getClientTotal(p);
    if (!isUpworkBilled(p)) return gross;
    return gross * (1 - (parseFloat(p.upwork_fee_pct) || 0) / 100);
  };
  // Cuando el editor asignado sos vos mismo no hay pago real que marcar — se trata como
  // "resuelto" en ese lado en vez de quedar eternamente pendiente por un toggle que nunca aplica.
  const editorSettled = p => p.payment_editor_id === user?.id || p.editor_paid === 'paid';
  const unpaidPayments = payments.filter(p => !editorSettled(p) || p.client_paid !== 'cobrado');
  const totalEditorPending = unpaidPayments.filter(p => !editorSettled(p)).reduce((s, p) => s + getEditorTotal(p), 0);
  const totalClientPending = unpaidPayments.filter(p => p.client_paid !== 'cobrado').reduce((s, p) => s + getClientNet(p), 0);

  const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' };
  const onRowEnter = e => e.currentTarget.style.borderColor = 'var(--border2)';
  const onRowLeave = e => e.currentTarget.style.borderColor = 'var(--border)';
  const sectionTitleStyle = { fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' };
  const sectionLinkStyle = { fontSize: 12, color: 'var(--accent2)', fontWeight: 600, cursor: 'pointer' };

  const statsSection = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
      {[
        { label: 'Proyectos activos', val: projects.filter(p => p.status !== 'completed').length, color: 'var(--text)' },
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
  );

  const deadlinesSection = deadlineSoon.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...sectionTitleStyle, marginBottom: 8 }}>Próximos deadlines</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {deadlineSoon.slice(0, 5).map(p => {
          const dl = deadlineLabel(p.deadline);
          return (
            <div key={p.id} onClick={() => navigate(`/project/${p.id}`)} style={rowStyle} onMouseEnter={onRowEnter} onMouseLeave={onRowLeave}>
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
  );

  const reviewSection = reviewTasks.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...sectionTitleStyle, marginBottom: 8 }}>{isAdmin ? 'Esperando tu aprobación' : 'Esperando aprobación del admin'}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {reviewTasks.map(t => {
          const proj = projects.find(p => p.id === t.project_id);
          return (
            <div key={t.id} onClick={() => navigate(`/project/${t.project_id}`)} style={rowStyle} onMouseEnter={onRowEnter} onMouseLeave={onRowLeave}>
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
          <div key={v.id} onClick={() => navigate(`/project/${v.project_id}?tab=videos`)} style={rowStyle} onMouseEnter={onRowEnter} onMouseLeave={onRowLeave}>
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
  );

  const paymentsSection = isAdmin && unpaidPayments.length > 0 && (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={sectionTitleStyle}>💰 Pagos pendientes</div>
        <span onClick={() => navigate('/payments')} style={sectionLinkStyle}>Ir a Pagos →</span>
      </div>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px 6px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          <div style={{ background: 'var(--bg3)', borderRadius: 9, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Total a pagar a editores</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--red)' }}>${totalEditorPending.toFixed(0)}</div>
          </div>
          <div style={{ background: 'var(--bg3)', borderRadius: 9, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Total a cobrar de clientes</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--blue)' }}>${totalClientPending.toFixed(0)}</div>
          </div>
        </div>
        {unpaidPayments.slice(0, PAYMENTS_PREVIEW_LIMIT).map((p, i) => {
          const missingEditor = !editorSettled(p);
          const missingClient = p.client_paid !== 'cobrado';
          const chipColor = missingEditor && missingClient ? 'var(--yellow)' : missingEditor ? 'var(--red)' : 'var(--blue)';
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
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 7, fontWeight: 600, whiteSpace: 'nowrap', background: `${chipColor}22`, color: chipColor }}>
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
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Hola, {user?.name?.split(' ')[0]} 👋</h1>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--red)' }}>
          <span>⚠️ {error}</span>
          <button onClick={() => setRetryCount(c => c + 1)} style={{ background: 'transparent', border: '1px solid var(--red)', borderRadius: 6, padding: '3px 10px', color: 'var(--red)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>Reintentar</button>
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
    </div>
  );
}
