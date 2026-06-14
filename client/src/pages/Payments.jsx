import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const UPWORK_OPTIONS = ['Pendiente de carga', 'Cargado', 'No'];

export default function Payments() {
  const { api, socket } = useAuth();
  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('active'); // active | completed

  useEffect(() => {
    Promise.all([api('/api/payments'), api('/api/clients')])
      .then(([p, c]) => { setProjects(p); setClients(c); setLoading(false); })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onUpdate = (p) => setProjects(prev => prev.map(x => x.id === p.id ? p : x));
    socket.on('payment:updated', onUpdate);
    return () => socket.off('payment:updated', onUpdate);
  }, [socket]);

  const updatePayment = async (projectId, changes) => {
    const updated = await api(`/api/payments/${projectId}`, { method: 'PATCH', body: changes });
    setProjects(prev => prev.map(p => p.id === projectId ? updated : p));
  };

  const getTotal = (p) => {
    if (p.payment_type === 'hourly') return (parseFloat(p.payment_amount) || 0) * (parseFloat(p.payment_hours) || 0);
    return parseFloat(p.payment_amount) || 0;
  };

  const initials = (name) => name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const isCompleted = (p) => p.editor_paid === 'paid' && p.client_paid === 'cobrado';

  const activeProjects = projects.filter(p => !isCompleted(p));
  const completedProjects = projects.filter(p => isCompleted(p));

  // Group by client
  const groupByClient = (projs) => {
    const groups = {};
    projs.forEach(p => {
      const key = p.client_name || '__none__';
      if (!groups[key]) groups[key] = { name: p.client_name || 'Sin cliente', color: p.client_color || '#888', email: p.client_email, projects: [] };
      groups[key].projects.push(p);
    });
    return Object.values(groups);
  };

  const totalEditorPending = activeProjects.filter(p => p.editor_paid !== 'paid').reduce((s, p) => s + getTotal(p), 0);
  const totalClientPending = activeProjects.filter(p => p.client_paid !== 'cobrado').reduce((s, p) => s + getTotal(p), 0);
  const readyToCollect = activeProjects.filter(p => p.editor_paid !== 'paid' || p.client_paid !== 'cobrado').length;

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  const renderTable = (projs, isHistory) => (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <td colSpan={4} style={{ padding: 0, border: 'none' }} />
            <td colSpan={2} style={{ padding: '4px 12px', background: 'rgba(236,72,153,0.08)', color: '#be185d', fontSize: 10, fontWeight: 500, textAlign: 'center', letterSpacing: '0.05em', textTransform: 'uppercase' }}>— Editor —</td>
            <td style={{ borderLeft: '1px solid var(--border)' }} />
            <td colSpan={2} style={{ padding: '4px 12px', background: 'rgba(99,102,241,0.08)', color: '#4338ca', fontSize: 10, fontWeight: 500, textAlign: 'center', letterSpacing: '0.05em', textTransform: 'uppercase' }}>— Cliente —</td>
          </tr>
          <tr style={{ background: 'var(--bg3)' }}>
            {['Proyecto','Editor','Tipo','Upwork'].map(h => (
              <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 10, color: 'var(--text3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
            <th style={{ padding: '7px 12px', textAlign: 'right', fontSize: 10, color: '#be185d', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', background: 'rgba(236,72,153,0.05)' }}>Monto</th>
            <th style={{ padding: '7px 12px', fontSize: 10, color: '#be185d', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', background: 'rgba(236,72,153,0.05)', whiteSpace: 'nowrap' }}>Pagado al editor</th>
            <th style={{ padding: '7px 12px', textAlign: 'right', fontSize: 10, color: '#4338ca', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', background: 'rgba(99,102,241,0.05)', borderLeft: '1px solid var(--border)' }}>Monto</th>
            <th style={{ padding: '7px 12px', fontSize: 10, color: '#4338ca', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', background: 'rgba(99,102,241,0.05)', whiteSpace: 'nowrap' }}>Cobrado al cliente</th>
          </tr>
        </thead>
        <tbody>
          {projs.map(p => (
            <ProjectRow key={p.id} project={p} onUpdate={isHistory ? null : updatePayment} getTotal={getTotal} initials={initials} isHistory={isHistory} />
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div style={{ padding: '0 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>💰</span>
          <h2 style={{ fontWeight: 700, fontSize: 18 }}>Pagos</h2>
          <span style={{ fontSize: 11, background: 'rgba(245,158,11,0.12)', color: '#f59e0b', padding: '2px 8px', borderRadius: 8, fontWeight: 600 }}>🔒 Solo admin</span>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg3)', padding: 3, borderRadius: 9 }}>
          {[['active','Activos'],['completed','Completados']].map(([val, label]) => (
            <button key={val} onClick={() => setTab(val)} style={{ padding: '5px 14px', borderRadius: 7, border: 'none', fontFamily: 'var(--font)', fontSize: 12, cursor: 'pointer', background: tab === val ? 'var(--bg2)' : 'transparent', color: tab === val ? 'var(--text)' : 'var(--text2)', fontWeight: tab === val ? 600 : 400 }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: '20px 24px' }}>

        {tab === 'active' && (
          <>
            {/* Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 24 }}>
              {[
                { label: 'Por pagar a editores', val: `$${totalEditorPending.toFixed(0)}`, color: '#be185d' },
                { label: 'Por cobrar a clientes', val: `$${totalClientPending.toFixed(0)}`, color: '#4338ca' },
                { label: 'Proyectos pendientes', val: readyToCollect, color: 'var(--yellow)' },
                { label: 'Proyectos vinculados', val: activeProjects.length, color: 'var(--accent2)' },
              ].map(m => (
                <div key={m.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{m.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: m.color }}>{m.val}</div>
                </div>
              ))}
            </div>

            {activeProjects.length === 0 && (
              <div className="empty"><div className="empty-icon">💰</div><p>Sin proyectos activos con pago asignado</p></div>
            )}

            {groupByClient(activeProjects).map(client => (
              <div key={client.name} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', marginBottom: 14 }}>
                <div style={{ padding: '10px 16px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: client.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                    {client.name[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{client.name}</span>
                    {client.email && <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>{client.email}</span>}
                  </div>
                  {client.projects.some(p => p.editor_paid !== 'paid' || p.client_paid !== 'cobrado') && (
                    <span style={{ fontSize: 10, background: 'rgba(124,106,247,0.15)', color: 'var(--accent2)', padding: '2px 8px', borderRadius: 8, fontWeight: 600 }}>
                      {client.projects.filter(p => p.editor_paid !== 'paid' || p.client_paid !== 'cobrado').length} pendiente(s)
                    </span>
                  )}
                </div>
                {renderTable(client.projects, false)}
              </div>
            ))}
          </>
        )}

        {tab === 'completed' && (
          <>
            {completedProjects.length === 0 && (
              <div className="empty"><div className="empty-icon">✅</div><p>Aún no hay proyectos completados</p><p style={{ fontSize: 12 }}>Cuando un proyecto tenga el editor pagado y el cliente cobrado, aparecerá acá como registro histórico</p></div>
            )}
            {groupByClient(completedProjects).map(client => (
              <div key={client.name} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', marginBottom: 14, opacity: 0.85 }}>
                <div style={{ padding: '10px 16px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: client.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                    {client.name[0].toUpperCase()}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{client.name}</span>
                  <span style={{ fontSize: 10, background: 'rgba(34,201,122,0.12)', color: 'var(--green)', padding: '2px 8px', borderRadius: 8, fontWeight: 600 }}>✓ Todo resuelto</span>
                </div>
                {renderTable(client.projects, true)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project: p, onUpdate, getTotal, initials, isHistory }) {
  const [hours, setHours] = useState(p.payment_hours || 0);
  const total = getTotal(p);

  return (
    <tr style={{ borderBottom: '1px solid var(--border)', opacity: isHistory ? 0.7 : 1 }}
      onMouseEnter={e => { if (!isHistory) e.currentTarget.style.background = 'var(--bg3)'; }}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

      {/* Proyecto */}
      <td style={{ padding: '9px 12px' }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{p.name}</div>
        {p.payment_type === 'hourly' && (
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
            ${p.payment_amount}/h ·{' '}
            {isHistory ? `${p.payment_hours}h` : (
              <input type="number" min="0" value={hours}
                onChange={e => setHours(e.target.value)}
                onBlur={() => onUpdate && onUpdate(p.id, { payment_hours: hours })}
                style={{ width: 40, background: 'var(--bg4)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 11, padding: '1px 4px', textAlign: 'center' }} />
            )}
            {' '}h
          </div>
        )}
      </td>

      {/* Editor */}
      <td style={{ padding: '9px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 20, height: 20, borderRadius: '50%', background: p.editor_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff' }}>
            {initials(p.editor_name)}
          </div>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>{p.editor_name}</span>
        </div>
      </td>

      {/* Tipo */}
      <td style={{ padding: '9px 12px' }}>
        <span style={{ fontSize: 10, background: 'var(--bg4)', color: 'var(--text3)', padding: '2px 7px', borderRadius: 8 }}>
          {p.payment_type === 'hourly' ? 'Horas' : 'Fijo'}
        </span>
      </td>

      {/* Upwork */}
      <td style={{ padding: '9px 12px' }}>
        {isHistory ? (
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.upwork_status || 'Pendiente'}</span>
        ) : (
          <select value={p.upwork_status || 'Pendiente de carga'}
            onChange={e => onUpdate(p.id, { upwork_status: e.target.value })}
            style={{ fontSize: 11, padding: '3px 6px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
            {UPWORK_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        )}
      </td>

      {/* Monto editor */}
      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text)', background: 'rgba(236,72,153,0.03)' }}>
        ${total.toFixed(0)}
      </td>

      {/* Pagado al editor */}
      <td style={{ padding: '9px 12px', background: 'rgba(236,72,153,0.03)' }}>
        {isHistory ? (
          <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>✓ Pagado</span>
        ) : (
          <select value={p.editor_paid || 'unpaid'}
            onChange={e => onUpdate(p.id, { editor_paid: e.target.value })}
            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: `1px solid ${p.editor_paid === 'paid' ? 'rgba(34,201,122,0.4)' : 'rgba(240,92,92,0.4)'}`, background: p.editor_paid === 'paid' ? 'rgba(34,201,122,0.1)' : 'rgba(240,92,92,0.1)', color: p.editor_paid === 'paid' ? 'var(--green)' : 'var(--red)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600 }}>
            <option value="unpaid">Sin pagar</option>
            <option value="paid">Pagado ✓</option>
          </select>
        )}
      </td>

      {/* Monto cliente */}
      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text)', background: 'rgba(99,102,241,0.03)', borderLeft: '1px solid var(--border)' }}>
        ${total.toFixed(0)}
      </td>

      {/* Cobrado al cliente */}
      <td style={{ padding: '9px 12px', background: 'rgba(99,102,241,0.03)' }}>
        {isHistory ? (
          <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>✓ Cobrado</span>
        ) : (
          <select value={p.client_paid || 'unpaid'}
            onChange={e => onUpdate(p.id, { client_paid: e.target.value })}
            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: `1px solid ${p.client_paid === 'cobrado' ? 'rgba(34,201,122,0.4)' : 'rgba(240,92,92,0.4)'}`, background: p.client_paid === 'cobrado' ? 'rgba(34,201,122,0.1)' : 'rgba(240,92,92,0.1)', color: p.client_paid === 'cobrado' ? 'var(--green)' : 'var(--red)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600 }}>
            <option value="unpaid">Sin cobrar</option>
            <option value="cobrado">Cobrado ✓</option>
          </select>
        )}
      </td>
    </tr>
  );
}
