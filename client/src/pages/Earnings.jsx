import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { monthKey } from '../utils/format';

const MONTH_LABELS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_LABELS[Number(m) - 1]} ${y}`;
}

// Vista self-scoped: cada editor ve solo lo suyo (GET /api/me/earnings ya filtra por
// payment_editor_id = quien pide). Antes esto no existía en ningún lado — el editor no podía ver
// ni siquiera su propia tarifa (stripProjectFinancials se la esconde en /api/projects), así que
// "¿me pagaste el de X?" era una pregunta que solo el admin podía contestar mirando Pagos.
export default function Earnings() {
  const { api } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setError('');
    api('/api/me/earnings')
      .then(setProjects)
      .catch(e => { console.error(e); setError('No se pudieron cargar tus ganancias. Puede ser un problema de conexión.'); })
      .finally(() => setLoading(false));
  }, [retryCount]);

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  const pending = projects.filter(p => p.editor_paid !== 'paid');
  const paid = projects.filter(p => p.editor_paid === 'paid');
  const totalPending = pending.reduce((s, p) => s + p.computed_editor_total, 0);
  const totalPaid = paid.reduce((s, p) => s + p.computed_editor_total, 0);

  // Agrupado por mes real de pago (editor_paid_at), no por fecha de creación del proyecto — es
  // el mismo criterio que usa el Balance mensual del admin en Payments.jsx.
  const paidByMonth = {};
  paid.forEach(p => {
    const key = monthKey(p.editor_paid_at) || 'Sin fecha';
    (paidByMonth[key] = paidByMonth[key] || []).push(p);
  });
  const monthKeys = Object.keys(paidByMonth).sort().reverse();

  const amountLabel = (p) => p.payment_type === 'hourly' ? `${p.payment_hours}h × $${p.payment_amount}` : 'Monto fijo';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <span style={{ fontSize: 20 }}>💵</span>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--fs-xl)' }}>Mis ganancias</h1>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: 'var(--red)' }}>
          <span>⚠️ {error}</span>
          <button className="btn-retry" onClick={() => { setLoading(true); setRetryCount(c => c + 1); }}>Reintentar</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginBottom: 24 }}>
        <div className="card">
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Pendiente de cobro</div>
          <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: totalPending > 0 ? 'var(--yellow)' : 'var(--green)' }}>${totalPending.toFixed(0)}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{pending.length} proyecto{pending.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Cobrado (histórico)</div>
          <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--green)' }}>${totalPaid.toFixed(0)}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{paid.length} proyecto{paid.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {projects.length === 0 && (
        <div className="empty"><div className="empty-icon">💵</div><p>Todavía no tenés proyectos terminados</p></div>
      )}

      {pending.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Pendiente de cobro
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
            {pending.map(p => (
              <div key={p.id} className="list-row" style={{ cursor: 'default' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
                <span className="badge" style={{ fontWeight: 400, background: 'var(--bg3)', color: 'var(--text3)' }}>{amountLabel(p)}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)', minWidth: 60, textAlign: 'right' }}>${p.computed_editor_total.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {monthKeys.map(mk => (
        <div key={mk} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            {mk === 'Sin fecha' ? 'Sin fecha' : monthLabel(mk)} · ${paidByMonth[mk].reduce((s, p) => s + p.computed_editor_total, 0).toFixed(0)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {paidByMonth[mk].map(p => (
              <div key={p.id} className="list-row" style={{ cursor: 'default', opacity: 0.85 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{p.name}</span>
                {p.client_name && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{p.client_name}</span>}
                <span className="badge" style={{ fontSize: 10, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>✓ Cobrado</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)', minWidth: 60, textAlign: 'right' }}>${p.computed_editor_total.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
