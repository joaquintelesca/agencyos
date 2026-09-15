import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useOutletContext } from 'react-router-dom';

export default function Notifications() {
  const { api } = useAuth();
  const [notifs, setNotifs] = useState([]);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [view, setView] = useState('general'); // general | client
  const [selectedClient, setSelectedClient] = useState('all'); // 'all' o el id de un cliente ('__none__' = sin cliente)
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const navigate = useNavigate();
  const { setUnreadNotifs } = useOutletContext();

  useEffect(() => {
    setError('');
    api('/api/notifications').then(setNotifs).catch(e => {
      console.error(e);
      setError('No se pudieron cargar las notificaciones. Puede ser un problema de conexión.');
    });
  }, [retryCount]);

  const markAll = async () => {
    await api('/api/notifications/read-all', { method: 'PATCH' });
    setNotifs(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadNotifs(0);
  };

  // Marca una notificación como leída sin navegar a ningún lado — independiente de hacer
  // click en la notificación entera (que sí navega). El estado es el mismo de un solo lado
  // (la fila `notifications.read`), así que queda leída en las dos vistas por igual, no son
  // dos copias separadas.
  const markOne = async (e, n) => {
    e.stopPropagation();
    if (n.read) return;
    await api(`/api/notifications/${n.id}/read`, { method: 'PATCH' });
    setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
    setUnreadNotifs(prev => Math.max(0, prev - 1));
  };

  const handleClick = async (n) => {
    if (!n.read) {
      await api(`/api/notifications/${n.id}/read`, { method: 'PATCH' });
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
      setUnreadNotifs(prev => Math.max(0, prev - 1));
    }
    if (n.video_id && n.project_id) navigate(`/project/${n.project_id}?tab=videos&video=${n.video_id}`);
    else if (n.type === 'chat') navigate('/chat');
    else if (n.project_id) navigate(`/project/${n.project_id}`);
  };

  const timeAgo = (ts) => {
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
  };

  const icon = (type) => {
    if (type === 'comment') return '💬';
    if (type === 'reply') return '↩️';
    if (type === 'task_review') return '📋';
    if (type === 'project_assigned') return '📁';
    if (type === 'task_assigned') return '✅';
    if (type === 'project_message') return '💬';
    return '✉️';
  };
  const label = (n) => {
    if (n.type === 'comment') return <><strong>{n.actor_name}</strong> comentó en un video{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'reply') return <><strong>{n.actor_name}</strong> respondió tu comentario{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'task_review') return <><strong>{n.actor_name}</strong> pasó una tarea a revisión{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'project_assigned') return <><strong>{n.actor_name}</strong> te asignó un proyecto{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'task_assigned') return <><strong>{n.actor_name}</strong> te asignó una tarea{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'project_message') return <><strong>{n.actor_name}</strong> escribió en el chat del proyecto{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    return <><strong>{n.actor_name}</strong> te envió un mensaje</>;
  };

  const unread = notifs.filter(n => !n.read).length;

  const renderNotif = (n) => (
    <div key={n.id} onClick={() => handleClick(n)}
      style={{ display: 'flex', gap: 12, padding: '12px 16px', borderRadius: 10, background: n.read ? 'var(--bg2)' : 'var(--accent-glow)', border: `1px solid ${n.read ? 'var(--border)' : 'var(--accent)'}`, cursor: 'pointer', transition: 'all 0.15s', borderLeft: n.read ? '1px solid var(--border)' : '3px solid var(--accent)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = n.read ? 'var(--border)' : 'var(--accent)'}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: n.actor_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
        {n.actor_name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4, marginBottom: 4 }}>{label(n)}</div>
        {n.preview && <div style={{ fontSize: 12, color: 'var(--text2)', background: 'var(--bg3)', borderRadius: 6, padding: '3px 8px', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{n.preview}"</div>}
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{icon(n.type)} {timeAgo(n.created_at)}</div>
      </div>
      {!n.read && (
        <button onClick={e => markOne(e, n)} title="Marcar como leído"
          style={{ alignSelf: 'flex-start', flexShrink: 0, background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', color: 'var(--accent2)', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Marcar como leído
        </button>
      )}
    </div>
  );

  const clientGroups = (() => {
    const groups = {};
    for (const n of notifs) {
      const key = n.client_id || '__none__';
      if (!groups[key]) groups[key] = { id: key, name: n.client_name || 'Sin cliente', color: n.client_color, notifs: [] };
      groups[key].notifs.push(n);
    }
    return Object.values(groups).sort((a, b) => {
      if (a.id === '__none__') return 1;
      if (b.id === '__none__') return -1;
      return a.name.localeCompare(b.name);
    });
  })();

  return (
    <div style={{ flex: 1, padding: 28, overflowY: 'auto', maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontWeight: 700, fontSize: 20 }}>Notificaciones</h2>
          {unread > 0 && <span style={{ background: 'var(--red)', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>{unread}</span>}
        </div>
        {unread > 0 && <button onClick={markAll} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', color: 'var(--accent2)', fontSize: 12, cursor: 'pointer' }}>Marcar todo como leído</button>}
      </div>

      <div style={{ display: 'flex', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, gap: 2, width: 'fit-content', marginBottom: 20 }}>
        {[['general', 'General'], ['client', 'Por cliente']].map(([key, lbl]) => (
          <button key={key} onClick={() => setView(key)}
            style={{
              padding: '6px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              fontFamily: 'var(--font)', background: view === key ? 'var(--accent)' : 'transparent',
              color: view === key ? '#fff' : 'var(--text2)'
            }}>{lbl}</button>
        ))}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: 'var(--red)' }}>
          <span>⚠️ {error}</span>
          <button onClick={() => setRetryCount(c => c + 1)} style={{ background: 'transparent', border: '1px solid var(--red)', borderRadius: 6, padding: '3px 10px', color: 'var(--red)', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>Reintentar</button>
        </div>
      )}

      {!error && notifs.length === 0 && (
        <div className="empty"><div className="empty-icon">🔔</div><p>Sin notificaciones</p></div>
      )}

      {view === 'general' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {notifs.map(renderNotif)}
        </div>
      ) : (
        <div>
          <div style={{ position: 'relative', marginBottom: 20, width: 'fit-content' }}>
            <button onClick={() => setClientDropdownOpen(o => !o)} style={{
              display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontFamily: 'var(--font)', minWidth: 180
            }}>
              {selectedClient !== 'all' && (
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: clientGroups.find(g => g.id === selectedClient)?.color || 'var(--text3)', flexShrink: 0 }} />
              )}
              <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, textAlign: 'left' }}>
                {selectedClient === 'all' ? 'Todos los clientes' : clientGroups.find(g => g.id === selectedClient)?.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>▾</span>
            </button>

            {clientDropdownOpen && (
              <>
                <div onClick={() => setClientDropdownOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 220, zIndex: 11,
                  background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 4, maxHeight: 320, overflowY: 'auto'
                }}>
                  <button onClick={() => { setSelectedClient('all'); setClientDropdownOpen(false); }} style={{
                    display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '8px 10px', borderRadius: 7,
                    border: 'none', background: selectedClient === 'all' ? 'var(--accent-glow)' : 'transparent',
                    cursor: 'pointer', fontFamily: 'var(--font)', textAlign: 'left'
                  }}>
                    <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>Todos los clientes</span>
                  </button>
                  {clientGroups.map(g => {
                    const unreadCount = g.notifs.filter(n => !n.read).length;
                    return (
                      <button key={g.id} onClick={() => { setSelectedClient(g.id); setClientDropdownOpen(false); }} style={{
                        display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '8px 10px', borderRadius: 7,
                        border: 'none', background: selectedClient === g.id ? 'var(--accent-glow)' : 'transparent',
                        cursor: 'pointer', fontFamily: 'var(--font)', textAlign: 'left'
                      }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: g.color || 'var(--text3)', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{g.name}</span>
                        {unreadCount > 0 && (
                          <span style={{ background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10, flexShrink: 0 }}>{unreadCount}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {clientGroups.filter(g => selectedClient === 'all' || g.id === selectedClient).map(g => (
              <div key={g.id}>
                {selectedClient === 'all' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: g.color || 'var(--text3)', flexShrink: 0 }} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{g.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text3)' }}>{g.notifs.filter(n => !n.read).length} sin leer</span>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {g.notifs.map(renderNotif)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
