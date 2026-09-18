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

  // "Terminado" (status del proyecto) y "tarea en done" son dos cosas distintas — un proyecto se
  // marca terminado a mano cuando ya no se le van a sumar más tareas, sin importar en qué estado
  // quedaron esas tareas. Antes esta vista mezclaba todo: un cliente con proyectos ya terminados
  // y pasados a Pagos los mostraba igual que los activos, sin ninguna forma de distinguirlos.
  const activeProjects = clientProjects.filter(p => p.status !== 'completed');
  const completedProjects = clientProjects.filter(p => p.status === 'completed');
  // Un proyecto terminado no necesita más seguimiento de tareas — solo cuentan las de los activos.
  const activeTasks = activeProjects.flatMap(p => tasks[p.id] || []);
  const totalActiveTasks = activeTasks.length;
  const reviewTasks = activeTasks.filter(t => t.status === 'review').length;
  const doneTasks = activeTasks.filter(t => t.status === 'done').length;
  const pendingTasks = totalActiveTasks - doneTasks;
  // Solo para admin (client_paid/editor_paid no le llegan a un editor) — para saber de un vistazo
  // si a un proyecto terminado todavía le falta cobrarle al cliente y/o pagarle al editor.
  const isAdmin = user?.role === 'admin';
  const editorSettled = (p) => p.payment_editor_id === user?.id || p.editor_paid === 'paid';
  const isPaymentSettled = (p) => editorSettled(p) && p.client_paid === 'cobrado';

  if (!client) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: client.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#fff' }}>
          {client.name[0].toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800 }}>{client.name}</h1>
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
          { label: 'Proyectos activos', val: activeProjects.length, color: 'var(--text)' },
          { label: 'Tareas pendientes', val: pendingTasks, color: pendingTasks > 0 ? 'var(--yellow)' : 'var(--green)' },
          { label: 'En revisión', val: reviewTasks, color: reviewTasks > 0 ? 'var(--red)' : 'var(--text3)' },
          { label: 'Proyectos terminados', val: completedProjects.length, color: 'var(--green)' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: s.color }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Projects list */}
      {clientProjects.length === 0 && (
        <div className="empty"><div className="empty-icon">📁</div><p>Sin proyectos para este cliente</p></div>
      )}

      {activeProjects.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Activos ({activeProjects.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: completedProjects.length > 0 ? 24 : 0 }}>
            {activeProjects.map(p => renderProjectCard(p))}
          </div>
        </>
      )}

      {completedProjects.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Terminados ({completedProjects.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {completedProjects.map(p => renderProjectCard(p, true))}
          </div>
        </>
      )}
    </div>
  );

  // Se define acá adentro (no afuera del componente) porque usa `tasks`/`navigate`/`isAdmin`, ya
  // resueltos en este render — evita pasar 4-5 props sueltas a un componente aparte para algo que
  // solo se usa en este único lugar.
  function renderProjectCard(p, isDone) {
    const pTasks = tasks[p.id] || [];
    const total = pTasks.length;
    const done = pTasks.filter(t => t.status === 'done').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const dl = deadlineLabel(p.deadline);
    const statusCounts = {};
    pTasks.forEach(t => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });
    const settled = isDone && isAdmin ? isPaymentSettled(p) : null;

    return (
      <div key={p.id} className="card"
        onDoubleClick={() => navigate(`/project/${p.id}`)}
        style={{ cursor: 'pointer', transition: 'border-color 0.15s', opacity: isDone ? 0.85 : 1 }}
        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
        {/* Top row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{p.name}</span>
          {isDone && (
            <span className="badge" style={{ fontSize: 10, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>
              ✓ Terminado
            </span>
          )}
          {settled !== null && (
            <span className="badge" style={{ fontSize: 10, background: settled ? 'rgba(34,201,122,0.12)' : 'rgba(240,168,58,0.12)', color: settled ? 'var(--green)' : 'var(--yellow)' }}>
              {settled ? '💰 Saldado' : '💰 Pago pendiente'}
            </span>
          )}
          {p.payment_editor_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: p.payment_editor_color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff' }}>
                {initials(p.payment_editor_name)}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.payment_editor_name}</span>
            </div>
          )}
          {dl && <span className="badge" style={{ fontWeight: 500, background: dl.bg, color: dl.color }}>{dl.label}</span>}
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
              <span key={status} className="badge" style={{ fontSize: 10, background: `${STATUS_COLORS[status]}18`, color: STATUS_COLORS[status] }}>
                {STATUS_LABELS[status]} {count}
              </span>
            ))}
          </div>
        )}
        {total === 0 && <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin tareas</span>}
      </div>
    );
  }
}
