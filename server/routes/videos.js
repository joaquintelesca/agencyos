const express = require('express');

module.exports = function videosRoutes({ db, auth, requireProjectAccess, thumbnailUpload, isProjectMember, verifyAndPersistFiles, THUMBNAIL_MIME_EXT, emitToProject }) {
  const router = express.Router();

  router.get('/api/projects/:projectId/videos', auth, requireProjectAccess(), async (req, res) => {
    try {
      const videos = await db('videos as v')
        .leftJoin('users as u', 'v.uploaded_by', 'u.id')
        .leftJoin('users as av', 'v.approved_by', 'av.id')
        .leftJoin('tasks as tk', 'v.task_id', 'tk.id')
        .where('v.project_id', req.params.projectId)
        .select('v.*', 'u.name as uploader_name', 'tk.title as task_title',
          db.raw('COALESCE(av.name, v.approved_by_guest_name) as approved_by_name'))
        .orderBy('v.created_at', 'desc');
      res.json(videos);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/videos/:id/thumbnail', auth, (req, res, next) => {
    thumbnailUpload.single('thumbnail')(req, res, async (err) => {
      if (err && err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ error: 'La miniatura tiene que ser una imagen' });
      if (err && err.message === 'STORAGE_FULL') return res.status(507).json({ error: 'No hay espacio de almacenamiento disponible.' });
      if (err) return res.status(400).json({ error: err.message || 'Error al subir la miniatura' });
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo de la miniatura' });
      try {
        const video = await db('videos').where({ id: req.params.id }).first();
        if (!video) return res.status(404).json({ error: 'Video no encontrado' });
        if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
          return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
        }
        if (!await verifyAndPersistFiles([req.file], THUMBNAIL_MIME_EXT)) {
          return res.status(400).json({ error: 'El contenido del archivo no coincide con una imagen' });
        }
        await db('videos').where({ id: req.params.id }).update({ thumbnail_filename: req.file.filename });
        await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
        res.json({ success: true, thumbnail_filename: req.file.filename });
      } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
    });
  });

  return router;
};
