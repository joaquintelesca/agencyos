const express = require('express');

module.exports = function notificationsRoutes({ db, auth, io, parseReadBy }) {
  const router = express.Router();

  // El límite fijo de 50 sin forma de pedir más hacía que cualquier notificación más vieja fuera
  // directamente inalcanzable para siempre, aunque siguiera sin leer. offset/limit por query string,
  // con tope de 100 por página para no dejar pedir la tabla entera de una.
  router.get('/api/notifications', auth, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const notifs = await db('notifications as n')
        .leftJoin('users as a', 'n.actor_id', 'a.id')
        .leftJoin('projects as p', 'n.project_id', 'p.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('n.user_id', req.user.id)
        .select('n.*', 'a.avatar_color as actor_color', 'p.name as project_name',
          'c.id as client_id', 'c.name as client_name', 'c.color as client_color')
        .select(db.raw("COALESCE(a.name, n.guest_name, 'Cliente') as actor_name"))
        .orderBy('n.created_at', 'desc')
        .limit(limit)
        .offset(offset);
      res.json(notifs);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // El badge de la campanita (Layout.jsx) salía de contar sobre el mismo GET de arriba, que trae
  // como mucho 50 filas — con más de 50 notificaciones totales y alguna sin leer fuera de esa
  // ventana, el número quedaba mal. Este endpoint cuenta contra toda la tabla, sin el límite.
  router.get('/api/notifications/unread-count', auth, async (req, res) => {
    try {
      const [{ count }] = await db('notifications').where({ user_id: req.user.id, read: false }).count({ count: '*' });
      res.json({ count: Number(count) });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/notifications/read-all', auth, async (req, res) => {
    try {
      await db('notifications').where({ user_id: req.user.id }).update({ read: true });
      // Sin esto, marcar todo leído en una pestaña/dispositivo dejaba el número de la campanita
      // desactualizado (de más) en cualquier otra sesión abierta del mismo usuario hasta recargar.
      io.to(`user:${req.user.id}`).emit('notifications:read-all');
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/notifications/:id/read', auth, async (req, res) => {
    try {
      await db('notifications').where({ id: req.params.id, user_id: req.user.id }).update({ read: true });
      io.to(`user:${req.user.id}`).emit('notification:read', { id: req.params.id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Antes la única acción posible era marcar como leída — la lista solo podía crecer para siempre,
  // sin forma de sacar algo de encima. "Borrar leídas" es la limpieza rápida de todos los días;
  // borrar una puntual cubre el caso de "esto ya no me importa" aunque siga sin leer.
  router.delete('/api/notifications/read', auth, async (req, res) => {
    try {
      await db('notifications').where({ user_id: req.user.id, read: true }).delete();
      io.to(`user:${req.user.id}`).emit('notifications:cleared-read');
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/notifications/:id', auth, async (req, res) => {
    try {
      const deleted = await db('notifications').where({ id: req.params.id, user_id: req.user.id }).delete();
      if (!deleted) return res.status(404).json({ error: 'No encontrada' });
      io.to(`user:${req.user.id}`).emit('notification:deleted', { id: req.params.id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // GET unread counts for chat (per conversation)
  router.get('/api/chat/unread', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const counts = {};

      // DMs: solo mensajes dirigidos a este usuario, no enviados por él
      const dmMsgs = await db('chat_messages')
        .where({ type: 'dm', receiver_id: userId })
        .whereNot({ sender_id: userId })
        .select('id', 'sender_id', 'read_by');
      for (const m of dmMsgs) {
        const readBy = parseReadBy(m.read_by);
        if (!readBy.includes(userId)) {
          const key = `dm:${m.sender_id}`;
          counts[key] = (counts[key] || 0) + 1;
        }
      }

      // Canales: solo los canales donde es miembro
      const memberChannels = await db('chat_channel_members').where({ user_id: userId }).pluck('channel_id');
      if (memberChannels.length > 0) {
        const channelMsgs = await db('chat_messages')
          .where({ type: 'channel' })
          .whereIn('channel_id', memberChannels)
          .whereNot({ sender_id: userId })
          .select('id', 'channel_id', 'read_by');
        for (const m of channelMsgs) {
          const readBy = parseReadBy(m.read_by);
          if (!readBy.includes(userId)) {
            const key = `channel:${m.channel_id}`;
            counts[key] = (counts[key] || 0) + 1;
          }
        }
      }

      res.json(counts);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Mark messages as read
  router.post('/api/chat/read', auth, async (req, res) => {
    try {
      const { type, id } = req.body;
      const userId = req.user.id;
      // Antes traía TODOS los mensajes de la conversación completos (contenido, adjuntos, todo) para
      // fijarse read_by de cada uno, y actualizaba de a uno esperando cada query — en un canal con
      // historial largo, esto se ponía cada vez más lento con el tiempo aunque casi todo ya estuviera
      // leído. Se trae solo id+read_by, se filtra en memoria a los que de verdad faltan marcar (que
      // en un canal activo suelen ser pocos, no el historial entero), y esos se actualizan en paralelo.
      let msgs;
      if (type === 'dm') {
        msgs = await db('chat_messages').select('id', 'read_by').where({ type: 'dm', sender_id: id, receiver_id: userId }).orWhere({ type: 'dm', sender_id: userId, receiver_id: id });
      } else if (type === 'channel') {
        // Antes cualquier `type` distinto de 'dm' caía acá sin verificar nada, así que se podía
        // escribirse a sí mismo en el read_by de todos los mensajes de cualquier canal ajeno
        // (GET /api/chat/messages sí valida la membresía; esto no).
        if (req.user.role !== 'admin') {
          const isMember = await db('chat_channel_members').where({ channel_id: String(id), user_id: userId }).first();
          if (!isMember) return res.status(403).json({ error: 'No sos miembro de este canal' });
        }
        msgs = await db('chat_messages').select('id', 'read_by').where({ type: 'channel', channel_id: id });
      } else {
        return res.status(400).json({ error: 'Tipo de conversación inválido' });
      }
      const unread = msgs.filter(m => !parseReadBy(m.read_by).includes(userId));
      await Promise.all(unread.map(m => {
        const readBy = parseReadBy(m.read_by);
        readBy.push(userId);
        return db('chat_messages').where({ id: m.id }).update({ read_by: JSON.stringify(readBy) });
      }));
      io.to(`user:${userId}`).emit('chat:read', { type, id });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
