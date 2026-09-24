const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function tasksRoutes({ db, auth, requireProjectAccess, isProjectMember, addProjectMember, removeProjectMemberIfOrphaned, emitToProject, createNotification, TASK_STATUSES, logActivity }) {
  const router = express.Router();

  // Cuántas tareas activas tiene cada integrante AHORA MISMO — hoy, para asignar una tarea nueva
  // hay que ir proyecto por proyecto adivinando quién tiene lugar. Solo cuenta tareas de proyectos
  // 'active' (el backlog de un proyecto ya terminado no es carga real) y excluye 'done' (ya no
  // pesa en la capacidad de nadie). Antes de 'done', no 'terminadas' — TASK_STATUSES completo
  // salvo la última, para no hardcodear la lista acá si algún día cambia.
  router.get('/api/team/workload', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const rows = await db('tasks as t')
        .join('projects as p', 't.project_id', 'p.id')
        .where('p.status', 'active')
        .whereNotNull('t.assigned_to')
        .whereNot('t.status', 'done')
        .select('t.assigned_to', 't.status')
        .count('* as count')
        .groupBy('t.assigned_to', 't.status');
      const byUser = {};
      for (const r of rows) {
        byUser[r.assigned_to] ??= {};
        byUser[r.assigned_to][r.status] = Number(r.count);
      }
      res.json(byUser);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/projects/:projectId/tasks', auth, requireProjectAccess(), async (req, res) => {
    try {
      let query = db('tasks as t')
        .leftJoin('users as u', 't.assigned_to', 'u.id')
        .where('t.project_id', req.params.projectId)
        .select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color');
      if (req.user.role !== 'admin') query = query.where('t.assigned_to', req.user.id);
      const tasks = await query
        .orderBy('t.created_at', 'asc');

      // Último video (mayor versión) enlazado a cada tarea, para poder saltar directo a él desde
      // la tarjeta del kanban en vez de tener que buscarlo a mano en la pestaña Videos.
      const linkedVideos = await db('videos')
        .where({ project_id: req.params.projectId })
        .whereNotNull('task_id')
        .select('id', 'task_id', 'version', 'created_at');
      const latestVideoByTask = {};
      for (const v of linkedVideos) {
        const cur = latestVideoByTask[v.task_id];
        if (!cur || v.version > cur.version || (v.version === cur.version && new Date(v.created_at) > new Date(cur.created_at))) {
          latestVideoByTask[v.task_id] = v;
        }
      }
      res.json(tasks.map(t => ({ ...t, latest_video_id: latestVideoByTask[t.id]?.id || null })));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/projects/:projectId/tasks', auth, requireProjectAccess(), async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede crear tareas' });
      const { title, description, status, priority, assigned_to, due_date } = req.body;
      if (!title?.trim()) return res.status(400).json({ error: 'El título de la tarea es obligatorio' });
      if (status !== undefined && !TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado de tarea inválido' });
      if (assigned_to && !await db('users').where({ id: assigned_to }).first()) {
        return res.status(400).json({ error: 'El usuario asignado no existe' });
      }
      const id = uuidv4();
      await db('tasks').insert({ id, project_id: req.params.projectId, title, description, status: status || 'todo', priority: priority || 'medium', assigned_to: assigned_to || null, created_by: req.user.id, due_date: due_date || null });
      if (assigned_to) await addProjectMember(req.params.projectId, assigned_to);
      const task = await db('tasks as t').leftJoin('users as u', 't.assigned_to', 'u.id').where('t.id', id).select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color').first();
      await emitToProject(req.params.projectId, 'task:created', task);
      await logActivity({ projectId: req.params.projectId, type: 'task_created', actorId: req.user.id, data: { title } });
      if (assigned_to) {
        const project = await db('projects').where({ id: req.params.projectId }).first();
        await createNotification({ userId: assigned_to, type: 'task_assigned', actorId: req.user.id, projectId: req.params.projectId, preview: `"${title}" en ${project?.name || 'proyecto'}` });
      }
      res.json(task);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.put('/api/tasks/:id', auth, async (req, res) => {
    try {
      const existing = await db('tasks').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (!await isProjectMember(req.user.id, req.user.role, existing.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      const { title, description, status, priority, assigned_to, due_date } = req.body;
      if (status !== undefined && !TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'Estado de tarea inválido' });
      if (req.user.role !== 'admin') {
        if (existing.assigned_to !== req.user.id) return res.status(403).json({ error: 'Solo podés cambiar el estado de tus tareas asignadas' });
        await db('tasks').where({ id: req.params.id }).update({ status, updated_at: new Date().toISOString() });
      } else {
        if (assigned_to && !await db('users').where({ id: assigned_to }).first()) {
          return res.status(400).json({ error: 'El usuario asignado no existe' });
        }
        // Update parcial: solo se tocan los campos que realmente vinieron en el body. Antes se
        // sobreescribían todos los campos con lo que mandara el cliente (incluidos los que no
        // cambiaron) — si dos personas editaban la misma tarea casi a la vez (típicamente arrastrar
        // una tarjeta en el Kanban, que solo quiere cambiar el status), la segunda pisaba con datos
        // viejos lo que la primera acababa de guardar.
        const update = { updated_at: new Date().toISOString() };
        if (title !== undefined) update.title = title;
        if (description !== undefined) update.description = description;
        if (status !== undefined) update.status = status;
        if (priority !== undefined) update.priority = priority;
        if (assigned_to !== undefined) update.assigned_to = assigned_to || null;
        if (due_date !== undefined) update.due_date = due_date || null;
        await db('tasks').where({ id: req.params.id }).update(update);
        if (assigned_to) {
          await addProjectMember(existing.project_id, assigned_to);
          const project = await db('projects').where({ id: existing.project_id }).first();
          if (!project.payment_editor_id) {
            const assignedUser = await db('users').where({ id: assigned_to }).first();
            if (assignedUser && assignedUser.role !== 'admin') {
              await db('projects').where({ id: existing.project_id }).update({ payment_editor_id: assigned_to });
            }
          }
          if (assigned_to !== existing.assigned_to) {
            await createNotification({ userId: assigned_to, type: 'task_assigned', actorId: req.user.id, projectId: existing.project_id, preview: `"${title || existing.title}" en ${project?.name || 'proyecto'}` });
          }
        }
        // Si la tarea tenía otro asignado antes (o se desasignó del todo), ese usuario no debería
        // seguir viendo el board/chat/videos del proyecto solo por esa tarea que ya no es suya.
        if (assigned_to !== undefined && existing.assigned_to && assigned_to !== existing.assigned_to) {
          await removeProjectMemberIfOrphaned(existing.project_id, existing.assigned_to);
        }
      }
      const task = await db('tasks as t').leftJoin('users as u', 't.assigned_to', 'u.id').where('t.id', req.params.id).select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color').first();
      await emitToProject(existing.project_id, 'task:updated', task);
      if (status !== undefined && status !== existing.status) {
        await logActivity({ projectId: existing.project_id, type: 'task_status_changed', actorId: req.user.id, data: { title: existing.title, from: existing.status, to: status } });
      }
      if (assigned_to && assigned_to !== existing.assigned_to) {
        await logActivity({ projectId: existing.project_id, type: 'task_assigned', actorId: req.user.id, data: { title: task.title, assignee_name: task.assignee_name } });
      }
      if (status === 'review' && existing.status !== 'review') {
        const admins = await db('users').where({ role: 'admin' }).select('id');
        const project = await db('projects').where({ id: existing.project_id }).first();
        for (const admin of admins) {
          await createNotification({ userId: admin.id, type: 'task_review', actorId: req.user.id, projectId: existing.project_id, preview: `"${existing.title}" en ${project?.name || 'proyecto'}` });
        }
      }
      if (status === 'feedback' && existing.status !== 'feedback') {
        const targetUserId = task.assigned_to;
        if (targetUserId && targetUserId !== req.user.id) {
          const project = await db('projects').where({ id: existing.project_id }).first();
          await createNotification({ userId: targetUserId, type: 'task_feedback', actorId: req.user.id, projectId: existing.project_id, preview: `"${existing.title}" en ${project?.name || 'proyecto'}` });
        }
      }
      // Antes ninguna transición a "done" avisaba a nadie — un editor podía terminar una tarea sin
      // pasarla por "review" (el estado lo puede cambiar libremente a lo que sea, no solo a review)
      // y el admin no se enteraba salvo que mirara el kanban a mano.
      if (status === 'done' && existing.status !== 'done') {
        const admins = await db('users').where({ role: 'admin' }).select('id');
        const project = await db('projects').where({ id: existing.project_id }).first();
        for (const admin of admins) {
          await createNotification({ userId: admin.id, type: 'task_done', actorId: req.user.id, projectId: existing.project_id, preview: `"${existing.title}" en ${project?.name || 'proyecto'}` });
        }
      }
      res.json(task);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/tasks/:id', auth, async (req, res) => {
    try {
      const existing = await db('tasks').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (!await isProjectMember(req.user.id, req.user.role, existing.project_id)) {
        return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
      }
      if (req.user.role !== 'admin' && existing.assigned_to !== req.user.id) {
        return res.status(403).json({ error: 'Solo podés eliminar tus tareas asignadas' });
      }
      await db('videos').where({ task_id: req.params.id }).update({ task_id: null });
      await db('tasks').where({ id: req.params.id }).delete();
      // Borrar la última tarea de un editor lo deja sin motivo para seguir teniendo acceso al
      // proyecto. Sin esto se quedaba con el board, el chat y los videos para siempre: la limpieza
      // de huérfanos ya corría al reasignar tareas y al cambiar de editor, pero no al borrarlas.
      if (existing.assigned_to) await removeProjectMemberIfOrphaned(existing.project_id, existing.assigned_to);
      await emitToProject(existing.project_id, 'task:deleted', { id: req.params.id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
