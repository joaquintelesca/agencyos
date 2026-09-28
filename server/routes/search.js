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
      if (q.length < 2) return res.json({ projects: [], clients: [], tasks: [], videos: [], comments: [], projectMessages: [], chatMessages: [] });
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

      // Chat del proyecto (tabla `messages`, la pestaña "Chat" dentro de un proyecto) — mismo
      // alcance por membresía que el resto: un editor solo busca en los proyectos donde participa.
      const projectMessagesQ = db('messages as m')
        .join('projects as p', 'm.project_id', 'p.id')
        .join('users as u', 'm.sender_id', 'u.id')
        .whereRaw('LOWER(m.content) LIKE ?', [like])
        .select('m.id', 'm.content', 'm.project_id', 'p.name as project_name', 'p.color as project_color', 'u.name as sender_name')
        .orderBy('m.created_at', 'desc')
        .limit(10);
      if (!isAdmin) projectMessagesQ.whereIn('m.project_id', memberProjectIds);

      // Chat general (DMs + canales, tabla `chat_messages` — la pestaña "Chat" del sidebar, un
      // sistema totalmente separado del de arriba). Un DM solo lo puede buscar quien es una de las
      // dos partes; un canal, un admin (ve todos) o quien ya es miembro — mismo criterio de acceso
      // que ya aplican GET /api/chat/conversations y GET /api/chat/messages, nunca "cualquier admin
      // ve todo" para los DMs, porque un DM ajeno es una conversación privada aunque el que busca
      // sea admin.
      let myChannelIds = [];
      if (!isAdmin) myChannelIds = await db('chat_channel_members').where({ user_id: req.user.id }).pluck('channel_id');
      const chatMessagesQ = db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .leftJoin('users as ru', 'm.receiver_id', 'ru.id')
        .leftJoin('chat_channels as ch', 'm.channel_id', 'ch.id')
        .whereRaw('LOWER(m.content) LIKE ?', [like])
        .where(function() {
          this.where(function() {
            this.where('m.type', 'dm').andWhere(function() {
              this.where('m.sender_id', req.user.id).orWhere('m.receiver_id', req.user.id);
            });
          });
          if (isAdmin) {
            this.orWhere('m.type', 'channel');
          } else if (myChannelIds.length) {
            this.orWhere(function() { this.where('m.type', 'channel').whereIn('m.channel_id', myChannelIds); });
          }
        })
        .select('m.id', 'm.content', 'm.type', 'm.sender_id', 'm.receiver_id', 'm.channel_id', 'm.client_id',
          'u.name as sender_name', 'ru.name as receiver_name', 'ch.name as channel_name')
        .orderBy('m.created_at', 'desc')
        .limit(10);

      const [projects, clients, tasks, videos, comments, projectMessages, chatMessages] = await Promise.all([
        projectsQ, clientsQ, tasksQ, videosQ, commentsQ, projectMessagesQ, chatMessagesQ,
      ]);
      res.json({ projects, clients, tasks, videos, comments, projectMessages, chatMessages });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
