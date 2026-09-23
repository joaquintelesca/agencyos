import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';

// Mismo set que Team.jsx usa para el avatar del usuario — reusar la paleta en vez de un color
// picker libre mantiene todo el branding (interno y el del portal) dentro de tonos que ya se ven
// bien contra el fondo oscuro de la app.
const ACCENT_COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4'];

export default function BrandingSettings() {
  const { api } = useAuth();
  const { alert, confirm } = useAlert();
  const navigate = useNavigate();
  const [branding, setBranding] = useState(null);
  const [name, setName] = useState('');
  const [accentColor, setAccentColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoCacheBust, setLogoCacheBust] = useState(0);
  const fileInputRef = useRef(null);

  const load = () => fetch('/api/settings/branding').then(r => r.json()).then(b => {
    setBranding(b);
    setName(b.name || '');
    setAccentColor(b.accent_color || '');
  }).catch(e => { console.error(e); alert('No se pudo cargar el branding: ' + e.message); });

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api('/api/settings/branding', { method: 'PUT', body: { name, accent_color: accentColor || null } });
      setBranding(updated);
    } catch (e) { await alert('Error al guardar: ' + e.message); }
    finally { setSaving(false); }
  };

  const uploadLogo = async (file) => {
    if (!file) return;
    setUploadingLogo(true);
    try {
      const body = new FormData();
      body.append('logo', file);
      const updated = await api('/api/settings/branding/logo', { method: 'POST', body });
      setBranding(updated);
      setLogoCacheBust(Date.now()); // fuerza a recargar la imagen — la URL no cambia de nombre
    } catch (e) { await alert('Error al subir el logo: ' + e.message); }
    finally { setUploadingLogo(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const removeLogo = async () => {
    if (!await confirm('¿Sacar el logo del portal? Va a volver a mostrarse el ícono genérico.')) return;
    try {
      const updated = await api('/api/settings/branding/logo', { method: 'DELETE' });
      setBranding(updated);
    } catch (e) { await alert('Error al sacar el logo: ' + e.message); }
  };

  if (!branding) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" /></div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
      <button onClick={() => navigate('/settings')}
        style={{ background: 'none', border: 'none', color: 'var(--accent2)', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
        ← Configuración
      </button>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-xl)', fontWeight: 800, marginBottom: 4 }}>Branding del portal</h1>
        <p style={{ color: 'var(--text2)', fontSize: 14 }}>
          Lo que ve el cliente en el link de revisión y en su portal, en vez del ícono genérico de AgencyOS.
        </p>
      </div>

      <div className="panel" style={{ borderRadius: 14, padding: '20px 22px', maxWidth: 480, marginBottom: 20 }}>
        <div className="form-group">
          <label>Nombre de tu agencia</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Estudio Nova" maxLength={60} />
        </div>

        <div className="form-group">
          <label>Color de acento</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" onClick={() => setAccentColor('')}
              aria-label="Sin color personalizado (usar el default de AgencyOS)" aria-pressed={!accentColor}
              style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg4)', cursor: 'pointer',
                border: !accentColor ? '3px solid var(--text)' : '3px solid transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, color: 'var(--text3)', padding: 0 }}>
              ✕
            </button>
            {ACCENT_COLORS.map((c, i) => (
              <button key={c} type="button" onClick={() => setAccentColor(c)}
                aria-label={`Color ${i + 1}`} aria-pressed={accentColor === c}
                style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: accentColor === c ? '3px solid var(--text)' : '3px solid transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#fff', padding: 0 }}>
                {accentColor === c ? '✓' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Logo (opcional)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <div style={{ width: 64, height: 64, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
              {branding.has_logo
                ? <img key={logoCacheBust} src={`/api/settings/branding/logo?v=${logoCacheBust}`} alt="Logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                : <span style={{ fontSize: 22, color: 'var(--text3)' }}>🎬</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                onChange={e => uploadLogo(e.target.files?.[0])} />
              <button type="button" className="btn-outline" disabled={uploadingLogo} onClick={() => fileInputRef.current?.click()}
                style={{ borderRadius: 7, padding: '6px 12px', fontSize: 12 }}>
                {uploadingLogo ? 'Subiendo...' : branding.has_logo ? 'Cambiar logo' : 'Subir logo'}
              </button>
              {branding.has_logo && (
                <button type="button" onClick={removeLogo} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 12, padding: 0, textAlign: 'left' }}>
                  Sacar logo
                </button>
              )}
            </div>
          </div>
        </div>

        <button className="btn btn-primary" onClick={save} disabled={saving} style={{ marginTop: 6 }}>
          {saving ? 'Guardando...' : 'Guardar'}
        </button>
      </div>

      <div className="panel" style={{ borderRadius: 12, padding: '14px 18px', maxWidth: 480 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Vista previa</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 'var(--fs-sm)' }}>
          {branding.has_logo
            ? <img key={logoCacheBust} src={`/api/settings/branding/logo?v=${logoCacheBust}`} alt="Logo" style={{ height: 22, objectFit: 'contain' }} />
            : <span>🎬</span>}
          <span>{name || 'Revisión de video'}</span>
        </div>
      </div>
    </div>
  );
}
