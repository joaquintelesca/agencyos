const express = require('express');

// Timeline de actividad de un proyecto — de solo lectura, la escritura pasa por logActivity()
// desde cada acción real (tasks.js, video-upload.js, video-comments.js, payments.js, projects.js,
// shares.js). Mismo criterio de paginación que /api/notifications: limit/offset con tope, para no
// dejar pedir la tabla entera de una en un proyecto viejo con mucho historial.
module.exports = function activityRoutes({ db, auth, requireProjectAccess }) {
  const router = express.Router();

  router.get('/api/projects/:projectId/activity', auth, requireProjectAccess(), async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const rows = await db('project_activity as a')
        .leftJoin('users as u', 'a.actor_id', 'u.id')
        .where('a.project_id', req.params.projectId)
        .select('a.id', 'a.type', 'a.actor_id', 'a.guest_name', 'a.data', 'a.created_at',
          'u.name as actor_name', 'u.avatar_color as actor_color')
        .orderBy('a.created_at', 'desc')
        .limit(limit)
        .offset(offset);
      res.json(rows.map(r => ({ ...r, data: r.data ? JSON.parse(r.data) : null })));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
