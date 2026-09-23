import { useState, useEffect } from 'react';

// Compartido por PublicReview.jsx y ClientReview.jsx (las dos páginas sin sesión que el cliente
// ve) — fetch directo a la ruta pública, no pasa por el api() de AuthContext porque estas páginas
// están fuera de <AuthProvider>. El admin solo elige UN color en la pantalla de configuración;
// --accent2/--accent-glow se derivan acá para no pedirle 3 colores por un ajuste tan chico.
function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/.{2}/g);
  return m.map(h => parseInt(h, 16));
}
function lighten(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
function toRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function useBranding() {
  const [branding, setBranding] = useState(null);

  useEffect(() => {
    fetch('/api/settings/branding')
      .then(r => r.ok ? r.json() : {})
      .then(setBranding)
      .catch(() => setBranding({}));
  }, []);

  const b = branding || {};
  const accentStyle = b.accent_color ? {
    '--accent': b.accent_color,
    '--accent2': lighten(b.accent_color, 0.2),
    '--accent-glow': toRgba(b.accent_color, 0.15),
  } : {};

  return {
    loading: branding === null,
    name: b.name || null,
    hasLogo: !!b.has_logo,
    accentStyle,
  };
}
