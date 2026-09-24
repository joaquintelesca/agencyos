import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';

// Solo visibilidad de que el backup diario existe y anda — no hay restore desde acá (ver
// server/routes/settings.js), eso es deliberadamente más grande/riesgoso y no se pidió.
function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const mb = bytes / (1024 ** 2);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function BackupSettings() {
  const { api } = useAuth();
  const { alert } = useAlert();
  const navigate = useNavigate();
  const [backups, setBackups] = useState(null);
  const [running, setRunning] = useState(false);

  const load = () => api('/api/settings/backups')
    .then(setBackups)
    .catch(e => { console.error(e); alert('No se pudo cargar la lista de backups: ' + e.message); });

  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      await api('/api/settings/backups/run', { method: 'POST' });
      await load();
    } catch (e) { await alert('Error al generar el backup: ' + e.message); }
    finally { setRunning(false); }
  };

  if (!backups) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>;

  const latest = backups[0];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
      <button onClick={() => navigate('/settings')}
        style={{ background: 'none', border: 'none', color: 'var(--accent2)', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
        ← Configuración
      </button>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>Backups</h1>
          <p style={{ color: 'var(--text2)', fontSize: 14 }}>
            Copia diaria de toda la base (proyectos, tareas, pagos, chat) — se guardan los últimos 30 días.
          </p>
        </div>
        <button className="btn btn-primary" onClick={runNow} disabled={running}>
          {running ? 'Generando...' : 'Hacer backup ahora'}
        </button>
      </div>

      <div className="panel" style={{ borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
        {latest ? (
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>
            Último backup: <strong style={{ color: 'var(--text)' }}>{new Date(latest.modified).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</strong> · {formatBytes(latest.size)}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--yellow)' }}>Todavía no hay ningún backup generado.</div>
        )}
      </div>

      {backups.length === 0 && (
        <div className="empty"><div className="empty-icon">🗄️</div><p>Sin backups todavía</p><p style={{ fontSize: 12 }}>El primero se genera automáticamente dentro de las próximas 24hs, o dale a "Hacer backup ahora"</p></div>
      )}

      {backups.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {backups.map(b => (
            <div key={b.key} className="panel" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8 }}>
              <span style={{ fontSize: 13, flex: 1, color: 'var(--text)' }}>
                {new Date(b.modified).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{formatBytes(b.size)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
