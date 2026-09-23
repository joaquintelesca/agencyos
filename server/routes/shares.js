const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// El cliente de la agencia no tiene cuenta ni membresía de proyecto — hasta ahora la única forma
// de que viera el trabajo era exportarlo y mandarlo por WhatsApp/Drive, perdiendo la revisión con
// timestamp exacto que ya existe en la app. Esto expone material detrás de un token random (mismo
// modelo que un link de Loom/Frame.io: sin contraseña, la seguridad es que el token es imposible
// de adivinar), con vencimiento y revocación explícita porque es acceso sin login.
//
// Dos formas de compartir, ambas conviven a propósito (el usuario pidió las dos):
// - video_shares: un link por VIDEO puntual (el original) — sirve para mandar "mirá este corte".
// - client_shares: un link por CLIENTE — un portal estable con todos sus proyectos activos y
//   videos, para no tener que generar/reenviar un link nuevo cada vez que sube algo nuevo.
// La lógica de "qué se puede hacer con un video ya resuelto" (ver metadata, bajar el archivo,
// comentar de invitado, aprobar/desaprobar) es EXACTAMENTE la misma para los dos — solo cambia
// cómo se llega a ese video_id. Por eso vive una sola vez en las funciones de abajo, y cada grupo
// de rutas públicas solo se encarga de resolver su propio token hasta un video_id válido.
module.exports = function sharesRoutes({ db, auth, serveFile, safeJsonParse, emitToProject, createNotification }) {
  const router = express.Router();

  const reviewLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: 'Demasiadas solicitudes. Probá de nuevo en unos minutos.' }
  });

  const shareErrorBody = (reason) => ({ error: reason === 'revoked' ? 'Este link fue desactivado' : 'Este link ya no está disponible' });

  // Ni revocado ni vencido — mismo chequeo para los dos tipos de share, solo cambia la tabla.
  async function getActiveRow(table, token) {
    const share = await db(table).where({ id: token }).first();
    if (!share) return { error: 404 };
    if (share.revoked) return { error: 410, reason: 'revoked' };
    if (share.expires_at && new Date(share.expires_at) < new Date()) return { error: 410, reason: 'expired' };
    return { share };
  }
  const getActiveVideoShare = (token) => getActiveRow('video_shares', token);
  const getActiveClientShare = (token) => getActiveRow('client_shares', token);

  // ── Lógica compartida sobre un video_id ya resuelto (por cualquiera de los dos tipos de link) ──

  async function getVideoForReview(videoId) {
    const video = await db('videos as v')
      .join('projects as p', 'v.project_id', 'p.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .leftJoin('users as av', 'v.approved_by', 'av.id')
      .where('v.id', videoId)
      .select('v.id', 'v.title', 'v.version', 'p.name as project_name', 'p.color as project_color', 'c.name as client_name',
        'v.approved_at', db.raw('COALESCE(av.name, v.approved_by_guest_name) as approved_by_name'), 'p.client_paid')
      .first();
    if (!video) return video;
    // Nunca se expone el monto ni el estado interno de facturación acá — un booleano nada más, para
    // el watermark de "sin cobrar" (ver client/src/components/VideoReviewPane.jsx). client_paid es
    // el único campo interno que se filtra hasta acá, y se borra apenas se deriva el booleano.
    video.paid = video.client_paid === 'cobrado';
    delete video.client_paid;
    return video;
  }

  // Solo comentarios de invitados (guest_name IS NOT NULL) — la conversación interna admin↔editor
  // sobre este mismo video vive en la misma tabla pero nunca sale por acá. Es la decisión de
  // "el cliente ve solo su propio hilo", no todo lo que se habló puertas adentro.
  async function getGuestComments(videoId) {
    const comments = await db('video_comments')
      .where({ video_id: videoId })
      .whereNotNull('guest_name')
      .select('id', 'content', 'timestamp_sec', 'timestamp_end', 'annotation', 'guest_name', 'created_at')
      .orderBy('timestamp_sec', 'asc');
    // El reproductor público es el mismo componente que el interno (VideoPlayerAnnotator) y
    // espera annotation ya parseado, igual que GET /api/videos/:videoId/comments.
    return comments.map(c => ({ ...c, annotation: safeJsonParse(c.annotation) }));
  }

  async function postGuestComment(videoId, { content, timestamp_sec, timestamp_end, guest_name, annotation }) {
    if (!content?.trim()) return { status: 400, body: { error: 'El comentario no puede estar vacío' } };
    if (!guest_name?.trim()) return { status: 400, body: { error: 'Falta el nombre' } };
    if (annotation && safeJsonParse(annotation) === null) return { status: 400, body: { error: 'Anotación inválida' } };
    const id = uuidv4();
    await db('video_comments').insert({
      id, video_id: videoId, user_id: null, guest_name: guest_name.trim().slice(0, 60),
      content: content.trim(), timestamp_sec: parseFloat(timestamp_sec) || 0,
      timestamp_end: timestamp_end ? parseFloat(timestamp_end) : null,
      annotation: annotation || null
    });
    const comment = await db('video_comments').where({ id }).select('id', 'content', 'timestamp_sec', 'timestamp_end', 'guest_name', 'created_at').first();
    const full = { ...comment, annotation: safeJsonParse(annotation) };

    // Mismo criterio que el comentario interno: un comentario nuevo (incluido el del cliente
    // desde el link público) invalida una aprobación previa.
    await db('videos').where({ id: videoId }).update({ approved_at: null, approved_by: null, approved_by_guest_name: null });
    const video = await db('videos').where({ id: videoId }).first();
    if (video) {
      await emitToProject(video.project_id, 'comment:created', { ...full, video_id: videoId, attachments: [], replies: [] });
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      // Mismo criterio de destinatarios que un comentario interno: admins + quien subió el video
      // + el asignado de su tarea. No hace falta excluir a "quien comenta" porque el invitado no
      // tiene cuenta que notificar.
      const taskAssignee = video.task_id
        ? (await db('tasks').where({ id: video.task_id }).select('assigned_to').first())?.assigned_to
        : null;
      const directIds = [video.uploaded_by, taskAssignee].filter(Boolean);
      const members = await db('users')
        .where(function() {
          this.where({ role: 'admin' })
            .orWhereIn('id', db('video_comments').where({ video_id: videoId }).select('user_id'))
            .orWhereIn('id', directIds);
        });
      for (const m of members) {
        await createNotification({ userId: m.id, type: 'comment', guestName: guest_name.trim(), projectId: video.project_id, videoId: video.id, commentId: id, preview: content?.slice(0, 80) });
      }
    }
    return { status: 200, body: full };
  }

  // El cliente también puede aprobar desde el link público, sin cuenta — mismo patrón que un
  // comentario de invitado: se guarda el nombre como texto (approved_by_guest_name), no un user_id.
  async function approveAsGuest(videoId, guestName) {
    if (!guestName?.trim()) return { status: 400, body: { error: 'Falta el nombre' } };
    const video = await db('videos').where({ id: videoId }).first();
    if (!video) return { status: 404, body: { error: 'El video ya no existe' } };
    await db('videos').where({ id: videoId }).update({
      approved_at: new Date().toISOString(), approved_by: null, approved_by_guest_name: guestName.trim().slice(0, 60),
    });
    await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
    const notifyIds = new Set((await db('users').where({ role: 'admin' }).pluck('id')));
    if (video.uploaded_by) notifyIds.add(video.uploaded_by);
    for (const uid of notifyIds) {
      await createNotification({ userId: uid, type: 'video_approved', guestName: guestName.trim(), projectId: video.project_id, videoId: video.id, preview: video.title });
    }
    return { status: 200, body: { success: true } };
  }

  async function unapproveAsGuest(videoId) {
    const video = await db('videos').where({ id: videoId }).first();
    if (!video) return { status: 404, body: { error: 'El video ya no existe' } };
    await db('videos').where({ id: videoId }).update({ approved_at: null, approved_by: null, approved_by_guest_name: null });
    await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
    return { status: 200, body: { success: true } };
  }

  // ── Admin: crear/ver/revocar el link de un VIDEO puntual ───────────────────────────────────
  // Deliberadamente admin-only (no "admin o quien subió", como el resto de las acciones sobre un
  // video): decidir qué sale a un cliente externo es una decisión de la agencia.
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

  // ── Admin: crear/ver/revocar el portal de un CLIENTE ────────────────────────────────────────
  router.get('/api/clients/:clientId/share', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const share = await db('client_shares')
        .where({ client_id: req.params.clientId, revoked: false })
        .where(function() { this.whereNull('expires_at').orWhere('expires_at', '>', new Date().toISOString()); })
        .orderBy('created_at', 'desc')
        .first();
      res.json(share || null);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/clients/:clientId/share', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const client = await db('clients').where({ id: req.params.clientId }).first();
      if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
      const days = Math.min(365, Math.max(1, parseInt(req.body.expiresInDays, 10) || 90));
      const id = uuidv4();
      const expires_at = new Date(Date.now() + days * 86400000).toISOString();
      await db('client_shares').insert({ id, client_id: req.params.clientId, created_by: req.user.id, expires_at });
      const share = await db('client_shares').where({ id }).first();
      res.json(share);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/client-shares/:id/revoke', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const updated = await db('client_shares').where({ id: req.params.id }).update({ revoked: true });
      if (!updated) return res.status(404).json({ error: 'Link no encontrado' });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ── Público: link de un VIDEO puntual ───────────────────────────────────────────────────────
  // Sin el middleware `auth`, a propósito. El único guardián es el token en la URL. Nunca deben
  // devolver nada del proyecto más allá de este único video (ni otros videos, ni tareas, ni plata).
  router.get('/api/review/:token', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveVideoShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      const video = await getVideoForReview(share.video_id);
      if (!video) return res.status(404).json({ error: 'El video ya no existe' });
      res.json(video);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/review/:token/file', reviewLimiter, async (req, res) => {
    try {
      const { error, share } = await getActiveVideoShare(req.params.token);
      if (error) return res.status(error).end();
      const video = await db('videos').where({ id: share.video_id }).first();
      if (!video) return res.status(404).end();
      await serveFile(res, video.filename);
    } catch (e) { console.error(e); res.status(500).end(); }
  });

  router.get('/api/review/:token/comments', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveVideoShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      res.json(await getGuestComments(share.video_id));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/review/:token/comments', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveVideoShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      const { status, body } = await postGuestComment(share.video_id, req.body);
      res.status(status).json(body);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/review/:token/approve', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveVideoShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      const { status, body } = await approveAsGuest(share.video_id, req.body.guest_name);
      res.status(status).json(body);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/review/:token/approve', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveVideoShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      const { status, body } = await unapproveAsGuest(share.video_id);
      res.status(status).json(body);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ── Público: portal de un CLIENTE ────────────────────────────────────────────────────────────
  // Resuelve el token a un client_id y, para las acciones sobre un video puntual, valida ADEMÁS
  // que ese video pertenezca a un proyecto de ese mismo cliente — sin este chequeo, cualquiera con
  // un link de portal válido de OTRO cliente podría adivinar/probar ids de video ajenos.
  async function resolveClientVideo(clientId, videoId) {
    return db('videos as v')
      .join('projects as p', 'v.project_id', 'p.id')
      .where('v.id', videoId)
      .andWhere('p.client_id', clientId)
      .select('v.id')
      .first();
  }

  router.get('/api/client-review/:token', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      const client = await db('clients').where({ id: share.client_id }).select('id', 'name', 'color').first();
      if (!client) return res.status(404).json({ error: 'El cliente ya no existe' });
      // Solo proyectos activos — uno ya terminado/pagado no necesita seguimiento del cliente, y
      // mezclar años de historial en el mismo portal le resta utilidad al "qué tengo pendiente hoy".
      const projects = await db('projects').where({ client_id: share.client_id, status: 'active' }).select('id', 'name', 'color');
      const projectIds = projects.map(p => p.id);
      const videos = projectIds.length
        ? await db('videos as v')
            .leftJoin('users as av', 'v.approved_by', 'av.id')
            .whereIn('v.project_id', projectIds)
            .select('v.id', 'v.project_id', 'v.title', 'v.version', 'v.created_at', 'v.approved_at',
              db.raw('COALESCE(av.name, v.approved_by_guest_name) as approved_by_name'))
            .orderBy('v.created_at', 'desc')
        : [];
      const videosByProject = {};
      for (const v of videos) (videosByProject[v.project_id] ??= []).push(v);
      res.json({
        client,
        projects: projects.map(p => ({ ...p, videos: videosByProject[p.id] || [] })),
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/client-review/:token/video/:videoId', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      if (!await resolveClientVideo(share.client_id, req.params.videoId)) return res.status(404).json({ error: 'El video ya no existe' });
      const video = await getVideoForReview(req.params.videoId);
      if (!video) return res.status(404).json({ error: 'El video ya no existe' });
      res.json(video);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/client-review/:token/video/:videoId/file', reviewLimiter, async (req, res) => {
    try {
      const { error, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).end();
      const owned = await resolveClientVideo(share.client_id, req.params.videoId);
      if (!owned) return res.status(404).end();
      const video = await db('videos').where({ id: req.params.videoId }).first();
      if (!video) return res.status(404).end();
      await serveFile(res, video.filename);
    } catch (e) { console.error(e); res.status(500).end(); }
  });

  router.get('/api/client-review/:token/video/:videoId/comments', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      if (!await resolveClientVideo(share.client_id, req.params.videoId)) return res.status(404).json({ error: 'El video ya no existe' });
      res.json(await getGuestComments(req.params.videoId));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/client-review/:token/video/:videoId/comments', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      if (!await resolveClientVideo(share.client_id, req.params.videoId)) return res.status(404).json({ error: 'El video ya no existe' });
      const { status, body } = await postGuestComment(req.params.videoId, req.body);
      res.status(status).json(body);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/client-review/:token/video/:videoId/approve', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      if (!await resolveClientVideo(share.client_id, req.params.videoId)) return res.status(404).json({ error: 'El video ya no existe' });
      const { status, body } = await approveAsGuest(req.params.videoId, req.body.guest_name);
      res.status(status).json(body);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/client-review/:token/video/:videoId/approve', reviewLimiter, async (req, res) => {
    try {
      const { error, reason, share } = await getActiveClientShare(req.params.token);
      if (error) return res.status(error).json(shareErrorBody(reason));
      if (!await resolveClientVideo(share.client_id, req.params.videoId)) return res.status(404).json({ error: 'El video ya no existe' });
      const { status, body } = await unapproveAsGuest(req.params.videoId);
      res.status(status).json(body);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
