const express = require('express');

module.exports = function dashboardRoutes({ db, auth }) {
  const router = express.Router();

  router.get('/api/dashboard/pending-videos', auth, async (req, res) => {
    try {
      let projectFilter = null;
      if (req.user.role !== 'admin') {
        projectFilter = await db('project_members')
          .where({ user_id: req.user.id }).pluck('project_id');
      }

      // Videos vinculados a tareas en revisión
      let reviewQuery = db('videos as v')
        .join('tasks as tk', function() {
          this.on('v.task_id', 'tk.id').andOn('tk.status', db.raw('?', ['review']));
        })
        .join('projects as p', 'v.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .leftJoin('users as u', 'v.uploaded_by', 'u.id')
        .select(
          'v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at',
          'p.name as project_name', 'p.color as project_color',
          'c.name as client_name',
          'u.name as uploader_name',
          'tk.id as task_id', 'tk.title as task_title',
          db.raw('? as type', ['review'])
        );
      if (projectFilter) reviewQuery = reviewQuery.whereIn('v.project_id', projectFilter);
      const reviewVideos = await reviewQuery;

      // Videos con comentarios sin resolver (excluyendo los que ya están en revisión, y los que
      // ya están en "Aplicar feedback" — ese estado ya le avisa al editor que tiene que resolverlos,
      // así que mostrárselo también acá como "pendiente" al admin era un segundo aviso de lo mismo,
      // encima confuso porque ahí la pelota ya no está del lado del admin).
      const reviewVideoIds = reviewVideos.map(v => v.id);
      let commentsQuery = db('videos as v')
        .join('video_comments as vc', function() {
          this.on('vc.video_id', 'v.id').andOn('vc.resolved', db.raw('?', [false]));
        })
        .leftJoin('tasks as tk', 'v.task_id', 'tk.id')
        .join('projects as p', 'v.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .leftJoin('users as u', 'v.uploaded_by', 'u.id')
        .where(function() { this.whereNull('tk.status').orWhereNot('tk.status', 'feedback'); })
        .select(
          'v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at',
          'p.name as project_name', 'p.color as project_color',
          'c.name as client_name',
          'u.name as uploader_name',
          db.raw('count(vc.id) as unresolved_count'),
          db.raw('? as type', ['comments'])
        )
        .groupBy('v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at',
          'p.name', 'p.color', 'c.name', 'u.name');
      if (projectFilter) commentsQuery = commentsQuery.whereIn('v.project_id', projectFilter);
      if (reviewVideoIds.length > 0) commentsQuery = commentsQuery.whereNotIn('v.id', reviewVideoIds);
      const commentVideos = await commentsQuery;

      res.json([...reviewVideos, ...commentVideos]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Todos los videos de la plataforma con su categoría ya calculada (admin only) — misma
  // distinción review/comentarios-sin-resolver que /pending-videos de arriba, más "unreviewed"
  // (nadie dejó nunca un comentario) y "approved" (se revisó y quedó resuelto) para el resto.
  router.get('/api/dashboard/videos-overview', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const unresolvedSub = db('video_comments')
        .where({ resolved: false })
        .groupBy('video_id')
        .select('video_id', db.raw('count(*) as unresolved_count'));
      // Antes "approved" era el catch-all de "no está trabado en ningún lado", así que un video
      // recién subido sin tarea vinculada ni comentarios caía ahí por descarte — no porque alguien
      // lo hubiera aprobado (no existe ninguna acción de "aprobar" en la app), sino porque nada lo
      // frenaba. total_count (todos los comentarios, no solo los sin resolver) es lo que separa
      // "nadie lo miró todavía" de "se revisó y quedó resuelto".
      const totalSub = db('video_comments')
        .groupBy('video_id')
        .select('video_id', db.raw('count(*) as total_count'));
      const videos = await db('videos as v')
        .join('projects as p', 'v.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .leftJoin('users as u', 'v.uploaded_by', 'u.id')
        .leftJoin('users as av', 'v.approved_by', 'av.id')
        .leftJoin('tasks as tk', 'v.task_id', 'tk.id')
        .leftJoin(unresolvedSub.as('uc'), 'uc.video_id', 'v.id')
        .leftJoin(totalSub.as('tc'), 'tc.video_id', 'v.id')
        .select(
          'v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at', 'v.file_size',
          'p.name as project_name', 'p.color as project_color',
          'c.id as client_id', 'c.name as client_name', 'c.color as client_color',
          'u.name as uploader_name',
          'tk.title as task_title', 'tk.status as task_status',
          'v.approved_at', 'v.approved_by_guest_name',
          db.raw('COALESCE(av.name, v.approved_by_guest_name) as approved_by_name'),
          db.raw('COALESCE(uc.unresolved_count, 0) as unresolved_count'),
          // La aprobación explícita gana siempre — si un humano ya lo decidió, eso pesa más que
          // el estado inferido de la tarea o los comentarios (por ejemplo, un comentario nuevo
          // menor después de aprobar no debería tapar la aprobación en el resumen).
          db.raw(`CASE WHEN v.approved_at IS NOT NULL THEN 'approved'
                       WHEN tk.status = 'review' THEN 'review'
                       WHEN COALESCE(uc.unresolved_count, 0) > 0 THEN 'editing'
                       WHEN COALESCE(tc.total_count, 0) = 0 THEN 'unreviewed'
                       ELSE 'approved' END as category`)
        )
        .orderBy('v.created_at', 'desc');
      res.json(videos);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
