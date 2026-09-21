import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';
import { initials, monthKey } from '../utils/format';

const UPWORK_OPTIONS = ['Pendiente de carga', 'Cargado', 'No'];

export default function Payments() {
  const { api, socket } = useAuth();
  const { alert } = useAlert();
  const { openEditProject } = useOutletContext();
  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('active'); // active | completed | monthly
  const [filterClient, setFilterClient] = useState('');
  const [filterEditor, setFilterEditor] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(() => {
    // toISOString() es UTC: en UTC-3, del 1 de mes a la madrugada abría el balance del mes
    // anterior. Se arma en local.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }); // YYYY-MM
  const [pendingComplete, setPendingComplete] = useState(null); // { projectId, changes } | null

  const [ledger, setLedger] = useState([]);

  useEffect(() => {
    Promise.all([api('/api/payments'), api('/api/clients'), api('/api/payments/ledger')])
      .then(([p, c, l]) => { setProjects(p); setClients(c); setLedger(l); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!socket) return;
    // El ledger se recarga entero en vez de mergear: un proyecto puede entrar o salir de él según
    // se marque/desmarque un lado, así que reemplazar la fila no alcanzaría.
    const reloadLedger = () => api('/api/payments/ledger').then(setLedger).catch(console.error);
    const onUpdate = (p) => { setProjects(prev => prev.map(x => x.id === p.id ? p : x)); reloadLedger(); };
    // El editor del sidebar (mismo modal que ahora abre el lápiz de acá) guarda vía PUT
    // /api/projects/:id, que trae otros nombres de campo (payment_editor_name, no editor_name) —
    // más simple recargar la lista entera que mergear formas distintas de la misma fila.
    const onProjectUpdate = () => { api('/api/payments').then(setProjects).catch(console.error); reloadLedger(); };
    socket.on('payment:updated', onUpdate);
    socket.on('project:updated', onProjectUpdate);
    return () => { socket.off('payment:updated', onUpdate); socket.off('project:updated', onProjectUpdate); };
  }, [socket]);

  const updatePayment = async (projectId, changes) => {
    try {
      const updated = await api(`/api/payments/${projectId}`, { method: 'PATCH', body: changes });
      setProjects(prev => prev.map(p => p.id === projectId ? updated : p));
      api('/api/payments/ledger').then(setLedger).catch(console.error);
    } catch (e) { console.error(e); await alert('Error al actualizar el pago: ' + e.message); }
  };

  // Pasar a "Saldados" no debería ser automático — se pide confirmación (con el modal propio
  // de la app, no window.confirm) solo cuando el cambio hace que AMBOS lados queden saldados.
  const requestUpdate = (projectId, changes, wouldComplete) => {
    if (wouldComplete) setPendingComplete({ projectId, changes });
    else updatePayment(projectId, changes);
  };
  const confirmPendingComplete = () => {
    if (pendingComplete) updatePayment(pendingComplete.projectId, pendingComplete.changes);
    setPendingComplete(null);
  };

  // Proyectos facturados vía Upwork: lo que carga el admin en "Cobro cliente" es el bruto que
  // ve el cliente — Upwork se queda con upwork_fee_pct% antes de que llegue a la cuenta.
  const isUpworkBilled = (p) => p.upwork_status === 'Pendiente de carga' || p.upwork_status === 'Cargado';

  // computed_editor_total/computed_client_gross/computed_client_net vienen calculados del
  // servidor (congelado si ya está pagado/cobrado, en vivo si no) — antes esta cuenta estaba
  // reimplementada acá a mano (y de nuevo en Dashboard.jsx, y de nuevo en el servidor); si cambiaba
  // una regla de negocio (ej. el neto de Upwork) había que acordarse de tocar los 3 lugares.

  // Cuando el editor asignado sos vos mismo no hay pago real que marcar — se trata como
  // "resuelto" en ese lado en vez de quedar eternamente pendiente por un toggle que nunca aplica.
  // editor_is_owner viene calculado del servidor (ver withComputedTotals/OWNER_EMAIL en
  // server/index.js) — es específicamente el dueño de la agencia, no "cualquier admin" ni "quien
  // esté logueado ahora". Antes comparaba contra user.id, así que un segundo admin viendo el
  // proyecto de OTRO admin editor lo veía como si fuera su propio pago exento.
  const editorSettled = (p) => p.editor_is_owner || p.editor_paid === 'paid';

  const isCompleted = (p) => editorSettled(p) && p.client_paid === 'cobrado';

  const applyFilters = (projs) => {
    let filtered = projs;
    if (filterClient) filtered = filtered.filter(p => (p.client_name || '') === filterClient);
    if (filterEditor) filtered = filtered.filter(p => (p.editor_name || '') === filterEditor);
    return filtered;
  };

  const activeProjects = applyFilters(projects.filter(p => !isCompleted(p)));
  const completedProjects = applyFilters(projects.filter(p => isCompleted(p)));

  const allClients = [...new Set(projects.map(p => p.client_name).filter(Boolean))].sort();
  const allEditors = [...new Set(projects.map(p => p.editor_name).filter(Boolean))].sort();

  // Group by client
  const groupByClient = (projs) => {
    const groups = {};
    projs.forEach(p => {
      const key = p.client_name || '__none__';
      if (!groups[key]) groups[key] = { name: p.client_name || 'Sin cliente', color: p.client_color || 'var(--text3)', email: p.client_email, projects: [] };
      groups[key].projects.push(p);
    });
    return Object.values(groups);
  };

  const totalEditorPending = activeProjects.filter(p => !editorSettled(p)).reduce((s, p) => s + p.computed_editor_total, 0);
  const totalClientPending = activeProjects.filter(p => p.client_paid !== 'cobrado').reduce((s, p) => s + p.computed_client_net, 0);
  // Cuántos clientes distintos (no proyectos) tienen algo pendiente — para saber a cuánta gente
  // hay que hacerle seguimiento, no solo cuántos proyectos. "activeProjects" ya es por definición
  // "proyectos no saldados del todo" (!isCompleted), así que contar proyectos acá de nuevo con otro
  // filtro (como se hacía antes) siempre da el mismo número que activeProjects.length — dos
  // recuadros mostrando literalmente el mismo dato con nombres distintos.
  const clientsPending = new Set(activeProjects.map(p => p.client_name || '__none__')).size;

  // Balance mensual: se basa en la fecha real en que se marcó pagado/cobrado cada lado (no en
  // el estado actual), así que un proyecto puede aportar al mes del cliente y al mes del editor
  // por separado si no se saldaron al mismo tiempo. Cuando el editor asignado es el dueño de la
  // agencia, ese "pago" no es un gasto real — no cuenta en "Pagado a editores".
  // Se calcula sobre `ledger` (todo proyecto con plata registrada) y NO sobre `projects` (que
  // solo trae trabajo ya terminado): si no, un anticipo cobrado en julio sobre un proyecto
  // todavía activo no contaba en julio y aparecía después, agrandando un mes ya cerrado.
  const receivedThisMonth = ledger.filter(p => monthKey(p.client_paid_at) === selectedMonth);
  const paidToEditorsThisMonth = ledger.filter(p => monthKey(p.editor_paid_at) === selectedMonth && !p.editor_is_owner);
  const totalReceivedMonth = receivedThisMonth.reduce((s, p) => s + p.computed_client_net, 0);
  const totalPaidEditorsMonth = paidToEditorsThisMonth.reduce((s, p) => s + p.computed_editor_total, 0);
  const totalUpworkFeeMonth = receivedThisMonth.reduce((s, p) => s + (p.computed_client_gross - p.computed_client_net), 0);

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  const thStyle = { padding: '7px 12px', textAlign: 'left', fontSize: 10, color: 'var(--text3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };

  const renderTable = (projs, isHistory) => {
    const sorted = isHistory ? [...projs].sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0)) : projs;
    const baseCols = isHistory ? 5 : 4;
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 1000, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 }}>
          <colgroup>
            <col style={{ width: 230 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 110 }} />
            {isHistory && <col style={{ width: 110 }} />}
            <col style={{ width: 90 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <td colSpan={baseCols} style={{ padding: 0, border: 'none' }} />
              <td colSpan={2} style={{ padding: '4px 12px', background: 'rgba(236,72,153,0.08)', color: 'var(--pink)', fontSize: 10, fontWeight: 500, textAlign: 'center', letterSpacing: '0.05em', textTransform: 'uppercase' }}>— Editor —</td>
              <td colSpan={2} style={{ padding: '4px 12px', background: 'rgba(99,102,241,0.08)', color: 'var(--lavender)', fontSize: 10, fontWeight: 500, textAlign: 'center', letterSpacing: '0.05em', textTransform: 'uppercase', borderLeft: '1px solid var(--border)' }}>— Cliente —</td>
            </tr>
            <tr style={{ background: 'var(--bg3)' }}>
              {['Proyecto','Editor','Tipo','Upwork'].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
              {isHistory && <th style={thStyle}>Saldado</th>}
              <th style={{ ...thStyle, textAlign: 'right', color: 'var(--pink)', background: 'rgba(236,72,153,0.05)' }}>Monto</th>
              <th style={{ ...thStyle, color: 'var(--pink)', background: 'rgba(236,72,153,0.05)' }}>Pagado al editor</th>
              <th style={{ ...thStyle, textAlign: 'right', color: 'var(--lavender)', background: 'rgba(99,102,241,0.05)', borderLeft: '1px solid var(--border)' }}>Monto</th>
              <th style={{ ...thStyle, color: 'var(--lavender)', background: 'rgba(99,102,241,0.05)' }}>Cobrado al cliente</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(p => (
              <ProjectRow key={p.id} project={p} onUpdate={updatePayment} onRequestUpdate={requestUpdate} isHistory={isHistory} onEdit={openEditProject} />
            ))}
            {isHistory && sorted.length > 0 && (
              <tr style={{ background: 'var(--bg3)', fontWeight: 600 }}>
                <td colSpan={baseCols} style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text2)' }}>Total ({sorted.length} proyecto{sorted.length > 1 ? 's' : ''})</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--pink)', background: 'rgba(236,72,153,0.05)' }}>${sorted.reduce((s, p) => s + p.computed_editor_total, 0).toFixed(0)}</td>
                <td style={{ background: 'rgba(236,72,153,0.05)' }} />
                <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--lavender)', background: 'rgba(99,102,241,0.05)', borderLeft: '1px solid var(--border)' }}>${sorted.reduce((s, p) => s + p.computed_client_gross, 0).toFixed(0)}</td>
                <td style={{ background: 'rgba(99,102,241,0.05)' }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div style={{ padding: '0 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>💰</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--fs-xl)' }}>Pagos</h1>
          <span className="badge" style={{ background: 'rgba(240,168,58,0.12)', color: 'var(--yellow)' }}>🔒 Solo admin</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select value={filterClient} onChange={e => setFilterClient(e.target.value)}
              style={{ fontSize: 11, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)', background: filterClient ? 'var(--accent-glow)' : 'var(--bg3)', color: filterClient ? 'var(--accent2)' : 'var(--text2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
              <option value="">Todos los clientes</option>
              {allClients.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterEditor} onChange={e => setFilterEditor(e.target.value)}
              style={{ fontSize: 11, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)', background: filterEditor ? 'var(--accent-glow)' : 'var(--bg3)', color: filterEditor ? 'var(--accent2)' : 'var(--text2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
              <option value="">Todos los editores</option>
              {allEditors.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
            {(filterClient || filterEditor) && (
              <button onClick={() => { setFilterClient(''); setFilterEditor(''); }}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>✕ Limpiar</button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 2, background: 'var(--bg3)', padding: 3, borderRadius: 9 }}>
              {[['active','Por cobrar/pagar'],['completed','Saldados']].map(([val, label]) => (
                <button key={val} onClick={() => setTab(val)} style={{ padding: '5px 14px', borderRadius: 7, border: 'none', fontFamily: 'var(--font)', fontSize: 12, cursor: 'pointer', background: tab === val ? 'var(--bg2)' : 'transparent', color: tab === val ? 'var(--text)' : 'var(--text2)', fontWeight: tab === val ? 600 : 400 }}>{label}</button>
              ))}
            </div>
            <button onClick={() => setTab('monthly')} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 9, border: 'none', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: tab === 'monthly' ? 'var(--accent)' : 'var(--accent-glow)',
              color: tab === 'monthly' ? '#fff' : 'var(--accent2)'
            }}>📊 Balance mensual</button>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 24px' }}>

        {tab === 'active' && (
          <>
            {/* Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 24 }}>
              {[
                { label: 'Por pagar a editores', val: `$${totalEditorPending.toFixed(0)}`, color: 'var(--pink)' },
                { label: 'Por cobrar a clientes', val: `$${totalClientPending.toFixed(0)}`, color: 'var(--lavender)' },
                { label: 'Proyectos con pago pendiente', val: activeProjects.length, color: 'var(--yellow)' },
                { label: 'Clientes con pago pendiente', val: clientsPending, color: 'var(--accent2)' },
              ].map(m => (
                <div key={m.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{m.label}</div>
                  <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: m.color }}>{m.val}</div>
                </div>
              ))}
            </div>

            {activeProjects.length === 0 && (
              <div className="empty"><div className="empty-icon">💰</div><p>Sin proyectos con pago pendiente de cobrar o pagar</p></div>
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
                  {client.projects.some(p => !editorSettled(p) || p.client_paid !== 'cobrado') && (
                    <span className="badge" style={{ fontSize: 10, background: 'rgba(124,106,247,0.15)', color: 'var(--accent2)' }}>
                      {client.projects.filter(p => !editorSettled(p) || p.client_paid !== 'cobrado').length} pendiente(s)
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
              <div className="empty"><div className="empty-icon">✅</div><p>Aún no hay proyectos saldados</p><p style={{ fontSize: 12 }}>Cuando un proyecto tenga el editor pagado y el cliente cobrado, aparecerá acá como registro histórico</p></div>
            )}
            {groupByClient(completedProjects).map(client => (
              <div key={client.name} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', marginBottom: 14, opacity: 0.85 }}>
                <div style={{ padding: '10px 16px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: client.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                    {client.name[0].toUpperCase()}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{client.name}</span>
                  <span className="badge" style={{ fontSize: 10, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>✓ Todo resuelto</span>
                </div>
                {renderTable(client.projects, true)}
              </div>
            ))}
          </>
        )}

        {tab === 'monthly' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600 }}>Mes:</label>
              <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
                className="input" style={{ width: 210, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--text3)', textTransform: 'capitalize' }}>
                {new Date(`${selectedMonth}-02`).toLocaleDateString('es', { month: 'long', year: 'numeric' })}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 24 }}>
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Recibido de clientes</div>
                <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--lavender)' }}>${totalReceivedMonth.toFixed(0)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{receivedThisMonth.length} proyecto{receivedThisMonth.length !== 1 ? 's' : ''}</div>
              </div>
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Pagado a editores</div>
                <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--pink)' }}>${totalPaidEditorsMonth.toFixed(0)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{paidToEditorsThisMonth.length} proyecto{paidToEditorsThisMonth.length !== 1 ? 's' : ''}{projects.some(p => p.editor_paid_at && p.editor_paid_at.slice(0, 7) === selectedMonth && p.editor_is_owner) ? ' · no incluye tus proyectos propios' : ''}</div>
              </div>
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Ganancia del mes</div>
                <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: (totalReceivedMonth - totalPaidEditorsMonth) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  ${(totalReceivedMonth - totalPaidEditorsMonth).toFixed(0)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Recibido − pagado a editores</div>
              </div>
            </div>

            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 16, marginTop: -10 }}>
              "Recibido de clientes" ya descuenta la comisión de Upwork en los proyectos facturados así
              {totalUpworkFeeMonth > 0 && <> — este mes se fueron <strong style={{ color: 'var(--text2)' }}>${totalUpworkFeeMonth.toFixed(0)}</strong> en comisiones</>} — "Pagado a editores" nunca se ve afectado por ese %, es siempre el monto fijo acordado con cada editor.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Detalle — cobrado a clientes</div>
                {receivedThisMonth.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Nada cobrado este mes</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {receivedThisMonth.map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.client_name ? `${p.client_name} · ` : ''}{p.name}</span>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--lavender)', whiteSpace: 'nowrap' }}>${p.computed_client_net.toFixed(0)}</div>
                        {isUpworkBilled(p) && (
                          <div style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>bruto ${p.computed_client_gross.toFixed(0)} · -${(p.computed_client_gross - p.computed_client_net).toFixed(0)} Upwork ({p.upwork_fee_pct || 0}%)</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Detalle — pagado a editores</div>
                {paidToEditorsThisMonth.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Nada pagado este mes</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {paidToEditorsThisMonth.map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.editor_name ? `${p.editor_name} · ` : ''}{p.name}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--pink)', whiteSpace: 'nowrap' }}>${p.computed_editor_total.toFixed(0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {pendingComplete && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setPendingComplete(null)} title="Cerrar">✕</button>
            <h2>¿Marcar como saldado?</h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>
              Vas a marcar este proyecto como pagado al editor y cobrado al cliente — va a pasar a "Saldados".
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPendingComplete(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmPendingComplete}>Sí, marcar como saldado</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectRow({ project: p, onUpdate, onRequestUpdate, isHistory, onEdit }) {
  const { confirm } = useAlert();
  const isSelfEditor = p.editor_is_owner;
  // Las horas alimentan el cálculo de LOS DOS lados (editor y cliente) cuando es por hora — si se
  // dejaran editar después de que cualquiera de los dos ya se congeló, no cambia el monto YA
  // congelado, pero sí el que se recalcularía si algún día se desmarca y se vuelve a marcar ese
  // lado como pagado — un monto distinto al original, sin ningún aviso de que pasó.
  const hoursLocked = p.editor_paid === 'paid' || p.client_paid === 'cobrado';
  const [hours, setHours] = useState(p.payment_hours || 0);
  // Si otra sesión/socket actualiza payment_hours mientras esta fila está montada (misma key={p.id}),
  // hay que reflejarlo — si no, un blur posterior pisa ese cambio con el valor local desactualizado.
  useEffect(() => { setHours(p.payment_hours || 0); }, [p.payment_hours]);
  // Única cuenta que sigue haciéndose acá en vez de leer computed_editor_total/computed_client_*
  // del servidor: `hours` es un borrador local sin guardar todavía (se guarda recién al blur del
  // input), así que el total en pantalla mientras se edita tiene que reflejar ese valor en vivo, no
  // el que ya quedó persistido. Esta fórmula tiene que coincidir con computeEditorAmount/
  // computeClientGrossAmount/computeClientNetAmount en server/index.js.
  const liveTotal = p.payment_type === 'hourly'
    ? (parseFloat(p.payment_amount) || 0) * (parseFloat(hours) || 0)
    : (parseFloat(p.payment_amount) || 0);
  const liveClientTotal = p.payment_type === 'hourly'
    ? (parseFloat(p.client_amount) || 0) * (parseFloat(hours) || 0)
    : (parseFloat(p.client_amount) || 0);
  const isUpworkBilled = p.upwork_status === 'Pendiente de carga' || p.upwork_status === 'Cargado';
  const liveClientNet = isUpworkBilled ? liveClientTotal * (1 - (parseFloat(p.upwork_fee_pct) || 0) / 100) : liveClientTotal;
  // Una vez marcado pagado/cobrado el monto queda congelado (ver PATCH /api/payments/:id en el
  // servidor) — se muestra ese valor guardado en vez de recalcular con las horas actuales.
  const total = p.editor_paid === 'paid' && p.editor_paid_amount != null ? p.editor_paid_amount : liveTotal;
  const clientTotal = p.client_paid === 'cobrado' && p.client_paid_amount_gross != null ? p.client_paid_amount_gross : liveClientTotal;
  const clientNet = p.client_paid === 'cobrado' && p.client_paid_amount_net != null ? p.client_paid_amount_net : liveClientNet;
  // Pasar a "Saldados" no debería ser automático — se pide confirmación (con el modal propio
  // de la app) solo cuando el cambio hace que AMBOS lados queden saldados a la vez (revertir uno
  // no cuenta como completar).
  const wouldComplete = (nextEditorPaid, nextClientPaid) => {
    const editorOk = isSelfEditor || nextEditorPaid === 'paid';
    const clientOk = nextClientPaid === 'cobrado';
    return editorOk && clientOk;
  };

  // Desmarcar un pago no deja rastro de cuándo se había marcado la primera vez — client_paid_at/
  // editor_paid_at se pisan al volver a marcarlo, así que puede terminar contando en un mes
  // distinto (y con un monto distinto, si cambiaron las horas o la tarifa mientras tanto) sin
  // ningún aviso. Se avisa acá, antes de que pase, en vez de dejarlo pasar en silencio.
  const confirmUnmark = async (label) => confirm(
    `Vas a desmarcar "${label}". Si lo volvés a marcar más adelante, va a contar en el mes en que lo vuelvas a marcar (no en el original), y el balance mensual de este mes va a bajar en consecuencia. ¿Continuar?`,
    { confirmText: 'Desmarcar', danger: true }
  );
  const handleEditorPaidChange = async (val) => {
    if (val === 'unpaid' && p.editor_paid === 'paid' && !await confirmUnmark('Pagado al editor')) return;
    onRequestUpdate(p.id, { editor_paid: val }, wouldComplete(val, p.client_paid));
  };
  const handleClientPaidChange = async (val) => {
    if (val === 'unpaid' && p.client_paid === 'cobrado' && !await confirmUnmark('Cobrado al cliente')) return;
    onRequestUpdate(p.id, { client_paid: val }, wouldComplete(p.editor_paid, val));
  };

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

      {/* Proyecto */}
      <td style={{ padding: '9px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{p.name}</span>
          <button onClick={() => onEdit(p)} title="Editar proyecto"
            style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 12, padding: 2, lineHeight: 1 }}>✏️</button>
        </div>
        {p.payment_type === 'hourly' && (
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
            ${p.payment_amount}/h ·{' '}
            <input type="number" min="0" value={hours} disabled={hoursLocked}
              title={hoursLocked ? 'Ya se congeló un monto con estas horas — desmarcá el pago para poder corregirlas' : undefined}
              onChange={e => { const v = e.target.value; setHours(v === '' ? '' : Math.max(0, parseFloat(v) || 0)); }}
              onBlur={() => { const h = hours === '' ? 0 : hours; setHours(h); onUpdate(p.id, { payment_hours: h }); }}
              style={{ width: 40, background: 'var(--bg4)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 11, padding: '1px 4px', textAlign: 'center', opacity: hoursLocked ? 0.5 : 1, cursor: hoursLocked ? 'not-allowed' : 'text' }} />
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
        <span className="badge" style={{ fontSize: 10, fontWeight: 400, background: 'var(--bg4)', color: 'var(--text3)', padding: '2px 7px' }}>
          {p.payment_type === 'hourly' ? 'Horas' : 'Fijo'}
        </span>
      </td>

      {/* Upwork */}
      <td style={{ padding: '9px 12px' }}>
        <select value={p.upwork_status || 'Pendiente de carga'}
          onChange={e => onUpdate(p.id, { upwork_status: e.target.value })}
          style={{ fontSize: 11, padding: '3px 6px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
          {UPWORK_OPTIONS.map(o => <option key={o}>{o}</option>)}
        </select>
      </td>

      {/* Fecha completado */}
      {isHistory && (
        <td style={{ padding: '9px 12px' }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            {p.completed_at ? new Date(p.completed_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
          </span>
        </td>
      )}

      {/* Monto editor */}
      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600, color: isSelfEditor ? 'var(--text3)' : 'var(--text)', background: 'rgba(236,72,153,0.03)' }}>
        {isSelfEditor ? '—' : `$${total.toFixed(0)}`}
      </td>

      {/* Pagado al editor */}
      <td style={{ padding: '9px 12px', background: 'rgba(236,72,153,0.03)' }}>
        {isSelfEditor ? (
          <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }} title="Sos vos el editor — no hay pago que registrar">No aplica</span>
        ) : (
          <select value={p.editor_paid || 'unpaid'}
            onChange={e => handleEditorPaidChange(e.target.value)}
            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: `1px solid ${p.editor_paid === 'paid' ? 'rgba(34,201,122,0.4)' : 'rgba(240,92,92,0.4)'}`, background: p.editor_paid === 'paid' ? 'rgba(34,201,122,0.1)' : 'rgba(240,92,92,0.1)', color: p.editor_paid === 'paid' ? 'var(--green)' : 'var(--red)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600 }}>
            <option value="unpaid">Sin pagar</option>
            <option value="paid">Pagado ✓</option>
          </select>
        )}
      </td>

      {/* Monto cliente */}
      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text)', background: 'rgba(99,102,241,0.03)', borderLeft: '1px solid var(--border)' }}>
        {isUpworkBilled ? (
          <>
            <div>${clientTotal.toFixed(0)}</div>
            <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text3)' }} title={`Neto tras ${p.upwork_fee_pct || 0}% de comisión Upwork`}>neto ${clientNet.toFixed(0)}</div>
          </>
        ) : (
          `$${clientTotal.toFixed(0)}`
        )}
      </td>

      {/* Cobrado al cliente */}
      <td style={{ padding: '9px 12px', background: 'rgba(99,102,241,0.03)' }}>
        <select value={p.client_paid || 'unpaid'}
          onChange={e => handleClientPaidChange(e.target.value)}
          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: `1px solid ${p.client_paid === 'cobrado' ? 'rgba(34,201,122,0.4)' : 'rgba(240,92,92,0.4)'}`, background: p.client_paid === 'cobrado' ? 'rgba(34,201,122,0.1)' : 'rgba(240,92,92,0.1)', color: p.client_paid === 'cobrado' ? 'var(--green)' : 'var(--red)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600 }}>
          <option value="unpaid">Sin cobrar</option>
          <option value="cobrado">Cobrado ✓</option>
        </select>
      </td>
    </tr>
  );
}
