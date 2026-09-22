const express = require('express');

// Primer módulo extraído de server/index.js (3900+ líneas, todo en un solo archivo) hacia una
// estructura de rutas separadas — empezando por las secciones más autocontenidas (esta solo
// depende de `db` y del middleware `auth`, nada de io/uploads/helpers compartidos) para probar el
// patrón antes de mover las secciones más grandes o con más dependencias cruzadas.
module.exports = function searchRoutes({ db, auth }) {
  const router = express.Router();

  // Búsqueda global (Ctrl-K): antes la única forma de encontrar algo era expandir cliente por
  // cliente en el sidebar a mano, insostenible pasados unos pocos proyectos. LOWER(x) LIKE en vez
  // de ILIKE porque LIKE es case-sensitive en Postgres pero no en SQLite — esta forma funciona
  // igual en los dos motores sin bifurcar la query según el entorno.
  router.get('/api/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (q.length < 2) return res.json({ projects: [], clients: [], tasks: [], videos: [], comments: [] });
      const like = `%${q.toLowerCase()}%`;
      const isAdmin = req.user.role === 'admin';

      // Mismo alcance que ya aplican GET /api/projects y GET /api/clients: un editor solo busca
      // dentro de los proyectos donde es miembro, nunca en la agencia entera.
      let memberProjectIds = null;
      if (!isAdmin) {
        memberProjectIds = await db('project_members').where({ user_id: req.user.id }).pluck('project_id');
        if (memberProjectIds.length === 0) return res.json({ projects: [], clients: [], tasks: [], videos: [], comments: [] });
      }

      const projectsQ = db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .whereRaw('LOWER(p.name) LIKE ?', [like])
        .select('p.id', 'p.name', 'p.color', 'p.status', 'c.name as client_name')
        .limit(10);
      if (!isAdmin) projectsQ.whereIn('p.id', memberProjectIds);

      const clientsQ = db('clients').whereRaw('LOWER(name) LIKE ?', [like]).select('id', 'name', 'color').limit(10);
      if (!isAdmin) {
        const clientIds = await db('project_members as pm')
          .join('projects as p', 'pm.project_id', 'p.id')
          .where('pm.user_id', req.user.id).whereNotNull('p.client_id').pluck('p.client_id');
        clientsQ.whereIn('id', [...new Set(clientIds)]);
      }

      // Igual que el kanban (GET /api/projects/:id/tasks): un editor solo ve SUS tareas dentro de
      // los proyectos donde es miembro, no todas las de esos proyectos.
      const tasksQ = db('tasks as t')
        .join('projects as p', 't.project_id', 'p.id')
        .where(function() { this.whereRaw('LOWER(t.title) LIKE ?', [like]).orWhereRaw('LOWER(t.description) LIKE ?', [like]); })
        .select('t.id', 't.title', 't.project_id', 'p.name as project_name', 'p.color as project_color')
        .limit(10);
      if (!isAdmin) { tasksQ.whereIn('t.project_id', memberProjectIds); tasksQ.where('t.assigned_to', req.user.id); }

      const videosQ = db('videos as v')
        .join('projects as p', 'v.project_id', 'p.id')
        .whereRaw('LOWER(v.title) LIKE ?', [like])
        .select('v.id', 'v.title', 'v.project_id', 'p.name as project_name', 'p.color as project_color')
        .limit(10);
      if (!isAdmin) videosQ.whereIn('v.project_id', memberProjectIds);

      const commentsQ = db('video_comments as vc')
        .join('videos as v', 'vc.video_id', 'v.id')
        .join('projects as p', 'v.project_id', 'p.id')
        .whereRaw('LOWER(vc.content) LIKE ?', [like])
        .select('vc.id', 'vc.content', 'vc.video_id', 'v.project_id', 'v.title as video_title', 'p.name as project_name', 'p.color as project_color')
        .limit(10);
      if (!isAdmin) commentsQ.whereIn('v.project_id', memberProjectIds);

      const [projects, clients, tasks, videos, comments] = await Promise.all([projectsQ, clientsQ, tasksQ, videosQ, commentsQ]);
      res.json({ projects, clients, tasks, videos, comments });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
