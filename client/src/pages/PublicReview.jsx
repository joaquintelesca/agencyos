import { useParams } from 'react-router-dom';
import VideoReviewPane from '../components/VideoReviewPane';
import useBranding from '../hooks/useBranding';

// Página pública, sin sesión: fuera de <AuthProvider>/<PrivateRoute>, por eso no usa el api()
// de AuthContext (asume un token de sesión que acá no existe) — fetch directo a rutas propias
// que no pasan por el middleware `auth` del servidor (ver server/routes/shares.js). Toda la
// lógica de reproductor/comentarios/aprobar vive en VideoReviewPane, compartida con el portal
// por cliente (ClientReview.jsx) — acá solo se resuelve el token de la URL a un apiBase.
export default function PublicReview() {
  const { token } = useParams();
  const { name, hasLogo, accentStyle } = useBranding();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', justifyContent: 'center', padding: '24px 16px', ...accentStyle }}>
      <div style={{ width: '100%', maxWidth: 900 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
          {hasLogo
            ? <img src="/api/settings/branding/logo" alt={name || 'Logo'} style={{ height: 22, objectFit: 'contain' }} />
            : <span>🎬</span>}
          <span>{name || 'Revisión de video'}</span>
        </div>
        <VideoReviewPane apiBase={`/api/review/${token}`} />
      </div>
    </div>
  );
}
