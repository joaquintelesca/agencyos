import { useState, useRef } from 'react';

// Wrapper de <input>/<textarea> que agrega autocompletado de @menciones — separado del composer
// de cada lugar que lo usa (chat de proyecto, comentarios de video) para no repetir la misma
// lógica de "detectar @, filtrar miembros, insertar en el cursor, navegar con flechas" en cada uno.
// El texto se guarda con el mismo formato que WhatsApp/Slack usan internamente: @[Nombre](userId) —
// parseable sin ambigüedad del lado del servidor (dos personas pueden llamarse igual), y
// renderMentions (acá abajo) lo vuelve a mostrar como "@Nombre" resaltado.
const MENTION_RE = /(?:^|\s)@([a-zA-ZÀ-ÿ0-9_]*)$/;

export function renderMentions(text) {
  if (!text) return text;
  const re = /@\[([^\]]+)\]\([a-zA-Z0-9-]+\)/g;
  const parts = [];
  let lastIndex = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    parts.push(<span key={key++} style={{ color: 'var(--accent2)', fontWeight: 600 }}>@{m[1]}</span>);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export default function MentionInput({ as = 'textarea', value, onChange, members = [], onKeyDown, inputRef, ...rest }) {
  const [query, setQuery] = useState(null); // null = cerrado, string = filtro actual
  const [activeIndex, setActiveIndex] = useState(0);
  const localRef = useRef(null);
  const ref = inputRef || localRef;

  const matches = query !== null
    ? members.filter(m => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
    : [];

  const handleChange = (e) => {
    const val = e.target.value;
    onChange(val);
    const pos = e.target.selectionStart;
    const match = val.slice(0, pos).match(MENTION_RE);
    if (match) { setQuery(match[1]); setActiveIndex(0); } else setQuery(null);
  };

  const insertMention = (member) => {
    const el = ref.current;
    if (!el) return;
    const pos = el.selectionStart;
    const uptoCursor = value.slice(0, pos);
    const match = uptoCursor.match(MENTION_RE);
    if (!match) return;
    const startIdx = uptoCursor.length - match[0].length + (match[0][0] === ' ' ? 1 : 0);
    const inserted = `@[${member.name}](${member.id}) `;
    const newValue = value.slice(0, startIdx) + inserted + value.slice(pos);
    onChange(newValue);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const newPos = startIdx + inserted.length;
      el.setSelectionRange(newPos, newPos);
    });
  };

  const handleKeyDown = (e) => {
    if (query !== null && matches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(matches[activeIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    onKeyDown?.(e);
  };

  const Tag = as;

  return (
    <div style={{ position: 'relative', flex: rest.style?.flex }}>
      <Tag ref={ref} value={value} onChange={handleChange} onKeyDown={handleKeyDown} {...rest} />
      {query !== null && matches.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, overflow: 'hidden', zIndex: 30, minWidth: 180, boxShadow: '0 8px 20px rgba(0,0,0,0.35)' }}>
          {matches.map((m, i) => (
            <div key={m.id} onMouseDown={e => { e.preventDefault(); insertMention(m); }}
              style={{ padding: '7px 10px', fontSize: 12.5, cursor: 'pointer', background: i === activeIndex ? 'var(--bg4)' : 'transparent', color: 'var(--text)' }}>
              @{m.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
