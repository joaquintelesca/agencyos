import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials } from '../utils/format';

const CATEGORIES = [
  { key: 'review', label: 'Pendiente de revisión', color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' },
  { key: 'editing', label: 'Pendiente de edición', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' },
  { key: 'approved', label: 'Aprobado', color: 'var(--green)', bg: 'rgba(70,200,120,0.12)' },
];
const categoryMeta = (key) => CATEGORIES.find(c => c.key === key);

function VideoRow({ v, navigate, showClient }) {
  const meta = categoryMeta(v.category);
  return (
    <div onClick={() => navigate(`/project/${v.project_id}?tab=videos`)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, cursor: 'pointer', transition: 'all 0.1s' }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: v.project_color || 'var(--text3)', flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{v.title} <span style={{ fontSize: 11, color: 'var(--text3)' }}>v{v.version}</span></span>
      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{showClient && v.client_name ? `${v.client_name} · ` : ''}{v.project_name}</span>
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
}

export default function VideosDashboard() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all | review | editing | approved
  const [view, setView] = useState('general'); // general | client

  useEffect(() => {
    api('/api/dashboard/videos-overview').then(setVideos).catch(console.error).finally(() => setLoading(false));
  }, []);

  const counts = CATEGORIES.reduce((acc, c) => ({ ...acc, [c.key]: videos.filter(v => v.category === c.key).length }), {});
  const shown = filter === 'all' ? videos : videos.filter(v => v.category === filter);

  const clientGroups = (() => {
    const groups = {};
    for (const v of shown) {
      const key = v.client_id || '__none__';
      if (!groups[key]) groups[key] = { id: key, name: v.client_name || 'Sin cliente', color: v.client_color, videos: [] };
      groups[key].videos.push(v);
    }
    return Object.values(groups).sort((a, b) => {
      if (a.id === '__none__') return 1;
      if (b.id === '__none__') return -1;
      return a.name.localeCompare(b.name);
    });
  })();

  if (loading) return <div style={{ flex: 1, overflow: 'auto', padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Videos</h1>
        <div style={{ display: 'flex', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, gap: 2 }}>
          {[['general', 'General'], ['client', 'Por cliente']].map(([key, label]) => (
            <button key={key} onClick={() => setView(key)}
              style={{
                padding: '6px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                fontFamily: 'var(--font)', background: view === key ? 'var(--accent)' : 'transparent',
                color: view === key ? '#fff' : 'var(--text2)'
              }}>{label}</button>
          ))}
        </div>
      </div>

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
      ) : view === 'general' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map(v => <VideoRow key={v.id} v={v} navigate={navigate} showClient />)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {clientGroups.map(g => (
            <div key={g.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: g.color || 'var(--text3)', flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{g.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{g.videos.length} video{g.videos.length !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {g.videos.map(v => <VideoRow key={v.id} v={v} navigate={navigate} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
