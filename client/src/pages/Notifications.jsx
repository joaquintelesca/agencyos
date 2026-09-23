import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { notificationIcon, notificationLabel, notificationTarget } from '../utils/notifications';
import { renderMentions } from '../components/MentionInput';
import Icon from '../components/Icon';

const PAGE_SIZE = 50;

export default function Notifications() {
  const { api, socket } = useAuth();
  const [notifs, setNotifs] = useState([]);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [view, setView] = useState('general'); // general | client
  const [selectedClient, setSelectedClient] = useState('all'); // 'all' o el id de un cliente ('__none__' = sin cliente)
  // Con historial largo, las pocas sin leer quedan mezcladas entre un montón de leídas — este
  // filtro se aplica antes de agrupar por cliente, así que alcanza a las dos vistas por igual.
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  // Antes el límite de 50 era fijo y sin forma de pedir más — cualquier notificación más vieja
  // quedaba inalcanzable para siempre, aunque siguiera sin leer.
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // El disparo real del aviso de escritorio vive en Layout.jsx (el único listener de socket que
  // está montado sin importar en qué página estés) — acá solo se pide el permiso, que después se
  // lee directo de Notification.permission (es un estado del navegador, no hace falta compartirlo
  // por contexto/prop). Safari en iPhone no soporta esta API — el chequeo evita romper ahí.
  const notifSupported = typeof Notification !== 'undefined';
  const [desktopPermission, setDesktopPermission] = useState(notifSupported ? Notification.permission : 'unsupported');
  const navigate = useNavigate();
  const { setUnreadNotifs, setProjects } = useOutletContext();

  // El puntito de "revisión pendiente" del sidebar sale de notificaciones sin leer (ver
  // Layout.jsx / unread_review_count) — sin este refresh, marcar una como leída acá no lo
  // apagaría hasta la próxima carga completa de la página.
  const refreshProjectDots = () => api('/api/projects').then(setProjects).catch(() => {});

  useEffect(() => {
    setError('');
    api(`/api/notifications?limit=${PAGE_SIZE}&offset=0`).then(n => {
      setNotifs(n);
      setHasMore(n.length === PAGE_SIZE);
    }).catch(e => {
      console.error(e);
      setError('No se pudieron cargar las notificaciones. Puede ser un problema de conexión.');
    });
  }, [retryCount]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const more = await api(`/api/notifications?limit=${PAGE_SIZE}&offset=${notifs.length}`);
      setNotifs(prev => [...prev, ...more]);
      setHasMore(more.length === PAGE_SIZE);
    } catch (e) { console.error(e); }
    finally { setLoadingMore(false); }
  };

  // Si se borra una desde otra pestaña/dispositivo (o "Borrar leídas" allá), la saca de esta
  // lista también sin esperar a un reload — mismo criterio que la sincronización de leídas.
  useEffect(() => {
    if (!socket) return;
    const onDeleted = ({ id }) => setNotifs(prev => prev.filter(n => n.id !== id));
    const onClearedRead = () => setNotifs(prev => prev.filter(n => !n.read));
    socket.on('notification:deleted', onDeleted);
    socket.on('notifications:cleared-read', onClearedRead);
    return () => { socket.off('notification:deleted', onDeleted); socket.off('notifications:cleared-read', onClearedRead); };
  }, [socket]);

  const markAll = async () => {
    await api('/api/notifications/read-all', { method: 'PATCH' });
    setNotifs(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadNotifs(0);
    refreshProjectDots();
  };

  const deleteOne = async (e, n) => {
    e.stopPropagation();
    try {
      await api(`/api/notifications/${n.id}`, { method: 'DELETE' });
      setNotifs(prev => prev.filter(x => x.id !== n.id));
      if (!n.read) setUnreadNotifs(prev => Math.max(0, prev - 1));
    } catch (e) {
      if (e.status === 404) { setNotifs(prev => prev.filter(x => x.id !== n.id)); return; }
      console.error(e);
    }
  };

  const deleteRead = async () => {
    await api('/api/notifications/read', { method: 'DELETE' });
    setNotifs(prev => prev.filter(n => !n.read));
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
    if (n.type === 'task_review' || n.type === 'task_feedback' || n.type === 'video_uploaded') refreshProjectDots();
  };

  const handleClick = async (n) => {
    if (!n.read) {
      // Si el PATCH falla, igual se navega: marcar leído es secundario frente a abrir lo que el
      // usuario quiso abrir. Sin este try/catch un 500 pasajero dejaba las notificaciones
      // completamente inclickeables, sin ningún feedback.
      try {
        await api(`/api/notifications/${n.id}/read`, { method: 'PATCH' });
        setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
        setUnreadNotifs(prev => Math.max(0, prev - 1));
        if (n.type === 'task_review' || n.type === 'task_feedback' || n.type === 'video_uploaded') refreshProjectDots();
      } catch (e) { console.error(e); }
    }
    const target = notificationTarget(n);
    if (target) navigate(target);
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

  const icon = notificationIcon;
  const label = notificationLabel;

  const unread = notifs.filter(n => !n.read).length;
  const visibleNotifs = unreadOnly ? notifs.filter(n => !n.read) : notifs;

  const renderNotif = (n) => (
    <div key={n.id} onClick={() => handleClick(n)}
      style={{ display: 'flex', gap: 12, padding: '12px 16px', borderRadius: 10, background: n.read ? 'var(--bg2)' : 'var(--accent-glow)', border: `1px solid ${n.read ? 'var(--border)' : 'var(--accent)'}`, cursor: 'pointer', transition: 'all 0.15s', borderLeft: n.read ? '1px solid var(--border)' : '3px solid var(--accent)' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = n.read ? 'var(--border)' : 'var(--accent)'}>
      {/* n.actor_name viene con COALESCE(a.name, n.guest_name, 'Cliente') del servidor — nunca es
          falsy, así que no sirve para saber si hay un actor de verdad (el 'Cliente' genérico es
          para invitados sin cuenta, no para esto). n.actor_id sí queda null de verdad cuando la
          notificación la generó un chequeo automático (ver review_pending), sin ninguna persona
          detrás. */}
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: n.actor_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: n.actor_id ? 13 : 16, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
        {n.actor_id ? n.actor_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : icon(n.type)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4, marginBottom: 4 }}>{label(n)}</div>
        {n.preview && <div style={{ fontSize: 12, color: 'var(--text2)', background: 'var(--bg3)', borderRadius: 6, padding: '3px 8px', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{renderMentions(n.preview)}"</div>}
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{icon(n.type)} {timeAgo(n.created_at)}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', flexShrink: 0 }}>
        {!n.read && (
          <button className="btn-outline" onClick={e => markOne(e, n)} title="Marcar como leído"
            style={{ borderRadius: 6, padding: '3px 8px', color: 'var(--accent2)', fontSize: 11, whiteSpace: 'nowrap' }}>
            Marcar como leído
          </button>
        )}
        <button className="icon-btn" onClick={e => deleteOne(e, n)} title="Borrar notificación" aria-label="Borrar notificación"
          style={{ color: 'var(--text3)', padding: '3px 6px', display: 'flex' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}>
          <Icon.trash />
        </button>
      </div>
    </div>
  );

  const clientGroups = (() => {
    const groups = {};
    for (const n of visibleNotifs) {
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
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--fs-xl)' }}>Notificaciones</h1>
          {unread > 0 && <span className="badge badge-count">{unread}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {notifSupported && desktopPermission === 'default' && (
            <button
              className="btn-outline"
              onClick={() => Notification.requestPermission().then(setDesktopPermission)}
              style={{ borderRadius: 7, padding: '5px 12px', color: 'var(--accent2)', fontSize: 12 }}
            >
              Activar avisos de escritorio
            </button>
          )}
          {notifSupported && desktopPermission === 'granted' && (
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>🔔 Avisos de escritorio activados</span>
          )}
          <button
            onClick={() => setUnreadOnly(o => !o)}
            style={{
              borderRadius: 7, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)',
              border: '1px solid var(--border)',
              background: unreadOnly ? 'var(--accent-glow)' : 'var(--bg3)',
              color: unreadOnly ? 'var(--accent2)' : 'var(--text2)',
            }}
          >
            Solo no leídas
          </button>
          {unread > 0 && <button className="btn-outline" onClick={markAll} style={{ borderRadius: 7, padding: '5px 12px', color: 'var(--accent2)', fontSize: 12 }}>Marcar todo como leído</button>}
          {notifs.some(n => n.read) && <button className="btn-outline" onClick={deleteRead} style={{ borderRadius: 7, padding: '5px 12px', color: 'var(--text3)', fontSize: 12 }}>Borrar leídas</button>}
        </div>
      </div>

      <div className="tab-switch" style={{ marginBottom: 20 }}>
        {[['general', 'General'], ['client', 'Por cliente']].map(([key, lbl]) => (
          <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{lbl}</button>
        ))}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: 'var(--red)' }}>
          <span>⚠️ {error}</span>
          <button className="btn-retry" onClick={() => setRetryCount(c => c + 1)}>Reintentar</button>
        </div>
      )}

      {!error && notifs.length === 0 && (
        <div className="empty"><div className="empty-icon">🔔</div><p>Sin notificaciones</p></div>
      )}
      {!error && notifs.length > 0 && visibleNotifs.length === 0 && (
        <div className="empty"><div className="empty-icon">✅</div><p>No hay notificaciones sin leer</p></div>
      )}

      {view === 'general' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {visibleNotifs.map(renderNotif)}
          {!unreadOnly && hasMore && notifs.length > 0 && (
            <button className="btn-outline" onClick={loadMore} disabled={loadingMore}
              style={{ alignSelf: 'center', marginTop: 10, borderRadius: 7, padding: '7px 16px', color: 'var(--text2)', fontSize: 12, cursor: loadingMore ? 'default' : 'pointer' }}>
              {loadingMore ? 'Cargando...' : 'Cargar más'}
            </button>
          )}
        </div>
      ) : (
        <div>
          <div style={{ position: 'relative', marginBottom: 20, width: 'fit-content' }}>
            <button className="panel" onClick={() => setClientDropdownOpen(o => !o)} style={{
              display: 'flex', alignItems: 'center', gap: 8,
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
                <div className="panel" style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 220, zIndex: 11,
                  borderRadius: 10,
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
