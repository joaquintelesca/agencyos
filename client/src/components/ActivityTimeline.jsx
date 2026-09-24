import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { activityIcon, activityLabel } from '../utils/activity';

const PAGE_SIZE = 50;

// Timeline de "quién hizo qué" en el proyecto — hoy disperso entre el Kanban, el chat y los
// videos. Arranca a registrarse desde que existe esta feature (server/lib/activity.js): no hay
// forma de reconstruir retroactivamente qué pasó antes, porque tasks/videos solo guardan el
// estado actual, no el historial de cambios.
export default function ActivityTimeline({ projectId }) {
  const { api } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    setLoading(true);
    api(`/api/projects/${projectId}/activity?limit=${PAGE_SIZE}`)
      .then(rows => { setItems(rows); setHasMore(rows.length === PAGE_SIZE); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId]);

  const loadMore = () => {
    setLoadingMore(true);
    api(`/api/projects/${projectId}/activity?limit=${PAGE_SIZE}&offset=${items.length}`)
      .then(rows => { setItems(prev => [...prev, ...rows]); setHasMore(rows.length === PAGE_SIZE); })
      .catch(console.error)
      .finally(() => setLoadingMore(false));
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><div className="spinner" /></div>;

  if (items.length === 0) {
    return (
      <div className="empty"><div className="empty-icon">🕓</div><p>Todavía no hay actividad registrada en este proyecto</p></div>
    );
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 640 }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((a, i) => (
          <div key={a.id} style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
                {activityIcon(a.type)}
              </div>
              {i < items.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--border)', minHeight: 18 }} />}
            </div>
            <div style={{ paddingBottom: 18, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>{activityLabel(a)}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {new Date(a.created_at).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}
      </div>
      {hasMore && (
        <button className="btn-outline" onClick={loadMore} disabled={loadingMore}
          style={{ marginTop: 4, borderRadius: 7, padding: '7px 16px', color: 'var(--text2)', fontSize: 12 }}>
          {loadingMore ? 'Cargando...' : 'Cargar más'}
        </button>
      )}
    </div>
  );
}
