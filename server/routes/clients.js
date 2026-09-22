const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function clientsRoutes({ db, auth, io }) {
  const router = express.Router();

  // Un editor solo debe ver los clientes de los proyectos donde es miembro, no el listado completo
  // de clientes de la agencia (nombre, email, teléfono, notas internas son datos de negocio sensibles).
  router.get('/api/clients', auth, async (req, res) => {
    try {
      let query = db('clients').orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'name', order: 'asc' }]);
      if (req.user.role !== 'admin') {
        const clientIds = await db('project_members as pm')
          .join('projects as p', 'pm.project_id', 'p.id')
          .where('pm.user_id', req.user.id)
          .whereNotNull('p.client_id')
          .pluck('p.client_id');
        query = query.whereIn('id', [...new Set(clientIds)]);
      }
      const clients = await query;
      res.json(clients);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/clients', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { name, color, email, phone, notes } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
      const id = uuidv4();
      await db('clients').insert({ id, name, color: color || '#6366f1', email: email || null, phone: phone || null, notes: notes || null });
      const client = await db('clients').where({ id }).first();
      io.to('admins').emit('client:created', client);
      res.json(client);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Nota: tiene que ir ANTES de /api/clients/:id — si no, Express matchea "reorder" como :id.
  router.patch('/api/clients/reorder', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { order } = req.body;
      if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) {
        return res.status(400).json({ error: 'order debe ser un array de ids' });
      }
      // Mismo criterio que /api/projects/reorder: N updates en paralelo en vez de secuenciales.
      await db.transaction(async trx => {
        await Promise.all(order.map((id, i) => trx('clients').where({ id }).update({ sort_order: i })));
      });
      io.to('admins').emit('clients:reordered', { order });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/clients/:id', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { name, color, email, phone, notes } = req.body;
      if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
      await db('clients').where({ id: req.params.id }).update({ name, color, email, phone, notes });
      const client = await db('clients').where({ id: req.params.id }).first();
      io.to('admins').emit('client:updated', client);
      res.json(client);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/clients/:id', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      await db.transaction(async trx => {
        await trx('projects').where({ client_id: req.params.id }).update({ client_id: null });
        await trx('chat_messages').where({ client_id: req.params.id }).update({ client_id: null });
        await trx('clients').where({ id: req.params.id }).delete();
      });
      io.to('admins').emit('client:deleted', { id: req.params.id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
