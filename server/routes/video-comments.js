const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function videoCommentsRoutes({ db, auth, isProjectMember, safeJsonParse, attachmentUploadMiddleware, emitToProject, extractMentionedUserIds, createNotification, safeUnlink }) {
  const router = express.Router();

  router.get('/api/videos/:videoId/comments', auth, async (req, res) => {
    try {
      const video = await db('videos').where({ id: req.params.videoId }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      // leftJoin, no join: un comentario del link de revisión (cliente externo) no tiene user_id,
      // y un INNER JOIN ahí los sacaba directo de la lista en vez de solo faltarles el nombre.
      const comments = await db('video_comments as vc').leftJoin('users as u', 'vc.user_id', 'u.id')
        .where('vc.video_id', req.params.videoId)
        .select('vc.*', 'u.avatar_color')
        .select(db.raw('COALESCE(u.name, vc.guest_name) as user_name'))
        .orderBy('vc.timestamp_sec', 'asc');

      // Antes se hacía una query de attachments + otra de replies (y otra de attachments) POR
      // comentario — con muchos comentarios eso son decenas de round-trips por cada carga del
      // video. Ahora se trae todo en 3 queries batched (por comment_id / reply_id) y se arma
      // en memoria con maps, sin importar cuántos comentarios haya.
      const commentIds = comments.map(c => c.id);
      const [allAttachments, allReplies] = commentIds.length
        ? await Promise.all([
            db('comment_attachments').whereIn('comment_id', commentIds),
            db('comment_replies as r').join('users as u', 'r.user_id', 'u.id').whereIn('r.comment_id', commentIds)
              .select('r.*', 'u.name as user_name', 'u.avatar_color').orderBy('r.created_at', 'asc')
          ])
        : [[], []];
      const replyIds = allReplies.map(r => r.id);
      const allReplyAttachments = replyIds.length ? await db('reply_attachments').whereIn('reply_id', replyIds) : [];

      const attachmentsByComment = {};
      for (const a of allAttachments) (attachmentsByComment[a.comment_id] ??= []).push(a);
      const replyAttachmentsByReply = {};
      for (const a of allReplyAttachments) (replyAttachmentsByReply[a.reply_id] ??= []).push(a);
      const repliesByComment = {};
      for (const r of allReplies) {
        (repliesByComment[r.comment_id] ??= []).push({ ...r, attachments: replyAttachmentsByReply[r.id] || [] });
      }

      const withAttachments = comments.map(c => ({
        ...c,
        attachments: attachmentsByComment[c.id] || [],
        replies: repliesByComment[c.id] || [],
        annotation: safeJsonParse(c.annotation)
      }));
      res.json(withAttachments);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/videos/:videoId/comments', auth, async (req, res, next) => {
    try {
      const video = await db('videos').where({ id: req.params.videoId }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      next();
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  }, attachmentUploadMiddleware, async (req, res) => {
    try {
      const { content, timestamp_sec, timestamp_end, annotation } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: 'El comentario no puede estar vacío' });
      if (annotation && safeJsonParse(annotation) === null) {
        return res.status(400).json({ error: 'Anotación inválida' });
      }
      const id = uuidv4();
      await db('video_comments').insert({
        id, video_id: req.params.videoId, user_id: req.user.id, content,
        timestamp_sec: parseFloat(timestamp_sec) || 0,
        timestamp_end: timestamp_end ? parseFloat(timestamp_end) : null,
        annotation: annotation || null
      });
      if (req.files?.length) {
        await db('comment_attachments').insert(req.files.map(f => ({ id: uuidv4(), comment_id: id, filename: f.filename, original_name: f.originalname })));
      }
      // Un comentario nuevo sobre un video ya aprobado invalida esa aprobación — quedó feedback
      // pendiente de mirar, así que seguir mostrándolo como "aprobado" sería engañoso. Mismo criterio
      // que GitHub descartando aprobaciones de PR ante un commit nuevo.
      await db('videos').where({ id: req.params.videoId }).update({ approved_at: null, approved_by: null, approved_by_guest_name: null });
      const comment = await db('video_comments as vc').join('users as u', 'vc.user_id', 'u.id').where('vc.id', id).select('vc.*', 'u.name as user_name', 'u.avatar_color').first();
      const attachments = await db('comment_attachments').where({ comment_id: id });
      const full = { ...comment, attachments, annotation: safeJsonParse(annotation) };
      const video = await db('videos').where({ id: req.params.videoId }).first();
      if (video) await emitToProject(video.project_id, 'comment:created', full);
      if (video) await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      if (video) {
        // El editor que subió el video (y el asignado de su tarea) tienen que enterarse sí o sí:
        // antes los destinatarios eran solo "admins + quien ya haya comentado este video", así que
        // dejarle feedback con timestamps a un editor que todavía no había comentado no le generaba
        // ninguna señal — el loop central de revisión dependía de que además le movieran la tarea.
        const taskAssignee = video.task_id
          ? (await db('tasks').where({ id: video.task_id }).select('assigned_to').first())?.assigned_to
          : null;
        const directIds = [video.uploaded_by, taskAssignee].filter(Boolean);
        const recipients = await db('users')
          .where('id', '!=', req.user.id)
          .where(function() {
            this.where({ role: 'admin' })
              .orWhereIn('id', db('video_comments').where({ video_id: req.params.videoId }).select('user_id'))
              .orWhereIn('id', directIds);
          });
        // A quien mencionaron le llega "te mencionaron" en vez del genérico "comentó en un video" —
        // mandarle los dos sería el mismo aviso anunciado dos veces distintas.
        const mentionedIds = new Set(extractMentionedUserIds(content));
        for (const m of recipients) {
          const type = mentionedIds.has(m.id) ? 'mention' : 'comment';
          await createNotification({ userId: m.id, type, actorId: req.user.id, projectId: video.project_id, videoId: video.id, commentId: id, preview: content?.slice(0, 80) });
          mentionedIds.delete(m.id);
        }
        // Alguien mencionado que no estuviera ya en la lista de destinatarios habituales (por
        // ejemplo, un editor de otra tarea del mismo proyecto que nunca comentó este video) igual
        // tiene que enterarse — la mención es una invitación explícita a mirar, no solo un aviso pasivo.
        for (const uid of mentionedIds) {
          await createNotification({ userId: uid, type: 'mention', actorId: req.user.id, projectId: video.project_id, videoId: video.id, commentId: id, preview: content?.slice(0, 80) });
        }
      }
      res.json(full);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Un typo o una corrección chica obligaba a borrar el comentario entero y crearlo de nuevo
  // (perdiendo el hilo de respuestas si tenía). Solo el texto es editable — no timestamp ni
  // dibujo, que son "dónde/qué mirar" y cambiarlos en silencio confundiría a quien ya lo vio.
  // Mismo criterio de permiso que borrar: el autor o un admin.
  router.patch('/api/comments/:id', auth, async (req, res) => {
    try {
      const comment = await db('video_comments').where({ id: req.params.id }).first();
      if (!comment) return res.status(404).json({ error: 'No encontrado' });
      const video = await db('videos').where({ id: comment.video_id }).first();
      if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Sin acceso' });
      }
      const content = req.body.content?.trim();
      if (!content) return res.status(400).json({ error: 'El comentario no puede estar vacío' });
      await db('video_comments').where({ id: req.params.id }).update({ content });
      await emitToProject(video.project_id, 'comment:updated', { id: req.params.id, content });
      res.json({ id: req.params.id, content });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/comments/:id/resolve', auth, async (req, res) => {
    try {
      const comment = await db('video_comments').where({ id: req.params.id }).first();
      if (!comment) return res.status(404).json({ error: 'No encontrado' });
      const video = await db('videos').where({ id: comment.video_id }).first();
      if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      const resolved = !comment.resolved;
      await db('video_comments').where({ id: req.params.id }).update({ resolved });
      await emitToProject(video.project_id, 'comment:resolved', { id: req.params.id, resolved });
      // Antes quien escribió el comentario (típicamente el cliente marcando algo a corregir) nunca
      // se enteraba de que se resolvió salvo que volviera a abrir el video — solo al resolver, no
      // al reabrir, y solo si tiene cuenta (un comentario de invitado no tiene a quién notificar acá).
      if (resolved && comment.user_id) {
        await createNotification({ userId: comment.user_id, type: 'comment_resolved', actorId: req.user.id, projectId: video.project_id, videoId: video.id, commentId: req.params.id, preview: comment.content?.slice(0, 80) });
      }
      res.json({ id: req.params.id, resolved });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/comments/:id', auth, async (req, res) => {
    try {
      const comment = await db('video_comments').where({ id: req.params.id }).first();
      if (!comment) return res.status(404).json({ error: 'No encontrado' });
      const video = await db('videos').where({ id: comment.video_id }).first();
      if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Sin acceso' });
      }
      const replyIds = await db('comment_replies').where({ comment_id: req.params.id }).pluck('id');
      const commentAttachments = await db('comment_attachments').where({ comment_id: req.params.id });
      const replyAttachments = replyIds.length ? await db('reply_attachments').whereIn('reply_id', replyIds) : [];

      await db.transaction(async trx => {
        if (replyIds.length) await trx('reply_attachments').whereIn('reply_id', replyIds).delete();
        await trx('comment_attachments').where({ comment_id: req.params.id }).delete();
        await trx('comment_replies').where({ comment_id: req.params.id }).delete();
        await trx('video_comments').where({ id: req.params.id }).delete();
        await trx('notifications').where({ comment_id: req.params.id }).delete();
      });

      commentAttachments.forEach(a => safeUnlink(a.filename));
      replyAttachments.forEach(a => safeUnlink(a.filename));

      await emitToProject(video.project_id, 'comment:deleted', { id: req.params.id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // GET replies for a comment
  router.get('/api/comments/:id/replies', auth, async (req, res) => {
    try {
      const comment = await db('video_comments').where({ id: req.params.id }).first();
      if (!comment) return res.status(404).json({ error: 'No encontrado' });
      const video = await db('videos').where({ id: comment.video_id }).first();
      if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      const replies = await db('comment_replies as r')
        .join('users as u', 'r.user_id', 'u.id')
        .where('r.comment_id', req.params.id)
        .select('r.*', 'u.name as user_name', 'u.avatar_color')
        .orderBy('r.created_at', 'asc');
      const withAttachments = await Promise.all(replies.map(async r => ({
        ...r,
        attachments: await db('reply_attachments').where({ reply_id: r.id })
      })));
      res.json(withAttachments);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // POST create reply
  router.post('/api/comments/:id/replies', auth, async (req, res, next) => {
    try {
      const comment = await db('video_comments').where({ id: req.params.id }).first();
      if (!comment) return res.status(404).json({ error: 'No encontrado' });
      const video = await db('videos').where({ id: comment.video_id }).first();
      if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      next();
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  }, attachmentUploadMiddleware, async (req, res) => {
    try {
      const { content } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: 'La respuesta no puede estar vacía' });
      const id = uuidv4();
      await db('comment_replies').insert({ id, comment_id: req.params.id, user_id: req.user.id, content });
      if (req.files?.length) {
        await db('reply_attachments').insert(req.files.map(f => ({ id: uuidv4(), reply_id: id, filename: f.filename, original_name: f.originalname })));
      }
      const reply = await db('comment_replies as r').join('users as u', 'r.user_id', 'u.id').where('r.id', id).select('r.*', 'u.name as user_name', 'u.avatar_color').first();
      const attachments = await db('reply_attachments').where({ reply_id: id });
      const full = { ...reply, attachments };
      const parentComment = await db('video_comments').where({ id: req.params.id }).first();
      if (parentComment) {
        const video = await db('videos').where({ id: parentComment.video_id }).first();
        if (video) await emitToProject(video.project_id, 'comment:reply', full);
        // parentComment.user_id es null cuando el comentario original es de un invitado externo
        // (link de revisión) — no tiene cuenta ni in-app notifications, así que no hay a quién
        // notificar acá (createNotification inserta con user_id NOT NULL, se rompería si se llamara).
        if (parentComment.user_id && parentComment.user_id !== req.user.id) {
          await createNotification({ userId: parentComment.user_id, type: 'reply', actorId: req.user.id, projectId: video?.project_id, videoId: parentComment.video_id, commentId: req.params.id, preview: content?.slice(0, 80) });
        }
        if (video) {
          const mentionedIds = extractMentionedUserIds(content).filter(uid => uid !== req.user.id && uid !== parentComment.user_id);
          for (const uid of mentionedIds) {
            await createNotification({ userId: uid, type: 'mention', actorId: req.user.id, projectId: video.project_id, videoId: parentComment.video_id, commentId: req.params.id, preview: content?.slice(0, 80) });
          }
        }
      }
      res.json(full);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
