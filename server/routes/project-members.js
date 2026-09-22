const express = require('express');

module.exports = function projectMembersRoutes({ db, auth, io, requireProjectAccess, addProjectMember }) {
  const router = express.Router();

  router.get('/api/projects/:projectId/members', auth, requireProjectAccess(), async (req, res) => {
    try {
      const members = await db('project_members as pm')
        .join('users as u', 'pm.user_id', 'u.id')
        .where('pm.project_id', req.params.projectId)
        .select('u.id', 'u.name', 'u.avatar_color', 'u.role', 'pm.role as member_role');
      res.json(members);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/projects/:projectId/members', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { user_id } = req.body;
      const user = await db('users').where({ id: user_id }).first();
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
      await addProjectMember(req.params.projectId, user_id);
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/projects/:projectId/members/:userId', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { projectId, userId } = req.params;
      // Sacar a alguien que todavía tiene trabajo asignado (o que es el editor que cobra) lo deja
      // en un estado roto: sigue figurando como responsable pero sin poder ver el board ni el chat.
      // Se pide resolver primero eso, que es una decisión del admin, no algo para inferir acá.
      const project = await db('projects').where({ id: projectId }).first();
      if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
      if (project.payment_editor_id === userId) {
        return res.status(409).json({ error: 'Es el editor que cobra este proyecto. Cambiá el editor antes de sacarle el acceso.' });
      }
      const hasTask = await db('tasks').where({ project_id: projectId, assigned_to: userId }).first();
      if (hasTask) {
        return res.status(409).json({ error: 'Todavía tiene tareas asignadas en este proyecto. Reasignalas antes de sacarle el acceso.' });
      }
      await db('project_members').where({ project_id: projectId, user_id: userId }).delete();
      // Sin esto el socket ya conectado sigue en la room del proyecto y recibe el chat en vivo
      // hasta que recargue (mismo cierre que hace removeProjectMemberIfOrphaned).
      io.in(`user:${userId}`).socketsLeave(`project:${projectId}`);
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
