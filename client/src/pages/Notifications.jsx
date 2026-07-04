import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function Notifications() {
  const { api } = useAuth();
  const [notifs, setNotifs] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    api('/api/notifications').then(setNotifs).catch(console.error);
  }, []);

  const markAll = async () => {
    await api('/api/notifications/read-all', { method: 'PATCH' });
    setNotifs(prev => prev.map(n => ({ ...n, read: true })));
  };

  const handleClick = async (n) => {
    if (!n.read) {
      await api(`/api/notifications/${n.id}/read`, { method: 'PATCH' });
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
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
    return '✉️';
  };
  const label = (n) => {
    if (n.type === 'comment') return <><strong>{n.actor_name}</strong> comentó en un video{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'reply') return <><strong>{n.actor_name}</strong> respondió tu comentario{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'task_review') return <><strong>{n.actor_name}</strong> pasó una tarea a revisión{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'project_assigned') return <><strong>{n.actor_name}</strong> te asignó un proyecto{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    if (n.type === 'task_assigned') return <><strong>{n.actor_name}</strong> te asignó una tarea{n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : ''}</>;
    return <><strong>{n.actor_name}</strong> te envió un mensaje</>;
  };

  const unread = notifs.filter(n => !n.read).length;

  return (
    <div style={{ flex: 1, padding: 28, overflowY: 'auto', maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontWeight: 700, fontSize: 20 }}>Notificaciones</h2>
          {unread > 0 && <span style={{ background: 'var(--red)', color: '#fff', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>{unread}</span>}
        </div>
        {unread > 0 && <button onClick={markAll} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', color: 'var(--accent2)', fontSize: 12, cursor: 'pointer' }}>Marcar todo como leído</button>}
      </div>

      {notifs.length === 0 && (
        <div className="empty"><div className="empty-icon">🔔</div><p>Sin notificaciones</p></div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {notifs.map(n => (
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
            {!n.read && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0, marginTop: 6 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}
