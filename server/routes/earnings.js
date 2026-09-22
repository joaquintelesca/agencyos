const express = require('express');

module.exports = function earningsRoutes({ db, auth, computeEditorAmount }) {
  const router = express.Router();

  router.get('/api/users/:id/detail', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const editorId = req.params.id;
      const editor = await db('users').where({ id: editorId }).select('id', 'name', 'email', 'role', 'avatar_color', 'created_at').first();
      if (!editor) return res.status(404).json({ error: 'Usuario no encontrado' });

      const tasks = await db('tasks as t')
        .join('projects as p', 't.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('t.assigned_to', editorId)
        .select('t.*', 'p.name as project_name', 'p.color as project_color', 'c.name as client_name');

      const projects = await db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('p.payment_editor_id', editorId)
        .select('p.id', 'p.name', 'p.color', 'p.editor_paid', 'p.client_paid', 'p.payment_amount', 'p.payment_type', 'p.payment_hours', 'c.name as client_name');

      res.json({ editor, tasks, projects });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Ganancias propias: a diferencia de /api/projects (que le esconde al editor los campos de
  // plata vía stripProjectFinancials, una lista NEGRA), acá se arma la respuesta con una lista
  // BLANCA explícita — solo el lado del editor, nunca client_amount/client_paid/upwork_*/
  // computed_client_*. Una lista blanca no se olvida de tapar un campo nuevo el día de mañana;
  // una lista negra sí. Cualquier rol puede pedir la suya propia (payment_editor_id = uno mismo),
  // no hay chequeo de admin porque el filtro ya es sobre el usuario que pide.
  router.get('/api/me/earnings', auth, async (req, res) => {
    try {
      const projects = await db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('p.payment_editor_id', req.user.id)
        // Mismo criterio que Pagos: solo trabajo dado por terminado en algún momento, no cualquier
        // proyecto activo asignado (ahí todavía no hay nada "cobrable", es trabajo en curso).
        .where(function() { this.where('p.status', 'completed').orWhere('p.ever_completed', true); })
        .select(
          'p.id', 'p.name', 'p.color', 'c.name as client_name',
          'p.payment_type', 'p.payment_amount', 'p.payment_hours',
          'p.editor_paid', 'p.editor_paid_at', 'p.editor_paid_amount'
        )
        .orderBy('p.created_at', 'desc');
      projects.forEach(p => {
        p.computed_editor_total = p.editor_paid === 'paid' && p.editor_paid_amount != null
          ? Number(p.editor_paid_amount)
          : computeEditorAmount(p);
      });
      res.json(projects);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
