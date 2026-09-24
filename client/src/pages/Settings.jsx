import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';

// Home para pantallas admin de uso ocasional que no justifican un lugar fijo en el sidebar
// principal (pedido explícito del usuario: "Almacenamiento" ocupaba un lugar importante ahí para
// algo que solo necesita mirar de vez en cuando). Se accede por el ícono de rueda dentado junto al
// perfil, no por el sidebar de navegación diaria. Nueva entrada acá cuando aparezca algo con el
// mismo perfil de uso (se mira poco, no hace falta tenerlo siempre a la vista).
const SECTIONS = [
  { to: '/storage', icon: 'database', label: 'Almacenamiento', description: 'Ver qué ocupa lugar y liberar espacio' },
  { to: '/settings/branding', icon: 'palette', label: 'Branding del portal', description: 'Tu logo, nombre y color en el link de revisión' },
  { to: '/settings/backups', icon: 'shield', label: 'Backups', description: 'Copia diaria de la base, últimos 30 días' },
];

export default function Settings() {
  const navigate = useNavigate();

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>Configuración</h1>
        <p style={{ color: 'var(--text2)', fontSize: 14 }}>Ajustes y herramientas de uso ocasional.</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
        {SECTIONS.map(s => {
          const SectionIcon = Icon[s.icon];
          return (
            <button key={s.to} onClick={() => navigate(s.to)} className="panel"
              style={{ display: 'flex', alignItems: 'center', gap: 14, borderRadius: 12, padding: '14px 16px', border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%', fontFamily: 'var(--font)' }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent2)', flexShrink: 0 }}>
                <SectionIcon />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{s.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 1 }}>{s.description}</div>
              </div>
              <span style={{ color: 'var(--text3)' }}>→</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
