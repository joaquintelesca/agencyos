/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    // Soft delete — la fila se queda (quoted_message_id, thread_parent_id, reacciones, pins y
    // guardados de OTROS mensajes la siguen referenciando por id), solo se vacía el contenido y se
    // marca cuándo. El join en vivo de GET /api/chat/messages hace que cualquier mensaje que cite
    // o responda a este automáticamente muestre el contenido vaciado — no hace falta "propagar" el
    // borrado a mano a cada lugar que lo referencia.
    t.timestamp('deleted_at').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    t.dropColumn('deleted_at');
  });
};
