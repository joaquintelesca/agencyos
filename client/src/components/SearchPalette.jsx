import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useModalA11y from '../hooks/useModalA11y';

// Antes la única forma de encontrar un proyecto/tarea/video era expandir cliente por cliente en
// el sidebar a mano — insostenible pasados unos pocos proyectos. Debounce de 250ms para no
// mandar una request por tecla; `reqIdRef` descarta la respuesta de una búsqueda vieja si llegó
// después de una más nueva (conexión lenta + tipeo rápido podía mostrar resultados de "proy"
// después de haber tipeado "proyecto x").
export default function SearchPalette({ open, onClose }) {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);
  const modalRef = useModalA11y(open, onClose);

  useEffect(() => {
    if (open) { setQ(''); setResults(null); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) { setResults(null); setLoading(false); return; }
    setLoading(true);
    const myReqId = ++reqIdRef.current;
    const t = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(query)}`)
        .then(r => { if (reqIdRef.current === myReqId) setResults(r); })
        .catch(console.error)
        .finally(() => { if (reqIdRef.current === myReqId) setLoading(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, api]);

  if (!open) return null;

  const go = (path) => { onClose(); navigate(path); };
  const total = results ? Object.values(results).reduce((s, arr) => s + arr.length, 0) : 0;

  const Row = ({ color, title, subtitle, onClick }) => (
    <div className="list-row" onClick={onClick} style={{ padding: '8px 12px' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color || 'var(--text3)', flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      {subtitle && <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>{subtitle}</span>}
    </div>
  );

  const Group = ({ label, children }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '2px 6px 6px' }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, padding: 0, overflow: 'hidden' }} ref={modalRef} role="dialog" aria-modal="true" aria-label="Buscar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 15 }}>🔍</span>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Buscar proyectos, tareas, videos, comentarios..."
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 15, fontFamily: 'var(--font)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text3)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 6px' }}>Esc</span>
        </div>

        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: q.trim().length >= 2 ? '10px 8px' : 0 }}>
          {q.trim().length < 2 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--text3)' }}>
              Escribí al menos 2 caracteres para buscar
            </div>
          )}
          {q.trim().length >= 2 && loading && !results && (
            <div style={{ padding: '24px 16px', textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
          )}
          {results && total === 0 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--text3)' }}>
              Sin resultados para "{q.trim()}"
            </div>
          )}
          {results && results.projects.length > 0 && (
            <Group label="Proyectos">
              {results.projects.map(p => (
                <Row key={p.id} color={p.color} title={p.name} subtitle={p.client_name}
                  onClick={() => go(`/project/${p.id}`)} />
              ))}
            </Group>
          )}
          {results && results.clients.length > 0 && (
            <Group label="Clientes">
              {results.clients.map(c => (
                <Row key={c.id} color={c.color} title={c.name} onClick={() => go(`/client/${c.id}`)} />
              ))}
            </Group>
          )}
          {results && results.tasks.length > 0 && (
            <Group label="Tareas">
              {results.tasks.map(t => (
                <Row key={t.id} color={t.project_color} title={t.title} subtitle={t.project_name}
                  onClick={() => go(`/project/${t.project_id}`)} />
              ))}
            </Group>
          )}
          {results && results.videos.length > 0 && (
            <Group label="Videos">
              {results.videos.map(v => (
                <Row key={v.id} color={v.project_color} title={v.title} subtitle={v.project_name}
                  onClick={() => go(`/project/${v.project_id}?tab=videos&video=${v.id}`)} />
              ))}
            </Group>
          )}
          {results && results.comments.length > 0 && (
            <Group label="Comentarios">
              {results.comments.map(c => (
                <Row key={c.id} color={c.project_color} title={c.content} subtitle={c.video_title}
                  onClick={() => go(`/project/${c.project_id}?tab=videos&video=${c.video_id}`)} />
              ))}
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}
