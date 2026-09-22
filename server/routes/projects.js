const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function projectsRoutes({ db, auth, io, requireProjectAccess, withDeletedEditorFallback, withComputedTotals, stripProjectFinancials, addProjectMember, emitToProject, createNotification, parseUpworkFeePct, removeProjectMemberIfOrphaned, OWNER_EMAIL, safeUnlink }) {
  const router = express.Router();

  router.get('/api/projects', auth, async (req, res) => {
    try {
      let query = db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .leftJoin('users as eu', 'p.payment_editor_id', 'eu.id')
        .select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color', 'eu.email as _editor_email')
        .orderBy([{ column: 'p.sort_order', order: 'asc' }, { column: 'p.created_at', order: 'desc' }]);

      if (req.user.role !== 'admin') {
        const memberProjectIds = await db('project_members')
          .where({ user_id: req.user.id }).pluck('project_id');
        query = query.whereIn('p.id', memberProjectIds);
      }

      const projects = await query;
      const taskCounts = await db('tasks')
        .select('project_id')
        .count('* as task_count')
        .select(db.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as done_count', ['done']))
        .select(db.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as review_count', ['review']))
        .groupBy('project_id');
      const countsMap = {};
      for (const row of taskCounts) {
        countsMap[row.project_id] = { task_count: Number(row.task_count), done_count: Number(row.done_count), review_count: Number(row.review_count) };
      }
      // El puntito de "revisión pendiente" del sidebar se basa en esto (notificaciones sin leer),
      // no en review_count de arriba — antes usaba el estado real de la tarea, así que marcar la
      // notificación como leída no lo apagaba aunque la tarea siguiera sin moverse de columna.
      // Es por usuario a propósito: cada admin tiene su propia notificación y su propio "visto".
      const unreadReviewRows = await db('notifications')
        .where({ user_id: req.user.id, read: false })
        .whereIn('type', ['task_review', 'task_feedback', 'video_uploaded'])
        .whereNotNull('project_id')
        .select('project_id')
        .count('* as count')
        .groupBy('project_id');
      const unreadReviewMap = {};
      for (const row of unreadReviewRows) unreadReviewMap[row.project_id] = Number(row.count);
      const mutedIds = new Set(await db('notification_mutes').where({ user_id: req.user.id }).pluck('project_id'));
      const withCounts = projects.map(p => {
        withDeletedEditorFallback(p);
        withComputedTotals(p);
        return {
          ...(req.user.role === 'admin' ? p : stripProjectFinancials(p)),
          ...(countsMap[p.id] || { task_count: 0, done_count: 0, review_count: 0 }),
          unread_review_count: unreadReviewMap[p.id] || 0,
          muted: mutedIds.has(p.id)
        };
      });
      res.json(withCounts);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/api/projects/:id', auth, requireProjectAccess('id'), async (req, res) => {
    try {
      const project = await db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .leftJoin('users as eu', 'p.payment_editor_id', 'eu.id')
        .where('p.id', req.params.id)
        .select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color', 'eu.email as _editor_email')
        .first();
      if (!project) return res.status(404).json({ error: 'No encontrado' });
      withDeletedEditorFallback(project);
      withComputedTotals(project);
      const muted = !!(await db('notification_mutes').where({ user_id: req.user.id, project_id: req.params.id }).first());
      res.json({ ...(req.user.role === 'admin' ? project : stripProjectFinancials(project)), muted });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Silenciar/reactivar notificaciones de este proyecto para quien hace el pedido — es por usuario,
  // no global: cada uno decide su propio volumen sin afectar al resto del equipo.
  router.post('/api/projects/:id/mute', auth, requireProjectAccess('id'), async (req, res) => {
    try {
      const existing = await db('notification_mutes').where({ user_id: req.user.id, project_id: req.params.id }).first();
      if (!existing) await db('notification_mutes').insert({ id: uuidv4(), user_id: req.user.id, project_id: req.params.id });
      res.json({ muted: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/projects/:id/mute', auth, requireProjectAccess('id'), async (req, res) => {
    try {
      await db('notification_mutes').where({ user_id: req.user.id, project_id: req.params.id }).delete();
      res.json({ muted: false });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/projects', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede crear proyectos' });
      const { name, description, color, payment_editor_id, payment_type, payment_amount, payment_hours, client_id, deadline, client_amount, upwork_status, upwork_fee_pct, material_link } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'El nombre del proyecto es obligatorio' });
      const id = uuidv4();
      await db('projects').insert({
        id, name, description, color: color || '#6366f1', created_by: req.user.id,
        client_id: client_id || null,
        deadline: deadline || null,
        material_link: material_link?.trim() || null,
        payment_editor_id: payment_editor_id || null,
        payment_type: payment_type || 'fixed',
        payment_amount: parseFloat(payment_amount) || 0,
        payment_hours: parseFloat(payment_hours) || 0,
        client_amount: parseFloat(client_amount) || 0,
        payment_status: 'unpaid',
        upwork_status: upwork_status || 'pending',
        upwork_fee_pct: upwork_status && upwork_status !== 'No' ? parseUpworkFeePct(upwork_fee_pct) : null
      });
      await addProjectMember(id, req.user.id, 'owner');
      if (payment_editor_id) await addProjectMember(id, payment_editor_id);
      const project = await db('projects').where({ id }).first();
      await emitToProject(id, 'project:created', project);
      if (payment_editor_id) await createNotification({ userId: payment_editor_id, type: 'project_assigned', actorId: req.user.id, projectId: id, preview: name });
      res.json(project);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Clona la config de un proyecto (cliente, editor, tipo/tarifa de pago) y sus tareas (título,
  // descripción, prioridad, asignado) para el caso recurrente de "otro proyecto igual al anterior".
  // A propósito NO se copian: deadline (no tiene sentido heredar la fecha de otro trabajo), nada de
  // lo ya cobrado/pagado (es un proyecto nuevo, sin historial de plata todavía — status/ever_completed/
  // *_paid/*_paid_at/*_paid_amount/completed_at arrancan en blanco aunque la tarifa configurada sea
  // la misma), ni el estado de las tareas (todas arrancan en 'todo', sin due_date ni comentarios/videos).
  router.post('/api/projects/:id/duplicate', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede duplicar proyectos' });
      const source = await db('projects').where({ id: req.params.id }).first();
      if (!source) return res.status(404).json({ error: 'Proyecto no encontrado' });
      const id = uuidv4();
      await db('projects').insert({
        id, name: `${source.name} (copia)`, description: source.description, color: source.color,
        created_by: req.user.id, client_id: source.client_id, deadline: null, material_link: null,
        payment_editor_id: source.payment_editor_id, payment_type: source.payment_type,
        payment_amount: source.payment_amount, payment_hours: source.payment_hours,
        client_amount: source.client_amount, payment_status: 'unpaid',
        upwork_status: source.upwork_status, upwork_fee_pct: source.upwork_fee_pct
      });
      await addProjectMember(id, req.user.id, 'owner');
      if (source.payment_editor_id) await addProjectMember(id, source.payment_editor_id);

      const sourceTasks = await db('tasks').where({ project_id: source.id });
      if (sourceTasks.length) {
        await db('tasks').insert(sourceTasks.map(t => ({
          id: uuidv4(), project_id: id, title: t.title, description: t.description,
          status: 'todo', priority: t.priority, assigned_to: t.assigned_to, created_by: req.user.id,
          due_date: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        })));
      }

      const project = await db('projects').where({ id }).first();
      await emitToProject(id, 'project:created', project);
      if (source.payment_editor_id) await createNotification({ userId: source.payment_editor_id, type: 'project_assigned', actorId: req.user.id, projectId: id, preview: project.name });
      res.json(project);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.put('/api/projects/:id', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { name, description, color, status, payment_editor_id, payment_type, payment_amount, payment_hours, payment_status, upwork_status, upwork_fee_pct, client_id, deadline, client_amount, material_link } = req.body;
      let existing;
      let editorLocked = false;
      await db.transaction(async trx => {
        // forUpdate() bloquea la fila hasta que termine esta transacción — si en paralelo se está
        // marcando "pagado"/"cobrado" en PATCH /api/payments/:projectId (que toma el mismo lock),
        // una de las dos operaciones espera a la otra en vez de que esta pise horas/monto justo
        // cuando la otra está por congelar el monto pagado a partir de esos mismos campos.
        existing = await trx('projects').where({ id: req.params.id }).forUpdate().first();
        if (!existing) return;
        // Cambiar de editor cuando el pago al editor ya está registrado dejaría el "pagado" y el
        // monto congelado del editor anterior colgando del nuevo: el balance mensual listaría esa
        // plata a nombre de alguien que nunca la cobró, y el registro del que sí cobró se pierde.
        // Se frena acá y se pide desmarcar el pago primero, que es una decisión explícita del admin.
        if ((payment_editor_id || null) !== (existing.payment_editor_id || null) && existing.editor_paid === 'paid') {
          editorLocked = true;
          return;
        }
        const update = {
          name, description, color, status,
          client_id: client_id || null,
          deadline: deadline || null,
          material_link: material_link?.trim() || null,
          payment_editor_id: payment_editor_id || null,
          payment_type, payment_status, upwork_status,
          upwork_fee_pct: upwork_status && upwork_status !== 'No' ? parseUpworkFeePct(upwork_fee_pct) : null
        };
        if (payment_amount !== undefined) update.payment_amount = Math.max(0, parseFloat(payment_amount) || 0);
        if (payment_hours !== undefined) update.payment_hours = Math.max(0, parseFloat(payment_hours) || 0);
        if (client_amount !== undefined) update.client_amount = Math.max(0, parseFloat(client_amount) || 0);
        await trx('projects').where({ id: req.params.id }).update(update);
      });
      if (!existing) return res.status(404).json({ error: 'Proyecto no encontrado' });
      if (editorLocked) return res.status(409).json({ error: 'Este proyecto ya tiene registrado el pago al editor. Desmarcá "Pagado" en Pagos antes de cambiar de editor.' });
      if (payment_editor_id) await addProjectMember(req.params.id, payment_editor_id);
      if (payment_editor_id && payment_editor_id !== existing.payment_editor_id) {
        await createNotification({ userId: payment_editor_id, type: 'project_assigned', actorId: req.user.id, projectId: req.params.id, preview: name || existing.name });
      }
      // Si se cambió el editor, el anterior no debería seguir viendo el board/chat/videos de este
      // proyecto — se saca solo si de verdad ya no tiene otro motivo para seguir ahí (ver comentario
      // en removeProjectMemberIfOrphaned).
      if (existing.payment_editor_id && existing.payment_editor_id !== payment_editor_id) {
        await removeProjectMemberIfOrphaned(req.params.id, existing.payment_editor_id);
      }
      const project = withDeletedEditorFallback(await db('projects as p').leftJoin('clients as c', 'p.client_id', 'c.id').leftJoin('users as eu', 'p.payment_editor_id', 'eu.id').where('p.id', req.params.id).select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color', 'eu.email as _editor_email').first());
      // Sin esto, editor_is_owner/computed_* faltaban en la respuesta de este endpoint en
      // particular (los demás sí lo aplicaban) — no rompía nada visible hoy porque Payments.jsx/
      // Dashboard.jsx recargan de /api/payments en vez de confiar en este payload, pero quedaba
      // como una inconsistencia latente esperando a que algo empezara a depender de ella.
      withComputedTotals(project);
      await emitToProject(req.params.id, 'project:updated', project);
      res.json(project);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Marca el proyecto como terminado/reabierto a mano — es la única señal real de que ya no van a
  // sumarse más tareas. Antes Pagos inferís esto de que todas las tareas estuvieran en "done", pero
  // eso se rompe apenas se agrega una tarea nueva a un proyecto que ya se había dado por terminado.
  router.patch('/api/projects/:id/status', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { status } = req.body;
      if (!['active', 'completed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
      const existing = await db('projects').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Proyecto no encontrado' });
      // Si el editor asignado es el dueño de la agencia, no hay "pago a editor" real — lo que
      // importa ahí es el cobro al cliente, no payment_amount (que se guarda en 0 a propósito). Por
      // email (OWNER_EMAIL), no por quién está logueado ahora: un segundo admin marcando esto en
      // nombre de otro editor no debería activar esta excepción.
      const editorForStatus = existing.payment_editor_id
        ? await db('users').where({ id: existing.payment_editor_id }).select('email').first()
        : null;
      const isSelfEditor = editorForStatus?.email === OWNER_EMAIL;
      const hasPrice = isSelfEditor ? Number(existing.client_amount) > 0 : Number(existing.payment_amount) > 0;
      if (status === 'completed' && (!existing.payment_editor_id || !hasPrice)) {
        return res.status(400).json({ error: 'Para marcar el proyecto como terminado necesita un editor asignado y un precio cargado' });
      }
      const update = { status };
      if (status === 'completed') update.ever_completed = true; // nunca se vuelve a poner en false
      await db('projects').where({ id: req.params.id }).update(update);
      const project = withDeletedEditorFallback(await db('projects as p').leftJoin('clients as c', 'p.client_id', 'c.id').leftJoin('users as eu', 'p.payment_editor_id', 'eu.id').where('p.id', req.params.id).select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color', 'eu.email as _editor_email').first());
      // Sin esto, editor_is_owner/computed_* faltaban en la respuesta de este endpoint en
      // particular (los demás sí lo aplicaban) — no rompía nada visible hoy porque Payments.jsx/
      // Dashboard.jsx recargan de /api/payments en vez de confiar en este payload, pero quedaba
      // como una inconsistencia latente esperando a que algo empezara a depender de ella.
      withComputedTotals(project);
      await emitToProject(req.params.id, 'project:updated', project);
      res.json(project);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Reordena los proyectos DENTRO de un mismo cliente (o sin cliente) — `order` ya viene acotado
  // a ese grupo desde el front, no hace falta el client_id acá para nada más que loguear/validar.
  router.patch('/api/projects/reorder', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { order } = req.body;
      if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) {
        return res.status(400).json({ error: 'order debe ser un array de ids' });
      }
      // N updates en paralelo (misma transacción) en vez de uno por uno esperando cada uno —
      // secuencial era N round-trips a la DB en fila por cada drag-and-drop, sin ninguna razón para
      // esperar a que termine el anterior antes de mandar el siguiente.
      await db.transaction(async trx => {
        await Promise.all(order.map((id, i) => trx('projects').where({ id }).update({ sort_order: i })));
      });
      io.to('admins').emit('projects:reordered', { order });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/projects/:id', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const projectId = req.params.id;

      const videos = await db('videos').where({ project_id: projectId });
      const videoIds = videos.map(v => v.id);
      const commentIds = videoIds.length ? await db('video_comments').whereIn('video_id', videoIds).pluck('id') : [];
      const replyIds = commentIds.length ? await db('comment_replies').whereIn('comment_id', commentIds).pluck('id') : [];
      const commentAttachments = commentIds.length ? await db('comment_attachments').whereIn('comment_id', commentIds) : [];
      const replyAttachments = replyIds.length ? await db('reply_attachments').whereIn('reply_id', replyIds) : [];

      // Emitir antes de borrar miembros/proyecto para que llegue a los destinatarios correctos.
      await emitToProject(projectId, 'project:deleted', { id: projectId });

      await db.transaction(async trx => {
        if (replyIds.length) await trx('reply_attachments').whereIn('reply_id', replyIds).delete();
        if (commentIds.length) await trx('comment_attachments').whereIn('comment_id', commentIds).delete();
        if (replyIds.length) await trx('comment_replies').whereIn('id', replyIds).delete();
        if (commentIds.length) await trx('video_comments').whereIn('id', commentIds).delete();
        await trx('videos').where({ project_id: projectId }).delete();
        await trx('tasks').where({ project_id: projectId }).delete();
        await trx('messages').where({ project_id: projectId }).delete();
        await trx('notifications').where({ project_id: projectId }).delete();
        await trx('project_members').where({ project_id: projectId }).delete();
        await trx('projects').where({ id: projectId }).delete();
      });

      // Recién con la DB consistente borramos los archivos físicos (best-effort).
      videos.forEach(v => safeUnlink(v.filename));
      commentAttachments.forEach(a => safeUnlink(a.filename));
      replyAttachments.forEach(a => safeUnlink(a.filename));

      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
