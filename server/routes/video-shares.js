const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// El cliente de la agencia no tiene cuenta ni membresía de proyecto — hasta ahora la única forma
// de que viera el trabajo era exportarlo y mandarlo por WhatsApp/Drive, perdiendo la revisión con
// timestamp exacto que ya existe en la app. Esto expone UN video puntual detrás de un token
// random (mismo modelo que un link de Loom/Frame.io: sin contraseña, la seguridad es que el
// token es imposible de adivinar), con vencimiento y revocación explícita porque es acceso sin
// login a material del cliente.
module.exports = function videoSharesRoutes({ db, auth, serveFile, safeJsonParse, emitToProject, createNotification }) {
  const router = express.Router();

  const reviewLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: 'Demasiadas solicitudes. Probá de nuevo en unos minutos.' }
  });

  // Ni revocado ni vencido. Se centraliza acá porque las 4 rutas públicas necesitan exactamente el
  // mismo chequeo y el mismo par de códigos de error (404 vs 410 le sirve al front para distinguir
  // "este link nunca existió" de "existió pero ya no está disponible").
  async function getActiveShare(token) {
    const share = await db('video_shares').where({ id: token }).first();
    if (!share) return { error: 404 };
    if (share.revoked) return { error: 410, reason: 'revoked' };
    if (share.expires_at && new Date(share.expires_at) < new Date()) return { error: 410, reason: 'expired' };
    return { share };
  }

  // Admin ve/crea/revoca el link desde el video — deliberadamente admin-only (no "admin o quien
  // subió", como el resto de las acciones sobre un video): decidir qué sale a un cliente externo es
  // una decisión de la agencia, no algo que un editor individual dispare sin que el admin se entere.
  router.get('/api/videos/:videoId/share', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const share = await db('video_shares')
        .where({ video_id: req.params.videoId, revoked: false })
        .where(function() { this.whereNull('expires_at').orWhere('expires_at', '>', new Date().toISOString()); })
        .orderBy('created_at', 'desc')
        .first();
      res.json(share || null);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/videos/:videoId/share', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const video = await db('videos').where({ id: req.params.videoId }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      const days = Math.min(365, Math.max(1, parseInt(req.body.expiresInDays, 10) || 30));
      const id = uuidv4();
      const expires_at = new Date(Date.now() + days * 86400000).toISOString();
      await db('video_shares').insert({ id, video_id: req.params.videoId, created_by: req.user.id, expires_at });
      const share = await db('video_shares').where({ id }).first();
      res.json(share);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/video-shares/:id/revoke', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const updated = await db('video_shares').where({ id: req.params.id }).update({ revoked: true });
      if (!updated) return res.status(404).json({ error: 'Link no encontrado' });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // A partir de acá, rutas PÚBLICAS — sin el middleware `auth`, a propósito. El único guardián es
  // el token en la URL. Nunca deben devolver nada del proyecto más allá de este único video
  // (ni otros videos, ni tareas, ni plata, ni el resto del equipo).
  router.get('/api/review/:token', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveShare(req.params.token);
      if (error) return res.status(error).json({ error: reason === 'revoked' ? 'Este link fue desactivado' : 'Este link ya no está disponible' });
      const video = await db('videos as v')
        .join('projects as p', 'v.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .leftJoin('users as av', 'v.approved_by', 'av.id')
        .where('v.id', share.video_id)
        .select('v.id', 'v.title', 'v.version', 'p.name as project_name', 'p.color as project_color', 'c.name as client_name',
          'v.approved_at', db.raw('COALESCE(av.name, v.approved_by_guest_name) as approved_by_name'))
        .first();
      if (!video) return res.status(404).json({ error: 'El video ya no existe' });
      res.json(video);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/review/:token/file', reviewLimiter, async (req, res) => {
    try {
      const { error, share } = await getActiveShare(req.params.token);
      if (error) return res.status(error).end();
      const video = await db('videos').where({ id: share.video_id }).first();
      if (!video) return res.status(404).end();
      await serveFile(res, video.filename);
    } catch (e) { console.error(e); res.status(500).end(); }
  });

  // Solo comentarios de invitados (guest_name IS NOT NULL) — la conversación interna admin↔editor
  // sobre este mismo video vive en la misma tabla pero nunca sale por esta ruta. Es la decisión de
  // "el cliente ve solo su propio hilo", no todo lo que se habló puertas adentro.
  router.get('/api/review/:token/comments', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveShare(req.params.token);
      if (error) return res.status(error).json({ error: reason === 'revoked' ? 'Este link fue desactivado' : 'Este link ya no está disponible' });
      const comments = await db('video_comments')
        .where({ video_id: share.video_id })
        .whereNotNull('guest_name')
        .select('id', 'content', 'timestamp_sec', 'timestamp_end', 'annotation', 'guest_name', 'created_at')
        .orderBy('timestamp_sec', 'asc');
      // El reproductor público es el mismo componente que el interno (VideoPlayerAnnotator) y
      // espera annotation ya parseado, igual que GET /api/videos/:videoId/comments.
      res.json(comments.map(c => ({ ...c, annotation: safeJsonParse(c.annotation) })));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/review/:token/comments', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveShare(req.params.token);
      if (error) return res.status(error).json({ error: reason === 'revoked' ? 'Este link fue desactivado' : 'Este link ya no está disponible' });
      const { content, timestamp_sec, timestamp_end, guest_name, annotation } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: 'El comentario no puede estar vacío' });
      if (!guest_name?.trim()) return res.status(400).json({ error: 'Falta el nombre' });
      if (annotation && safeJsonParse(annotation) === null) {
        return res.status(400).json({ error: 'Anotación inválida' });
      }
      const id = uuidv4();
      await db('video_comments').insert({
        id, video_id: share.video_id, user_id: null, guest_name: guest_name.trim().slice(0, 60),
        content: content.trim(), timestamp_sec: parseFloat(timestamp_sec) || 0,
        timestamp_end: timestamp_end ? parseFloat(timestamp_end) : null,
        annotation: annotation || null
      });
      const comment = await db('video_comments').where({ id }).select('id', 'content', 'timestamp_sec', 'timestamp_end', 'guest_name', 'created_at').first();
      const full = { ...comment, annotation: safeJsonParse(annotation) };

      // Mismo criterio que el comentario interno: un comentario nuevo (incluido el del cliente
      // desde el link público) invalida una aprobación previa.
      await db('videos').where({ id: share.video_id }).update({ approved_at: null, approved_by: null, approved_by_guest_name: null });
      const video = await db('videos').where({ id: share.video_id }).first();
      if (video) {
        await emitToProject(video.project_id, 'comment:created', { ...full, video_id: share.video_id, attachments: [], replies: [] });
        await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
        // Mismo criterio de destinatarios que un comentario interno (ver POST
        // /api/videos/:videoId/comments): admins + quien subió el video + el asignado de su tarea.
        // No hace falta excluir a "quien comenta" porque el invitado no tiene cuenta que notificar.
        const taskAssignee = video.task_id
          ? (await db('tasks').where({ id: video.task_id }).select('assigned_to').first())?.assigned_to
          : null;
        const directIds = [video.uploaded_by, taskAssignee].filter(Boolean);
        const members = await db('users')
          .where(function() {
            this.where({ role: 'admin' })
              .orWhereIn('id', db('video_comments').where({ video_id: share.video_id }).select('user_id'))
              .orWhereIn('id', directIds);
          });
        for (const m of members) {
          await createNotification({ userId: m.id, type: 'comment', guestName: guest_name.trim(), projectId: video.project_id, videoId: video.id, commentId: id, preview: content?.slice(0, 80) });
        }
      }
      res.json(full);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // El cliente también puede aprobar desde el link público, sin cuenta — mismo patrón que un
  // comentario de invitado: se guarda el nombre como texto (approved_by_guest_name), no un user_id.
  router.patch('/api/review/:token/approve', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveShare(req.params.token);
      if (error) return res.status(error).json({ error: reason === 'revoked' ? 'Este link fue desactivado' : 'Este link ya no está disponible' });
      const { guest_name } = req.body;
      if (!guest_name?.trim()) return res.status(400).json({ error: 'Falta el nombre' });
      const video = await db('videos').where({ id: share.video_id }).first();
      if (!video) return res.status(404).json({ error: 'El video ya no existe' });
      await db('videos').where({ id: share.video_id }).update({
        approved_at: new Date().toISOString(), approved_by: null, approved_by_guest_name: guest_name.trim().slice(0, 60),
      });
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      const notifyIds = new Set((await db('users').where({ role: 'admin' }).pluck('id')));
      if (video.uploaded_by) notifyIds.add(video.uploaded_by);
      for (const uid of notifyIds) {
        await createNotification({ userId: uid, type: 'video_approved', guestName: guest_name.trim(), projectId: video.project_id, videoId: video.id, preview: video.title });
      }
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/review/:token/approve', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveShare(req.params.token);
      if (error) return res.status(error).json({ error: reason === 'revoked' ? 'Este link fue desactivado' : 'Este link ya no está disponible' });
      const video = await db('videos').where({ id: share.video_id }).first();
      if (!video) return res.status(404).json({ error: 'El video ya no existe' });
      await db('videos').where({ id: share.video_id }).update({ approved_at: null, approved_by: null, approved_by_guest_name: null });
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
