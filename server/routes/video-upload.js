const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const {
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
} = require('@aws-sdk/client-s3');

module.exports = function videoUploadRoutes({
  db, auth, io, requireProjectAccess, uploadLimiter, isProjectMember, emitToProject, createNotification, safeUnlink,
  useR2, s3, R2_BUCKET, uploadsDir, VIDEO_MIME_EXT, verifyFileSignature, STORAGE_HARD_LIMIT_BYTES,
  CHUNK_SIZE, VIDEO_MAX_BYTES, chunksDir, uploadSessions, discardUploadSession, getUploadsSize, STORAGE_WARN_BYTES,
  logActivity,
}) {
  const router = express.Router();

  // Inicia una subida: valida tipo/tamaño y guarda los metadatos del video a crear
  // (se usan recién al completar, para no tener que volver a mandarlos en cada parte).
  router.post('/api/projects/:projectId/videos/upload/init', auth, uploadLimiter, requireProjectAccess(), async (req, res) => {
    try {
      const { originalName, mimetype, fileSize, title, version, task_id, stack_with } = req.body;
      const ext = VIDEO_MIME_EXT[mimetype];
      if (!ext) return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo se aceptan videos.' });
      const size = Number(fileSize);
      if (!size || size <= 0) return res.status(400).json({ error: 'Tamaño de archivo inválido' });
      if (size > VIDEO_MAX_BYTES) return res.status(400).json({ error: 'Archivo demasiado grande (máx. 3GB)' });
      const usedBytes = await getUploadsSize();
      if (usedBytes + size > STORAGE_HARD_LIMIT_BYTES) {
        return res.status(507).json({ error: 'No hay espacio de almacenamiento disponible. Contactá al administrador.' });
      }
      const uploadId = uuidv4();
      const key = `${uuidv4()}${ext}`;
      const session = {
        userId: req.user.id, projectId: req.params.projectId, mimetype, ext,
        totalSize: size, receivedBytes: 0, createdAt: Date.now(),
        meta: { title: title || originalName, originalName: originalName || title, version, task_id: task_id || null, stack_with: stack_with || null }
      };
      if (useR2) {
        const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, ContentType: mimetype }));
        session.key = key;
        session.r2UploadId = created.UploadId;
        session.parts = new Map();
      } else {
        session.tempPath = path.join(chunksDir, uploadId);
        await fs.promises.writeFile(session.tempPath, Buffer.alloc(0));
      }
      uploadSessions.set(uploadId, session);
      res.json({ uploadId, chunkSize: CHUNK_SIZE });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Recibe una parte del archivo. El offset lo manda el cliente pero manda la posta el servidor:
  // si no coincide con lo que ya se recibió, se rechaza con el offset correcto (permite retomar
  // tras una reconexión sin duplicar ni perder bytes). Con R2, el offset determina el número de
  // parte (son partes fijas de CHUNK_SIZE) — reintentar la misma parte simplemente la pisa, es
  // idempotente por diseño, no hace falta lógica extra de deduplicación.
  router.post('/api/videos/upload/:uploadId/chunk', auth, express.raw({ type: '*/*', limit: CHUNK_SIZE + 1024 * 1024 }), async (req, res) => {
    try {
      const session = uploadSessions.get(req.params.uploadId);
      if (!session) return res.status(404).json({ error: 'Subida no encontrada o expirada' });
      if (session.userId !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
      if (!await isProjectMember(req.user.id, req.user.role, session.projectId)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      const offset = Number(req.query.offset);
      if (offset !== session.receivedBytes) {
        return res.status(409).json({ error: 'Desincronizado', expectedOffset: session.receivedBytes });
      }
      const chunk = req.body;
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) return res.status(400).json({ error: 'Parte vacía' });
      if (session.receivedBytes + chunk.length > session.totalSize) {
        return res.status(400).json({ error: 'La subida excede el tamaño declarado' });
      }
      if (useR2) {
        const partNumber = Math.floor(offset / CHUNK_SIZE) + 1;
        // La primera parte siempre trae la firma/header real del archivo — verificarla acá, antes
        // de gastar ancho de banda subiendo el resto de un archivo que en realidad no es un video.
        if (partNumber === 1 && !await verifyFileSignature(chunk, session.mimetype)) {
          await discardUploadSession(session);
          uploadSessions.delete(req.params.uploadId);
          return res.status(400).json({ error: 'El contenido del archivo no coincide con el tipo de video declarado.' });
        }
        const uploaded = await s3.send(new UploadPartCommand({
          Bucket: R2_BUCKET, Key: session.key, UploadId: session.r2UploadId, PartNumber: partNumber, Body: chunk
        }));
        session.parts.set(partNumber, { ETag: uploaded.ETag, PartNumber: partNumber });
      } else {
        await fs.promises.appendFile(session.tempPath, chunk);
      }
      session.receivedBytes += chunk.length;
      res.json({ receivedBytes: session.receivedBytes });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Finaliza: cierra la subida (multipart complete en R2, o renombra el temporal a disco) y crea
  // el registro del video (misma lógica que antes tenía el endpoint multipart de un solo POST).
  router.post('/api/videos/upload/:uploadId/complete', auth, async (req, res) => {
    try {
      const session = uploadSessions.get(req.params.uploadId);
      if (!session) return res.status(404).json({ error: 'Subida no encontrada o expirada' });
      if (session.userId !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
      if (!await isProjectMember(req.user.id, req.user.role, session.projectId)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      if (session.receivedBytes !== session.totalSize) {
        return res.status(400).json({ error: 'Subida incompleta' });
      }
      let filename;
      if (useR2) {
        const parts = Array.from(session.parts.values()).sort((a, b) => a.PartNumber - b.PartNumber);
        await s3.send(new CompleteMultipartUploadCommand({
          Bucket: R2_BUCKET, Key: session.key, UploadId: session.r2UploadId, MultipartUpload: { Parts: parts }
        }));
        filename = session.key;
      } else {
        // Con disco local la firma recién se puede verificar acá (no hay forma barata de ver el
        // primer chunk por separado del resto una vez que appendFile los concatenó todos juntos).
        if (!await verifyFileSignature(session.tempPath, session.mimetype)) {
          await fs.promises.unlink(session.tempPath).catch(() => {});
          uploadSessions.delete(req.params.uploadId);
          return res.status(400).json({ error: 'El contenido del archivo no coincide con el tipo de video declarado.' });
        }
        filename = `${uuidv4()}${session.ext}`;
        await fs.promises.rename(session.tempPath, path.join(uploadsDir, filename));
      }
      uploadSessions.delete(req.params.uploadId);

      const { title, originalName, version, task_id, stack_with } = session.meta;
      const id = uuidv4();
      let groupId = null;
      if (stack_with) {
        const parentVideo = await db('videos').where({ id: stack_with }).first();
        if (parentVideo && parentVideo.project_id === session.projectId) {
          groupId = parentVideo.group_id || uuidv4();
          if (!parentVideo.group_id) {
            await db('videos').where({ id: stack_with }).update({ group_id: groupId });
          }
        }
      }
      await db('videos').insert({ id, project_id: session.projectId, title, filename, original_name: originalName || title, version: parseInt(version) || 1, uploaded_by: req.user.id, file_size: session.totalSize, task_id: task_id || null, group_id: groupId });
      const video = await db('videos as v').leftJoin('users as u', 'v.uploaded_by', 'u.id').leftJoin('tasks as tk', 'v.task_id', 'tk.id').where('v.id', id).select('v.*', 'u.name as uploader_name', 'tk.title as task_title').first();
      await emitToProject(session.projectId, 'video:uploaded', video);
      await logActivity({ projectId: session.projectId, type: 'video_uploaded', actorId: req.user.id, data: { title, version: video.version } });
      // Subir un video no cambia el estado de ninguna tarea por sí solo (eso es una acción aparte
      // del usuario), así que sin esto un admin podía no enterarse nunca de que hay contenido
      // nuevo para revisar si nadie tocaba el kanban.
      const admins = await db('users').where({ role: 'admin' }).select('id');
      for (const admin of admins) {
        await createNotification({ userId: admin.id, type: 'video_uploaded', actorId: req.user.id, projectId: session.projectId, videoId: id, preview: title });
      }
      const bytes = await getUploadsSize();
      if (bytes >= STORAGE_WARN_BYTES) {
        admins.forEach(({ id: adminId }) => io.to(`user:${adminId}`).emit('storage:warning', { bytes, gb: (bytes / (1024 ** 3)).toFixed(2) }));
      }
      res.json(video);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Cancela una subida en curso (botón "Cancelar" del cliente, o limpieza al desmontar).
  router.delete('/api/videos/upload/:uploadId', auth, async (req, res) => {
    try {
      const session = uploadSessions.get(req.params.uploadId);
      if (session) {
        if (session.userId !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
        await discardUploadSession(session);
        uploadSessions.delete(req.params.uploadId);
      }
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/videos/:id', auth, async (req, res) => {
    try {
      const video = await db('videos').where({ id: req.params.id }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      // Lo puede borrar el admin o el editor que lo subió — no cualquier miembro del proyecto.
      if (req.user.role !== 'admin' && video.uploaded_by !== req.user.id) {
        return res.status(403).json({ error: 'Solo el admin o quien subió el video puede eliminarlo' });
      }
      const commentIds = await db('video_comments').where({ video_id: req.params.id }).pluck('id');
      const replyIds = commentIds.length ? await db('comment_replies').whereIn('comment_id', commentIds).pluck('id') : [];
      const commentAttachments = commentIds.length ? await db('comment_attachments').whereIn('comment_id', commentIds) : [];
      const replyAttachments = replyIds.length ? await db('reply_attachments').whereIn('reply_id', replyIds) : [];

      await db.transaction(async trx => {
        if (replyIds.length) await trx('reply_attachments').whereIn('reply_id', replyIds).delete();
        if (commentIds.length) await trx('comment_attachments').whereIn('comment_id', commentIds).delete();
        if (replyIds.length) await trx('comment_replies').whereIn('id', replyIds).delete();
        if (commentIds.length) await trx('video_comments').whereIn('id', commentIds).delete();
        // Las notificaciones que apuntaban a este video (o a sus comentarios) quedaban colgadas:
        // al clickearlas llevaban a un video que ya no existe.
        await trx('notifications').where({ video_id: req.params.id }).delete();
        if (commentIds.length) await trx('notifications').whereIn('comment_id', commentIds).delete();
        await trx('videos').where({ id: req.params.id }).delete();
      });

      safeUnlink(video.filename);
      if (video.thumbnail_filename) safeUnlink(video.thumbnail_filename);
      commentAttachments.forEach(a => safeUnlink(a.filename));
      replyAttachments.forEach(a => safeUnlink(a.filename));

      await emitToProject(video.project_id, 'video:deleted', { id: req.params.id, projectId: video.project_id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // "Aprobado" antes era solo un estado inferido (sin comentarios sin resolver, sin tarea en
  // revisión) — no había ninguna acción real de aprobar, así que un video sin ningún comentario
  // caía ahí por descarte. Esto le da al equipo/cliente un cierre explícito. Cualquier miembro del
  // proyecto puede aprobar (no admin-only): normalmente es quien está revisando, no necesariamente
  // el admin. Un comentario nuevo después invalida la aprobación (ver POST .../comments).
  router.patch('/api/videos/:id/approve', auth, async (req, res) => {
    try {
      const video = await db('videos').where({ id: req.params.id }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      await db('videos').where({ id: req.params.id }).update({
        approved_at: new Date().toISOString(), approved_by: req.user.id, approved_by_guest_name: null,
      });
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      await logActivity({ projectId: video.project_id, type: 'video_approved', actorId: req.user.id, data: { title: video.title, version: video.version } });
      // Antes solo se avisaba a los admins — si un editor subió el video, nunca se enteraba de que
      // se aprobó salvo que volviera a mirar el proyecto a mano. Mismo criterio de destinatarios
      // que un comentario nuevo: admins + quien subió el video (sin duplicar si es la misma persona
      // y sin notificarse a sí mismo, ya filtrado por createNotification).
      const notifyIds = new Set((await db('users').where({ role: 'admin' }).pluck('id')));
      if (video.uploaded_by) notifyIds.add(video.uploaded_by);
      for (const uid of notifyIds) {
        await createNotification({ userId: uid, type: 'video_approved', actorId: req.user.id, projectId: video.project_id, videoId: video.id, preview: video.title });
      }
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/videos/:id/approve', auth, async (req, res) => {
    try {
      const video = await db('videos').where({ id: req.params.id }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      await db('videos').where({ id: req.params.id }).update({ approved_at: null, approved_by: null, approved_by_guest_name: null });
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Stack: agrupa dos videos (o agrega uno a un grupo existente)
  router.patch('/api/videos/:id/stack', auth, async (req, res) => {
    try {
      const { targetVideoId } = req.body;
      if (!targetVideoId) return res.status(400).json({ error: 'Falta targetVideoId' });
      const video = await db('videos').where({ id: req.params.id }).first();
      const target = await db('videos').where({ id: targetVideoId }).first();
      if (!video || !target) return res.status(404).json({ error: 'Video no encontrado' });
      if (video.project_id !== target.project_id) return res.status(400).json({ error: 'Los videos deben ser del mismo proyecto' });
      if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      const groupId = target.group_id || video.group_id || uuidv4();
      const idsToUpdate = [req.params.id, targetVideoId];
      if (video.group_id && video.group_id !== groupId) {
        const oldGroupMembers = await db('videos').where({ group_id: video.group_id }).pluck('id');
        idsToUpdate.push(...oldGroupMembers);
      }
      if (target.group_id && target.group_id !== groupId) {
        const oldGroupMembers = await db('videos').where({ group_id: target.group_id }).pluck('id');
        idsToUpdate.push(...oldGroupMembers);
      }
      await db('videos').whereIn('id', [...new Set(idsToUpdate)]).update({ group_id: groupId });
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      res.json({ success: true, group_id: groupId });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Unstack: saca un video de su grupo
  router.patch('/api/videos/:id/unstack', auth, async (req, res) => {
    try {
      const video = await db('videos').where({ id: req.params.id }).first();
      if (!video) return res.status(404).json({ error: 'Video no encontrado' });
      if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      if (!video.group_id) return res.json({ success: true });
      const groupId = video.group_id;
      await db('videos').where({ id: req.params.id }).update({ group_id: null });
      const remaining = await db('videos').where({ group_id: groupId });
      if (remaining.length === 1) {
        await db('videos').where({ id: remaining[0].id }).update({ group_id: null });
      }
      await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/storage', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const bytes = await getUploadsSize();
      res.json({ bytes, gb: (bytes / (1024 ** 3)).toFixed(2), warning: bytes >= STORAGE_WARN_BYTES });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Qué está ocupando el espacio, desglosado por proyecto. Hasta ahora el aviso del sidebar decía
  // "considerá borrar archivos viejos" sin dar ninguna forma de ver cuáles ni de borrarlos: al
  // llegar al límite duro las subidas fallan con STORAGE_FULL y la única salida era borrar
  // proyectos enteros (que se lleva videos, tareas y chat en cascada).
  //
  // SOLO LECTURA a propósito: esto no borra nada ni marca nada para borrar. Sugiere candidatos
  // (`candidate: true`) pero la selección y el borrado los hace el usuario a mano desde la UI,
  // reusando DELETE /api/videos/:id. Pedido explícito del usuario: nada se borra sin preguntarle.
  router.get('/api/storage/breakdown', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const totalBytes = await getUploadsSize();

      const videos = await db('videos as v')
        .join('projects as p', 'v.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .select('v.id', 'v.title', 'v.version', 'v.file_size', 'v.created_at', 'v.approved_at', 'v.project_id',
          'p.name as project_name', 'p.status as project_status', 'p.client_paid', 'p.ever_completed',
          'c.name as client_name', 'c.color as client_color')
        .orderBy('v.created_at', 'desc');

      const byProject = new Map();
      for (const v of videos) {
        if (!byProject.has(v.project_id)) {
          byProject.set(v.project_id, {
            project_id: v.project_id, project_name: v.project_name, project_status: v.project_status,
            client_name: v.client_name, client_color: v.client_color,
            // "Cerrado y cobrado" es la condición que habilita sugerir sus borradores intermedios:
            // el trabajo terminó y la plata entró, así que las versiones viejas ya no se usan para
            // nada. Sigue siendo solo una sugerencia visual.
            settled: (v.project_status === 'completed' || !!v.ever_completed) && v.client_paid === 'cobrado',
            bytes: 0, videos: [],
          });
        }
        const group = byProject.get(v.project_id);
        group.bytes += Number(v.file_size) || 0;
        group.videos.push({
          id: v.id, title: v.title, version: v.version, bytes: Number(v.file_size) || 0,
          created_at: v.created_at, approved: !!v.approved_at,
        });
      }

      const projects = [...byProject.values()].map(p => {
        // El más reciente del proyecto es la entrega vigente — nunca se sugiere, aunque el
        // proyecto esté cerrado y cobrado.
        const latestId = p.videos.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a), p.videos[0])?.id;
        return {
          ...p,
          videos: p.videos.map(v => ({
            ...v,
            latest: v.id === latestId,
            candidate: p.settled && !v.approved && v.id !== latestId,
          })),
        };
      }).sort((a, b) => b.bytes - a.bytes);

      const videosBytes = projects.reduce((s, p) => s + p.bytes, 0);
      res.json({
        totalBytes,
        limitBytes: STORAGE_HARD_LIMIT_BYTES,
        videosBytes,
        // El total real del bucket incluye miniaturas y adjuntos de chat/comentarios, que no se
        // administran desde acá — se muestra la diferencia para que los números cierren en pantalla
        // en vez de dejar un hueco sin explicar. Puede dar 0 si el escaneo está cacheado y quedó
        // corto respecto de la DB.
        otherBytes: Math.max(0, totalBytes - videosBytes),
        projects,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
