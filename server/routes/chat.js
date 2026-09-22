const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function chatRoutes({ db, auth, io, uploadLimiter, attachmentUpload, verifyAndPersistFiles, SAFE_ATTACHMENT_MIME_EXT }) {
  const router = express.Router();

  router.get('/api/chat/dm-tabs', auth, async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId requerido' });
      // "Notas" del admin (DM con uno mismo) es su bloc de notas de TODO lo que gestiona, no solo
      // los clientes de proyectos donde figura como project_member — a diferencia de un DM con un
      // editor, donde sí tiene sentido filtrar a los clientes en los que ese editor participa.
      // Se arma en vivo desde la tabla de clientes: agregar/borrar un cliente ya queda reflejado
      // la próxima vez que se abre esta conversación, sin necesidad de nada adicional.
      if (userId === req.user.id && req.user.role === 'admin') {
        const clients = await db('clients').select('id', 'name', 'color').orderBy('name', 'asc');
        return res.json(clients);
      }
      const otherUser = await db('users').where({ id: userId }).first();
      if (!otherUser) return res.status(404).json({ error: 'Usuario no encontrado' });
      const editorId = req.user.role === 'admin' ? userId : req.user.id;
      const clients = await db('project_members as pm')
        .join('projects as p', 'pm.project_id', 'p.id')
        .join('clients as c', 'p.client_id', 'c.id')
        .where('pm.user_id', editorId)
        .whereNotNull('p.client_id')
        .select('c.id', 'c.name', 'c.color')
        .groupBy('c.id', 'c.name', 'c.color')
        .orderBy('c.name', 'asc');
      res.json(clients);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // GET conversations list for current user
  router.get('/api/chat/conversations', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const isAdmin = req.user.role === 'admin';

      // Antes: una query de "último mensaje" POR usuario listado, y otra de "cantidad de
      // miembros" POR canal — con varios editores/canales eran decenas de round-trips en cada
      // apertura del chat. Ahora se trae todo en queries batched y se arma en memoria.
      const otherUsers = isAdmin
        ? await db('users').where('id', '!=', userId).select('id', 'name', 'avatar_color')
        : await db('users').where({ role: 'admin' }).select('id', 'name', 'avatar_color');

      // "Notas": DM del usuario consigo mismo, usado como bloc de notas personal.
      // Se pisa antes de armar `dms` para que quede siempre primero en la lista.
      const me = await db('users').where({ id: userId }).select('id', 'name', 'avatar_color').first();
      const dmUsers = me ? [{ ...me, is_self: true }, ...otherUsers] : otherUsers;

      // Un LIMIT global sobre todos los DMs mezclados perdía el último mensaje de contactos
      // poco activos (quedaban fuera de la ventana si otras conversaciones eran más recientes).
      // ROW_NUMBER() por contraparte trae el último mensaje real de cada uno en una sola query.
      const myDmsRows = await db.raw(`
        SELECT sender_id, receiver_id, content, file_type, created_at FROM (
          SELECT sender_id, receiver_id, content, file_type, created_at,
            ROW_NUMBER() OVER (
              PARTITION BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
              ORDER BY created_at DESC
            ) as rn
          FROM chat_messages
          WHERE type = 'dm' AND (sender_id = ? OR receiver_id = ?)
        ) t WHERE rn = 1
      `, [userId, userId, userId]);
      const myDms = myDmsRows.rows || myDmsRows;
      const lastByOther = {};
      for (const m of myDms) {
        const otherId = m.sender_id === userId ? m.receiver_id : m.sender_id;
        lastByOther[otherId] = m;
      }
      const dms = dmUsers.map(u => {
        const last = lastByOther[u.id];
        return {
          id: u.id,
          name: u.is_self ? 'Notas' : u.name,
          color: u.avatar_color,
          last_message: last?.content || (last?.file_type ? '📎 Archivo' : null),
          unread: 0,
          is_self: !!u.is_self
        };
      });

      let channels = [];
      if (isAdmin) {
        const allChannels = await db('chat_channels').orderBy('created_at', 'asc');
        const memberCounts = allChannels.length
          ? await db('chat_channel_members').whereIn('channel_id', allChannels.map(c => c.id))
              .select('channel_id').count('user_id as count').groupBy('channel_id')
          : [];
        const countByChannel = {};
        for (const row of memberCounts) countByChannel[row.channel_id] = Number(row.count);
        channels = allChannels.map(c => ({ ...c, member_count: countByChannel[c.id] || 0 }));
      } else {
        const memberOf = await db('chat_channel_members').where({ user_id: userId }).pluck('channel_id');
        if (memberOf.length > 0) {
          channels = await db('chat_channels').whereIn('id', memberOf).orderBy('created_at', 'asc');
        }
      }

      res.json({ dms, channels });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // GET messages for a DM or channel (paginado: devuelve los más recientes primero).
  // ?before=<id> para cargar mensajes anteriores.
  router.get('/api/chat/messages', auth, async (req, res) => {
    try {
      const { type, id, before, client_id } = req.query;
      const userId = req.user.id;
      const PAGE_SIZE = 50;

      let query;
      if (type === 'dm') {
        query = db('chat_messages as m')
          .join('users as u', 'm.sender_id', 'u.id')
          .where('m.type', 'dm')
          .where(function() { this.where({ sender_id: userId, receiver_id: id }).orWhere({ sender_id: id, receiver_id: userId }); })
          .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color');
        if (client_id) {
          query = query.where('m.client_id', client_id);
        } else {
          query = query.whereNull('m.client_id');
        }
      } else if (type === 'channel') {
        if (req.user.role !== 'admin') {
          const isMember = await db('chat_channel_members').where({ channel_id: id, user_id: userId }).first();
          if (!isMember) return res.status(403).json({ error: 'Sin acceso' });
        }
        query = db('chat_messages as m')
          .join('users as u', 'm.sender_id', 'u.id')
          .where({ 'm.type': 'channel', 'm.channel_id': id })
          .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color');
      } else {
        return res.json([]);
      }

      if (before) {
        const ref = await db('chat_messages').where({ id: before }).first();
        if (ref) query = query.where('m.created_at', '<', ref.created_at);
      }

      const msgs = await query.orderBy('m.created_at', 'desc').limit(PAGE_SIZE);
      res.json(msgs.reverse());
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // POST send a message
  router.post('/api/chat/messages', auth, async (req, res) => {
    try {
      const { type, receiver_id, channel_id, content, file_url, file_type, file_name, client_id, file_duration } = req.body;
      const senderId = req.user.id;

      if (req.user.role !== 'admin' && type === 'dm' && receiver_id !== senderId) {
        const targetUser = await db('users').where({ id: receiver_id }).first();
        if (!targetUser || targetUser.role !== 'admin') {
          return res.status(403).json({ error: 'Los editores solo pueden chatear con admins' });
        }
      }
      if (req.user.role !== 'admin' && type === 'channel') {
        if (!channel_id) return res.status(400).json({ error: 'Canal no especificado' });
        const isMember = await db('chat_channel_members').where({ channel_id: String(channel_id), user_id: senderId }).first();
        if (!isMember) return res.status(403).json({ error: 'No sos miembro de este canal' });
      }

      if (!content?.trim() && !file_url) {
        return res.status(400).json({ error: 'Mensaje vacío' });
      }

      // file_url solo puede ser una ruta interna de /uploads (la forma exacta que devuelve
      // /api/chat/upload). Si se acepta cualquier string, un editor puede mandar una URL externa:
      // el cliente la renderiza como <a href> / window.open pasándola por mediaUrl(), que le pega
      // el token de sesión de quien la abra — un admin haciendo clic filtraría su JWT completo a
      // un servidor ajeno.
      if (file_url) {
        if (typeof file_url !== 'string' || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(file_url)) {
          return res.status(400).json({ error: 'Archivo inválido' });
        }
        if (!['image', 'video', 'audio', 'file'].includes(file_type)) {
          return res.status(400).json({ error: 'Tipo de archivo inválido' });
        }
      }

      const id = uuidv4();
      await db('chat_messages').insert({ id, sender_id: senderId, receiver_id: receiver_id || null, channel_id: channel_id || null, type, content: content || '', file_url: file_url || null, file_type: file_type || null, file_name: file_name || null, client_id: (type === 'dm' && client_id) ? client_id : null, file_duration: file_duration || null });
      const msg = await db('chat_messages as m').join('users as u', 'm.sender_id', 'u.id').where('m.id', id).select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color').first();
      // Los mensajes de chat ya tienen su propio contador de no leídos (chat_messages.read_by,
      // vía /api/chat/unread) que alimenta la burbuja del ítem "Chat" del sidebar — no se crea
      // una notificación general acá para no duplicar el aviso en la campanita/Notificaciones.
      if (type === 'dm' && receiver_id) {
        io.to(`user:${senderId}`).to(`user:${receiver_id}`).emit('chat:message', msg);
      } else if (type === 'channel' && channel_id) {
        const members = await db('chat_channel_members').where({ channel_id }).pluck('user_id');
        for (const uid of members) {
          io.to(`user:${uid}`).emit('chat:message', msg);
        }
      }
      res.json(msg);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // POST upload file for chat — reusa el whitelist compartido de adjuntos seguros.
  router.post('/api/chat/upload', auth, uploadLimiter, (req, res) => {
    attachmentUpload.single('file')(req, res, async (err) => {
      if (err && err.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ error: 'Tipo de archivo no permitido. Se aceptan imágenes, videos, audios, PDFs y texto.' });
      }
      if (err && err.message === 'STORAGE_FULL') {
        return res.status(507).json({ error: 'No hay espacio de almacenamiento disponible. Contactá al administrador.' });
      }
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Archivo demasiado grande (máx. 3GB)' });
        }
        return res.status(400).json({ error: err.message || 'Error al subir archivo' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No se recibió ningún archivo' });
      }
      if (!await verifyAndPersistFiles([req.file], SAFE_ATTACHMENT_MIME_EXT)) {
        return res.status(400).json({ error: 'El contenido del archivo no coincide con el tipo de archivo declarado.' });
      }
      res.json({
        url: `/uploads/${req.file.filename}`,
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      });
    });
  });

  // POST create channel (admin only)
  router.post('/api/chat/channels', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { name, members } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'El nombre del canal es obligatorio' });

      const id = uuidv4();
      await db('chat_channels').insert({ id, name: name.trim(), created_by: req.user.id });

      // Always add admin
      await db('chat_channel_members').insert({ channel_id: id, user_id: req.user.id });

      // Validar que los ids realmente existan antes de insertarlos — sin esto, un id inventado o de
      // un usuario ya borrado queda como fila huérfana en chat_channel_members y rompe el join de
      // /api/chat/conversations más adelante.
      let validMemberCount = 0;
      if (members?.length) {
        const otherMembers = members.filter(uid => uid !== req.user.id);
        if (otherMembers.length > 0) {
          const validIds = await db('users').whereIn('id', otherMembers).pluck('id');
          if (validIds.length > 0) {
            await db('chat_channel_members').insert(validIds.map(uid => ({ channel_id: id, user_id: uid })));
          }
          validMemberCount = validIds.length;
        }
      }

      res.json({ id, name: name.trim(), member_count: validMemberCount + 1, created_by: req.user.id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
