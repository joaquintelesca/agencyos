const express = require('express');

module.exports = function messagesRoutes({ db, auth, requireProjectAccess }) {
  const router = express.Router();

  router.get('/api/projects/:projectId/messages', auth, requireProjectAccess(), async (req, res) => {
    try {
      const { before } = req.query;
      let query = db('messages as m').join('users as u', 'm.sender_id', 'u.id')
        .where({ 'project_id': req.params.projectId, 'type': 'project' })
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color');
      if (before) {
        const ref = await db('messages').where({ id: before }).first();
        if (ref) query = query.where('m.created_at', '<', ref.created_at);
      }
      const messages = await query.orderBy('m.created_at', 'desc').limit(50);
      res.json(messages.reverse());
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
