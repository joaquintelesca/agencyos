import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials } from '../utils/format';

const CATEGORIES = [
  { key: 'review', label: 'Pendiente de revisión', color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' },
  { key: 'editing', label: 'Pendiente de edición', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' },
  { key: 'approved', label: 'Aprobado', color: 'var(--green)', bg: 'rgba(70,200,120,0.12)' },
];

export default function VideosDashboard() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all | review | editing | approved

  useEffect(() => {
    api('/api/dashboard/videos-overview').then(setVideos).catch(console.error).finally(() => setLoading(false));
  }, []);

  const counts = CATEGORIES.reduce((acc, c) => ({ ...acc, [c.key]: videos.filter(v => v.category === c.key).length }), {});
  const shown = filter === 'all' ? videos : videos.filter(v => v.category === filter);
  const categoryMeta = (key) => CATEGORIES.find(c => c.key === key);

  if (loading) return <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>Videos</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div onClick={() => setFilter('all')}
          style={{ padding: 16, borderRadius: 12, cursor: 'pointer', background: 'var(--bg2)', border: `1px solid ${filter === 'all' ? 'var(--accent)' : 'var(--border)'}` }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{videos.length}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Todos los videos</div>
        </div>
        {CATEGORIES.map(c => (
          <div key={c.key} onClick={() => setFilter(c.key)}
            style={{ padding: 16, borderRadius: 12, cursor: 'pointer', background: 'var(--bg2)', border: `1px solid ${filter === c.key ? c.color : 'var(--border)'}` }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: c.color }}>{counts[c.key] || 0}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>{c.label}</div>
          </div>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty"><div className="empty-icon">🎬</div><p>No hay videos {filter !== 'all' ? 'en esta categoría' : 'todavía'}</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map(v => {
            const meta = categoryMeta(v.category);
            return (
              <div key={v.id} onClick={() => navigate(`/project/${v.project_id}?tab=videos`)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
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
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, fontWeight: 500, background: meta.bg, color: meta.color }}>
                  {v.category === 'editing' ? `${v.unresolved_count} comentario${v.unresolved_count !== 1 ? 's' : ''}` : meta.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
