const express = require('express');
const { rateLimit } = require('express-rate-limit');

// Configuración general de la agencia — branding del portal por ahora (nombre, color de acento,
// logo) en vez del genérico "🎬 Revisión de video" que veía el cliente en /review y en el portal
// por cliente. Guardado en una tabla clave/valor (ver migración create_settings) para no necesitar
// una migración nueva cada vez que se sume un ajuste más.
module.exports = function settingsRoutes({ db, auth, serveFile, safeUnlink, verifyAndPersistFiles, THUMBNAIL_MIME_EXT, logoUpload }) {
  const router = express.Router();

  // GET /api/settings/branding lo pegan las páginas públicas (/review, portal por cliente) en
  // cada carga — sin sesión, así que un límite más generoso que el de las acciones de revisión
  // (comentar/aprobar), pero igual acotado contra abuso.
  const brandingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes. Probá de nuevo en unos minutos.' }
  });

  const BRANDING_KEY = 'branding';
  async function getBranding() {
    const row = await db('settings').where({ key: BRANDING_KEY }).first();
    return row ? JSON.parse(row.value) : {};
  }
  async function saveBranding(patch) {
    const current = await getBranding();
    const next = { ...current, ...patch };
    const exists = await db('settings').where({ key: BRANDING_KEY }).first();
    if (exists) await db('settings').where({ key: BRANDING_KEY }).update({ value: JSON.stringify(next) });
    else await db('settings').insert({ key: BRANDING_KEY, value: JSON.stringify(next) });
    return next;
  }
  // Nunca se expone `logo_filename` (es un detalle interno de storage) — solo un booleano y la
  // ruta pública fija para pedirlo, igual que `paid` se reducía a booleano en shares.js.
  const publicShape = (b) => ({ name: b.name || null, accent_color: b.accent_color || null, has_logo: !!b.logo_filename });

  router.get('/api/settings/branding', brandingLimiter, async (req, res) => {
    try { res.json(publicShape(await getBranding())); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/settings/branding/logo', brandingLimiter, async (req, res) => {
    try {
      const b = await getBranding();
      if (!b.logo_filename) return res.status(404).end();
      await serveFile(res, b.logo_filename);
    } catch (e) { console.error(e); res.status(500).end(); }
  });

  router.put('/api/settings/branding', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { name, accent_color } = req.body;
      if (accent_color && !/^#[0-9a-fA-F]{6}$/.test(accent_color)) {
        return res.status(400).json({ error: 'Color inválido' });
      }
      const next = await saveBranding({
        name: name?.trim() ? name.trim().slice(0, 60) : null,
        accent_color: accent_color || null,
      });
      res.json(publicShape(next));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/settings/branding/logo', auth, (req, res, next) => {
    logoUpload.single('logo')(req, res, async (err) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      if (err && err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ error: 'El logo tiene que ser una imagen' });
      if (err && err.message === 'STORAGE_FULL') return res.status(507).json({ error: 'No hay espacio de almacenamiento disponible.' });
      if (err) return res.status(400).json({ error: err.message || 'Error al subir el logo' });
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
      try {
        if (!await verifyAndPersistFiles([req.file], THUMBNAIL_MIME_EXT)) {
          return res.status(400).json({ error: 'El contenido del archivo no coincide con una imagen' });
        }
        const current = await getBranding();
        const next = await saveBranding({ logo_filename: req.file.filename });
        if (current.logo_filename) safeUnlink(current.logo_filename);
        res.json(publicShape(next));
      } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
    });
  });

  router.delete('/api/settings/branding/logo', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const current = await getBranding();
      const next = await saveBranding({ logo_filename: null });
      if (current.logo_filename) safeUnlink(current.logo_filename);
      res.json(publicShape(next));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
