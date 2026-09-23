// Hasta esta migración, ninguna tabla tenía una relación real declarada en la base — cada
// columna tipo "project_id"/"user_id" era un simple varchar que casualmente guardaba el id de
// otra fila, y toda la limpieza al borrar (proyecto → tareas/videos/comentarios, usuario → sus
// tareas/comentarios/reacciones, etc.) la hacía el código a mano en cada endpoint. Eso funciona
// mientras nadie se olvide un caso — y de hecho varios ya quedaron sueltos con el tiempo (ver la
// sección de "huérfanos" abajo). Esta migración agrega las FK reales, con el mismo comportamiento
// que el código ya implementa donde existe, y CASCADE/SET NULL razonable donde no existía ninguno.
//
// Excepción deliberada: projects.payment_editor_id NO se restringe acá. El código actual
// (withDeletedEditorFallback en server/lib/project-access.js) depende explícitamente de que ese
// id pueda seguir apuntando a un usuario ya borrado — es la única forma de no perder el historial
// de a quién se le pagó un proyecto. Una FK real ahí forzaría a elegir entre bloquear el borrado
// del usuario (cambia el comportamiento actual de DELETE /api/users/:id) o vaciar el campo
// (rompe ese fallback y pierde el historial) — ninguna de las dos es "agregar una FK" sin más,
// así que se deja sin restricción, documentado acá en vez de en el aire.
exports.up = async function(knex) {
  // ── 1) Limpieza de huérfanos existentes ────────────────────────────────────────────────────
  // Antes de poder crear cada constraint hace falta que ya no haya ninguna fila violándola —
  // production lleva unos días en vivo, así que esto no es solo paranoia de desarrollo. Cada
  // limpieza usa exactamente la semántica (CASCADE=borrar, SET NULL=vaciar) que la constraint
  // de más abajo va a exigir de acá en adelante.
  const nullOrphans = (table, col, refTable) =>
    knex(table).whereNotNull(col).whereNotIn(col, knex(refTable).select('id')).update({ [col]: null });
  const deleteOrphans = (table, col, refTable) =>
    knex(table).whereNotNull(col).whereNotIn(col, knex(refTable).select('id')).delete();

  await nullOrphans('projects', 'created_by', 'users');
  await nullOrphans('projects', 'client_id', 'clients');
  await nullOrphans('tasks', 'assigned_to', 'users');
  await nullOrphans('tasks', 'created_by', 'users');
  await deleteOrphans('tasks', 'project_id', 'projects');
  await deleteOrphans('messages', 'project_id', 'projects');
  await deleteOrphans('messages', 'sender_id', 'users');
  await nullOrphans('messages', 'receiver_id', 'users');
  await deleteOrphans('videos', 'project_id', 'projects');
  await nullOrphans('videos', 'uploaded_by', 'users');
  await nullOrphans('videos', 'approved_by', 'users');
  await nullOrphans('videos', 'task_id', 'tasks');
  await deleteOrphans('video_comments', 'video_id', 'videos');
  await deleteOrphans('video_comments', 'user_id', 'users'); // nullable: comentarios de invitado ya tienen user_id null, no matchean nada
  await deleteOrphans('comment_attachments', 'comment_id', 'video_comments');
  await deleteOrphans('comment_replies', 'comment_id', 'video_comments');
  await deleteOrphans('comment_replies', 'user_id', 'users');
  await deleteOrphans('reply_attachments', 'reply_id', 'comment_replies');
  await deleteOrphans('chat_messages', 'sender_id', 'users');
  await deleteOrphans('chat_messages', 'receiver_id', 'users');
  await deleteOrphans('chat_messages', 'channel_id', 'chat_channels');
  await nullOrphans('chat_messages', 'client_id', 'clients');
  await nullOrphans('chat_channels', 'created_by', 'users');
  await deleteOrphans('chat_channel_members', 'channel_id', 'chat_channels');
  await deleteOrphans('chat_channel_members', 'user_id', 'users');
  await deleteOrphans('chat_reactions', 'message_id', 'chat_messages');
  await deleteOrphans('chat_reactions', 'user_id', 'users');
  await deleteOrphans('project_members', 'project_id', 'projects');
  await deleteOrphans('project_members', 'user_id', 'users');
  await deleteOrphans('video_shares', 'video_id', 'videos');
  await nullOrphans('video_shares', 'created_by', 'users');
  await deleteOrphans('notification_mutes', 'user_id', 'users');
  await deleteOrphans('notification_mutes', 'project_id', 'projects');
  await nullOrphans('calendar_events', 'created_by', 'users');
  await deleteOrphans('notifications', 'user_id', 'users');
  await deleteOrphans('notifications', 'actor_id', 'users');
  await deleteOrphans('notifications', 'project_id', 'projects');
  await deleteOrphans('notifications', 'video_id', 'videos');
  await deleteOrphans('notifications', 'comment_id', 'video_comments');
  await deleteOrphans('notifications', 'chat_message_id', 'chat_messages');

  // ── 2) Relajar NOT NULL donde la FK va a ser SET NULL ──────────────────────────────────────
  // Estas 3 columnas de "quién lo creó" son metadata de auditoría, no algo que deba bloquear ni
  // arrastrar el borrado del usuario — pero hoy son NOT NULL, así que SET NULL necesita primero
  // permitir null.
  await knex.schema.alterTable('chat_channels', t => { t.string('created_by').nullable().alter(); });
  await knex.schema.alterTable('video_shares', t => { t.string('created_by').nullable().alter(); });
  await knex.schema.alterTable('calendar_events', t => { t.string('created_by').nullable().alter(); });

  // ── 3) Las FK en sí ─────────────────────────────────────────────────────────────────────────
  await knex.schema.alterTable('projects', t => {
    t.foreign('created_by').references('users.id').onDelete('SET NULL');
    t.foreign('client_id').references('clients.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('tasks', t => {
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
    t.foreign('assigned_to').references('users.id').onDelete('SET NULL');
    t.foreign('created_by').references('users.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('messages', t => {
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
    t.foreign('sender_id').references('users.id').onDelete('CASCADE');
    t.foreign('receiver_id').references('users.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('videos', t => {
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
    t.foreign('uploaded_by').references('users.id').onDelete('SET NULL');
    t.foreign('approved_by').references('users.id').onDelete('SET NULL');
    t.foreign('task_id').references('tasks.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('video_comments', t => {
    t.foreign('video_id').references('videos.id').onDelete('CASCADE');
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('comment_attachments', t => {
    t.foreign('comment_id').references('video_comments.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('comment_replies', t => {
    t.foreign('comment_id').references('video_comments.id').onDelete('CASCADE');
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('reply_attachments', t => {
    t.foreign('reply_id').references('comment_replies.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('chat_channels', t => {
    t.foreign('created_by').references('users.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('chat_channel_members', t => {
    t.foreign('channel_id').references('chat_channels.id').onDelete('CASCADE');
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('chat_messages', t => {
    t.foreign('sender_id').references('users.id').onDelete('CASCADE');
    t.foreign('receiver_id').references('users.id').onDelete('CASCADE');
    t.foreign('channel_id').references('chat_channels.id').onDelete('CASCADE');
    t.foreign('client_id').references('clients.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('chat_reactions', t => {
    t.foreign('message_id').references('chat_messages.id').onDelete('CASCADE');
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('project_members', t => {
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('video_shares', t => {
    t.foreign('video_id').references('videos.id').onDelete('CASCADE');
    t.foreign('created_by').references('users.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('notification_mutes', t => {
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
  });
  await knex.schema.alterTable('calendar_events', t => {
    t.foreign('created_by').references('users.id').onDelete('SET NULL');
  });
  await knex.schema.alterTable('notifications', t => {
    t.foreign('user_id').references('users.id').onDelete('CASCADE');
    t.foreign('actor_id').references('users.id').onDelete('CASCADE');
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
    t.foreign('video_id').references('videos.id').onDelete('CASCADE');
    t.foreign('comment_id').references('video_comments.id').onDelete('CASCADE');
    t.foreign('chat_message_id').references('chat_messages.id').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  const dropFks = async (table, cols) => {
    await knex.schema.alterTable(table, t => { for (const c of cols) t.dropForeign(c); });
  };
  await dropFks('notifications', ['user_id', 'actor_id', 'project_id', 'video_id', 'comment_id', 'chat_message_id']);
  await dropFks('calendar_events', ['created_by']);
  await dropFks('notification_mutes', ['user_id', 'project_id']);
  await dropFks('video_shares', ['video_id', 'created_by']);
  await dropFks('project_members', ['project_id', 'user_id']);
  await dropFks('chat_reactions', ['message_id', 'user_id']);
  await dropFks('chat_messages', ['sender_id', 'receiver_id', 'channel_id', 'client_id']);
  await dropFks('chat_channel_members', ['channel_id', 'user_id']);
  await dropFks('chat_channels', ['created_by']);
  await dropFks('reply_attachments', ['reply_id']);
  await dropFks('comment_replies', ['comment_id', 'user_id']);
  await dropFks('comment_attachments', ['comment_id']);
  await dropFks('video_comments', ['video_id', 'user_id']);
  await dropFks('videos', ['project_id', 'uploaded_by', 'approved_by', 'task_id']);
  await dropFks('messages', ['project_id', 'sender_id', 'receiver_id']);
  await dropFks('tasks', ['project_id', 'assigned_to', 'created_by']);
  await dropFks('projects', ['created_by', 'client_id']);
};
