const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function authRoutes({ db, auth, loginLimiter, bcrypt, jwt, JWT_SECRET, pickUnusedAvatarColor, safeUnlink }) {
  const router = express.Router();

  router.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await db('users').where({ email }).first();
      if (!user || !bcrypt.compareSync(password, user.password))
        return res.status(401).json({ error: 'Credenciales inválidas' });
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar_color: user.avatar_color } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/auth/register', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const { name, email, password, role } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
      if (!email?.trim()) return res.status(400).json({ error: 'El email es obligatorio' });
      if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const exists = await db('users').where({ email }).first();
      if (exists) return res.status(400).json({ error: 'Email ya registrado' });
      const hash = bcrypt.hashSync(password, 10);
      const usedColors = new Set((await db('users').select('avatar_color')).map(u => u.avatar_color));
      const color = pickUnusedAvatarColor(usedColors);
      await db('users').insert({ id: uuidv4(), name, email, password: hash, role: role || 'editor', avatar_color: color });
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // GET /api/users — admins ven todo, editores solo ven admins + sí mismos (privacidad entre editores).
  router.get('/api/users', auth, async (req, res) => {
    try {
      if (req.user.role === 'admin') {
        const users = await db('users').select('id','name','email','role','avatar_color','created_at');
        return res.json(users);
      }
      const users = await db('users')
        .where(function() { this.where({ role: 'admin' }).orWhere({ id: req.user.id }); })
        .select('id','name','email','role','avatar_color','created_at');
      res.json(users);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/api/users/:id', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const uid = req.params.id;
      const target = await db('users').where({ id: uid }).first();
      if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

      // Comentarios/respuestas: hay que limpiar en ambas direcciones — lo que el usuario escribió,
      // y lo que otros escribieron respondiendo a sus comentarios (quedarían huérfanos si no).
      const ownCommentIds = await db('video_comments').where({ user_id: uid }).pluck('id');
      const ownReplyIds = await db('comment_replies').where({ user_id: uid }).pluck('id');
      const repliesToOwnComments = ownCommentIds.length
        ? await db('comment_replies').whereIn('comment_id', ownCommentIds).pluck('id')
        : [];
      const replyIdsToClean = [...new Set([...ownReplyIds, ...repliesToOwnComments])];
      const commentAttachments = ownCommentIds.length ? await db('comment_attachments').whereIn('comment_id', ownCommentIds) : [];
      const replyAttachments = replyIdsToClean.length ? await db('reply_attachments').whereIn('reply_id', replyIdsToClean) : [];

      // El chequeo de "último admin" y el borrado quedan en la misma transacción: bajo concurrencia,
      // dos requests que demoran/borran a los dos únicos admins ya no pueden colarse ambos a la vez.
      let blocked = false;
      await db.transaction(async trx => {
        if (target.role === 'admin') {
          const adminCount = await trx('users').where({ role: 'admin' }).count('id as c').first();
          if (Number(adminCount.c) <= 1) { blocked = true; return; }
        }
        await trx('notifications').where({ user_id: uid }).orWhere({ actor_id: uid }).delete();
        await trx('messages').where({ sender_id: uid }).delete();
        await trx('chat_messages').where({ sender_id: uid }).orWhere({ receiver_id: uid }).delete();
        await trx('chat_channel_members').where({ user_id: uid }).delete();
        await trx('project_members').where({ user_id: uid }).delete();
        await trx('tasks').where({ assigned_to: uid }).update({ assigned_to: null });
        if (replyIdsToClean.length) {
          await trx('reply_attachments').whereIn('reply_id', replyIdsToClean).delete();
          await trx('comment_replies').whereIn('id', replyIdsToClean).delete();
        }
        if (ownCommentIds.length) {
          await trx('comment_attachments').whereIn('comment_id', ownCommentIds).delete();
          await trx('video_comments').whereIn('id', ownCommentIds).delete();
        }
        await trx('users').where({ id: uid }).delete();
      });

      if (blocked) return res.status(400).json({ error: 'No se puede eliminar el último administrador' });

      commentAttachments.forEach(a => safeUnlink(a.filename));
      replyAttachments.forEach(a => safeUnlink(a.filename));
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // PATCH /api/users/:id — editar usuario (admin, o el propio usuario)
  router.patch('/api/users/:id', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'Sin acceso' });
      }
      const { name, email, role, avatar_color, password, current_password } = req.body;
      const updateData = {};
      if (name) updateData.name = name;
      if (email) {
        const existing = await db('users').where({ email }).whereNot({ id: req.params.id }).first();
        if (existing) return res.status(400).json({ error: 'Email ya en uso por otro usuario' });
        updateData.email = email;
      }
      let checkLastAdminOnDemote = false;
      if (role && req.user.role === 'admin') {
        const target = await db('users').where({ id: req.params.id }).first();
        if (target?.role === 'admin' && role !== 'admin') checkLastAdminOnDemote = true;
        updateData.role = role;
      }
      if (avatar_color) updateData.avatar_color = avatar_color;
      if (password) {
        if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        if (req.user.id === req.params.id) {
          const target = await db('users').where({ id: req.params.id }).first();
          if (!current_password || !bcrypt.compareSync(current_password, target.password)) {
            return res.status(400).json({ error: 'Contraseña actual incorrecta' });
          }
        }
        updateData.password = bcrypt.hashSync(password, 10);
      }
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }
      // El chequeo de "último admin" y el update quedan en la misma transacción (ver DELETE /api/users/:id).
      let blocked = false;
      await db.transaction(async trx => {
        if (checkLastAdminOnDemote) {
          const adminCount = await trx('users').where({ role: 'admin' }).count('id as c').first();
          if (Number(adminCount.c) <= 1) { blocked = true; return; }
        }
        await trx('users').where({ id: req.params.id }).update(updateData);
      });
      if (blocked) return res.status(400).json({ error: 'No se puede cambiar el rol del último administrador' });
      const updated = await db('users').where({ id: req.params.id }).select('id', 'name', 'email', 'role', 'avatar_color', 'created_at').first();
      res.json(updated);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
