// La migración anterior (20260923075409_add_foreign_keys) le puso a notifications.chat_message_id
// una FK hacia chat_messages (el sistema de DMs/canales) — un supuesto razonable por el nombre,
// pero equivocado: ese sistema nunca crea notificaciones (tiene su propio contador de "Chat" en
// el sidebar, separado a propósito, ver server/routes/chat.js). La columna en realidad apunta a
// `messages` (el chat de proyecto, socket.io `message:send`), que es el único lugar que ahora la
// completa (antes ningún call site la llenaba nunca, quedaba siempre null). Se corrige acá en vez
// de editar la migración vieja — ya corrió en producción, reescribirla sería mentirle al historial.
exports.up = async function(knex) {
  await knex.schema.alterTable('notifications', t => { t.dropForeign('chat_message_id'); });

  // Defensivo por las dudas, aunque la columna siempre estuvo en null hasta este fix.
  await knex('notifications')
    .whereNotNull('chat_message_id')
    .whereNotIn('chat_message_id', knex('messages').select('id'))
    .update({ chat_message_id: null });

  await knex.schema.alterTable('notifications', t => {
    t.foreign('chat_message_id').references('messages.id').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('notifications', t => { t.dropForeign('chat_message_id'); });
  await knex.schema.alterTable('notifications', t => {
    t.foreign('chat_message_id').references('chat_messages.id').onDelete('CASCADE');
  });
};
