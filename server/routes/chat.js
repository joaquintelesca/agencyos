const express = require('express');
const { v4: uuidv4 } = require('uuid');

// Mismo set que QUICK_REACTIONS en client/src/pages/Chat.jsx — no vía picker libre (a propósito,
// el pedido fue "solo algunos emojis"), así que el servidor rechaza cualquier otro valor.
const QUICK_REACTIONS = ['👍', '👀', '✅', '🙌', '❤️', '🎉', '🔥', '😂'];

module.exports = function chatRoutes({ db, auth, io, uploadLimiter, attachmentUpload, verifyAndPersistFiles, SAFE_ATTACHMENT_MIME_EXT }) {
  const router = express.Router();

  // Mismo criterio que ver el mensaje: participante del DM, o miembro del canal (o admin). Usado
  // por reaccionar, guardar, citar y fijar — cualquier acción que toque un mensaje puntual por id.
  async function canAccessMessage(user, message) {
    if (message.type === 'dm') {
      return user.role === 'admin' || user.id === message.sender_id || user.id === message.receiver_id;
    }
    if (message.type === 'channel') {
      if (user.role === 'admin') return true;
      const isMember = await db('chat_channel_members').where({ channel_id: message.channel_id, user_id: user.id }).first();
      return !!isMember;
    }
    return false;
  }

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

      // Para el bloque de cita (ver "Citar" en el toolbar) — se arma acá con un join en vez de una
      // query aparte por mensaje citado, mismo criterio que sender_name.
      const quoteJoins = (q) => q
        .leftJoin('chat_messages as qm', 'm.quoted_message_id', 'qm.id')
        .leftJoin('users as qu', 'qm.sender_id', 'qu.id');
      const quoteCols = ['qm.content as quoted_content', 'qm.file_type as quoted_file_type', 'qu.name as quoted_sender_name'];

      let query;
      if (type === 'dm') {
        query = quoteJoins(db('chat_messages as m')
          .join('users as u', 'm.sender_id', 'u.id'))
          .where('m.type', 'dm')
          .where(function() { this.where({ 'm.sender_id': userId, 'm.receiver_id': id }).orWhere({ 'm.sender_id': id, 'm.receiver_id': userId }); })
          .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color', ...quoteCols);
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
        query = quoteJoins(db('chat_messages as m')
          .join('users as u', 'm.sender_id', 'u.id'))
          .where({ 'm.type': 'channel', 'm.channel_id': id })
          .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color', ...quoteCols);
      } else {
        return res.json([]);
      }

      if (before) {
        const ref = await db('chat_messages').where({ id: before }).first();
        if (ref) query = query.where('m.created_at', '<', ref.created_at);
      }

      const msgs = await query.orderBy('m.created_at', 'desc').limit(PAGE_SIZE);
      const ordered = msgs.reverse();

      // Reacciones batcheadas en una sola query (por message_id) en vez de una por mensaje —
      // mismo criterio que los adjuntos/respuestas de comentarios de video.
      const messageIds = ordered.map(m => m.id);
      const reactionRows = messageIds.length
        ? await db('chat_reactions as r')
            .join('users as u', 'r.user_id', 'u.id')
            .whereIn('r.message_id', messageIds)
            .select('r.message_id', 'r.emoji', 'r.user_id', 'u.name as user_name')
        : [];
      const reactionsByMessage = {};
      for (const row of reactionRows) {
        const byEmoji = (reactionsByMessage[row.message_id] ??= {});
        (byEmoji[row.emoji] ??= { emoji: row.emoji, users: [] }).users.push({ id: row.user_id, name: row.user_name });
      }
      // Guardados: solo importa si LOS GUARDÉ YO (no es un dato visible para otros, a diferencia
      // de las reacciones), así que alcanza con un Set de ids, filtrado por user_id.
      const savedIds = messageIds.length
        ? new Set(await db('chat_saved_messages').where('user_id', userId).whereIn('message_id', messageIds).pluck('message_id'))
        : new Set();
      // Fijados: a diferencia de guardados, es compartido (visible para todos en la conversación),
      // así que sin filtro de user_id.
      const pinnedIds = messageIds.length
        ? new Set(await db('chat_pinned_messages').whereIn('message_id', messageIds).pluck('message_id'))
        : new Set();
      const withReactions = ordered.map(m => ({
        ...m,
        reactions: Object.values(reactionsByMessage[m.id] || {}).map(r => ({ ...r, count: r.users.length })),
        saved_by_me: savedIds.has(m.id),
        pinned: pinnedIds.has(m.id),
      }));
      res.json(withReactions);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // POST toggle a reaction on a message — mismo emoji + mismo usuario un segundo click la saca
  // (comportamiento Slack), no la duplica ni la reemplaza por otra.
  router.post('/api/chat/messages/:id/react', auth, async (req, res) => {
    try {
      const { emoji } = req.body;
      if (!QUICK_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Emoji no permitido' });
      const message = await db('chat_messages').where({ id: req.params.id }).first();
      if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });

      if (!await canAccessMessage(req.user, message)) return res.status(403).json({ error: 'Sin acceso' });

      const existing = await db('chat_reactions').where({ message_id: req.params.id, user_id: req.user.id, emoji }).first();
      let action;
      if (existing) {
        await db('chat_reactions').where({ id: existing.id }).delete();
        action = 'remove';
      } else {
        await db('chat_reactions').insert({ id: uuidv4(), message_id: req.params.id, user_id: req.user.id, emoji });
        action = 'add';
      }

      const actor = await db('users').where({ id: req.user.id }).select('name').first();
      const payload = { messageId: req.params.id, emoji, userId: req.user.id, userName: actor?.name, action };
      if (message.type === 'dm') {
        io.to(`user:${message.sender_id}`).to(`user:${message.receiver_id}`).emit('chat:reaction', payload);
      } else if (message.type === 'channel') {
        const members = await db('chat_channel_members').where({ channel_id: message.channel_id }).pluck('user_id');
        for (const uid of members) io.to(`user:${uid}`).emit('chat:reaction', payload);
      }
      res.json({ success: true, action });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Toggle guardar/quitar un mensaje — privado por usuario (no se avisa por socket a nadie más,
  // a diferencia de reaccionar, que sí es visible para el resto de la conversación).
  router.post('/api/chat/messages/:id/save', auth, async (req, res) => {
    try {
      const message = await db('chat_messages').where({ id: req.params.id }).first();
      if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
      if (!await canAccessMessage(req.user, message)) return res.status(403).json({ error: 'Sin acceso' });

      const existing = await db('chat_saved_messages').where({ message_id: req.params.id, user_id: req.user.id }).first();
      if (existing) {
        await db('chat_saved_messages').where({ id: existing.id }).delete();
        return res.json({ saved: false });
      }
      await db('chat_saved_messages').insert({ id: uuidv4(), message_id: req.params.id, user_id: req.user.id });
      res.json({ saved: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Lista de mensajes guardados por el usuario actual, de cualquier conversación — mismo shape
  // de columnas (sender_name/receiver_name/channel_name/client_id) que la búsqueda global en
  // search.js, para poder armar el link "ir al mensaje" con la misma lógica en el cliente.
  router.get('/api/chat/saved', auth, async (req, res) => {
    try {
      const rows = await db('chat_saved_messages as s')
        .join('chat_messages as m', 's.message_id', 'm.id')
        .join('users as u', 'm.sender_id', 'u.id')
        .leftJoin('users as ru', 'm.receiver_id', 'ru.id')
        .leftJoin('chat_channels as ch', 'm.channel_id', 'ch.id')
        .where('s.user_id', req.user.id)
        .select('m.id', 'm.content', 'm.type', 'm.sender_id', 'm.receiver_id', 'm.channel_id', 'm.client_id',
          'm.created_at', 'm.file_type', 'u.name as sender_name', 'ru.name as receiver_name', 'ch.name as channel_name',
          's.created_at as saved_at')
        .orderBy('s.created_at', 'desc');
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Toggle fijar/desfijar — a diferencia de guardar, SÍ se avisa por socket (es visible para
  // toda la conversación, no privado) y el toggle es sobre el mensaje en sí, no por usuario.
  router.post('/api/chat/messages/:id/pin', auth, async (req, res) => {
    try {
      const message = await db('chat_messages').where({ id: req.params.id }).first();
      if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' });
      if (!await canAccessMessage(req.user, message)) return res.status(403).json({ error: 'Sin acceso' });

      const existing = await db('chat_pinned_messages').where({ message_id: req.params.id }).first();
      let pinned;
      if (existing) {
        await db('chat_pinned_messages').where({ id: existing.id }).delete();
        pinned = false;
      } else {
        await db('chat_pinned_messages').insert({ id: uuidv4(), message_id: req.params.id, pinned_by: req.user.id });
        pinned = true;
      }

      const payload = { messageId: req.params.id, pinned };
      if (message.type === 'dm') {
        io.to(`user:${message.sender_id}`).to(`user:${message.receiver_id}`).emit('chat:pin', payload);
      } else if (message.type === 'channel') {
        const members = await db('chat_channel_members').where({ channel_id: message.channel_id }).pluck('user_id');
        for (const uid of members) io.to(`user:${uid}`).emit('chat:pin', payload);
      }
      res.json({ pinned });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Lista de fijados de UNA conversación puntual (no "todos los que fijé yo" como /saved, porque
  // fijar es compartido por conversación) — mismo filtro de acceso/client_id que /api/chat/messages.
  router.get('/api/chat/messages/pinned', auth, async (req, res) => {
    try {
      const { type, id, client_id } = req.query;
      const userId = req.user.id;
      let query = db('chat_pinned_messages as p')
        .join('chat_messages as m', 'p.message_id', 'm.id')
        .join('users as u', 'm.sender_id', 'u.id')
        .select('m.id', 'm.content', 'm.type', 'm.file_type', 'm.created_at', 'u.name as sender_name', 'p.created_at as pinned_at');

      if (type === 'dm') {
        query = query.where('m.type', 'dm')
          .where(function() { this.where({ 'm.sender_id': userId, 'm.receiver_id': id }).orWhere({ 'm.sender_id': id, 'm.receiver_id': userId }); });
        query = client_id ? query.where('m.client_id', client_id) : query.whereNull('m.client_id');
      } else if (type === 'channel') {
        if (req.user.role !== 'admin') {
          const isMember = await db('chat_channel_members').where({ channel_id: id, user_id: userId }).first();
          if (!isMember) return res.status(403).json({ error: 'Sin acceso' });
        }
        query = query.where({ 'm.type': 'channel', 'm.channel_id': id });
      } else {
        return res.json([]);
      }

      res.json(await query.orderBy('p.created_at', 'desc'));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // POST send a message
  router.post('/api/chat/messages', auth, async (req, res) => {
    try {
      const { type, receiver_id, channel_id, content, file_url, file_type, file_name, client_id, file_duration, quoted_message_id } = req.body;
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

      // Citar un mensaje de otra conversación (uno que no podés ver) filtraría su contenido hacia
      // acá — mismo chequeo de acceso que reaccionar/guardar, no solo "existe".
      let quotedId = null;
      if (quoted_message_id) {
        const quotedMsg = await db('chat_messages').where({ id: quoted_message_id }).first();
        if (quotedMsg && await canAccessMessage(req.user, quotedMsg)) quotedId = quoted_message_id;
      }

      const id = uuidv4();
      await db('chat_messages').insert({ id, sender_id: senderId, receiver_id: receiver_id || null, channel_id: channel_id || null, type, content: content || '', file_url: file_url || null, file_type: file_type || null, file_name: file_name || null, client_id: (type === 'dm' && client_id) ? client_id : null, file_duration: file_duration || null, quoted_message_id: quotedId });
      const msg = await db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .leftJoin('chat_messages as qm', 'm.quoted_message_id', 'qm.id')
        .leftJoin('users as qu', 'qm.sender_id', 'qu.id')
        .where('m.id', id)
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color',
          'qm.content as quoted_content', 'qm.file_type as quoted_file_type', 'qu.name as quoted_sender_name')
        .first();
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

  // Reenviar: copia el contenido del mensaje ORIGINAL leído del servidor (no lo que mande el
  // cliente en el body) — así lo que se reenvía es exactamente lo que esa persona tenía permiso
  // de ver, no algo que podría falsificar mandando otro content/file_url en el POST. quoted_message_id
  // apunta al original (mismo mecanismo que "Citar"); `forwarded: true` es la única diferencia,
  // para que el cliente muestre "Reenviado de X" en vez de "Citando a X".
  router.post('/api/chat/messages/:id/forward', auth, async (req, res) => {
    try {
      const { type, receiver_id, channel_id, client_id } = req.body;
      const senderId = req.user.id;

      const original = await db('chat_messages').where({ id: req.params.id }).first();
      if (!original) return res.status(404).json({ error: 'Mensaje no encontrado' });
      if (!await canAccessMessage(req.user, original)) return res.status(403).json({ error: 'Sin acceso al mensaje original' });

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

      const id = uuidv4();
      await db('chat_messages').insert({
        id, sender_id: senderId, receiver_id: receiver_id || null, channel_id: channel_id || null, type,
        content: original.content || '', file_url: original.file_url || null, file_type: original.file_type || null,
        file_name: original.file_name || null, file_duration: original.file_duration || null,
        client_id: (type === 'dm' && client_id) ? client_id : null,
        quoted_message_id: original.id, forwarded: true,
      });
      const msg = await db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .leftJoin('chat_messages as qm', 'm.quoted_message_id', 'qm.id')
        .leftJoin('users as qu', 'qm.sender_id', 'qu.id')
        .where('m.id', id)
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color',
          'qm.content as quoted_content', 'qm.file_type as quoted_file_type', 'qu.name as quoted_sender_name')
        .first();
      if (type === 'dm' && receiver_id) {
        io.to(`user:${senderId}`).to(`user:${receiver_id}`).emit('chat:message', msg);
      } else if (type === 'channel' && channel_id) {
        const members = await db('chat_channel_members').where({ channel_id }).pluck('user_id');
        for (const uid of members) io.to(`user:${uid}`).emit('chat:message', msg);
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
